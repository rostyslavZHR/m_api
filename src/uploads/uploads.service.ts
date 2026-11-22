// Uploads straight from the client to the store, with presigned URLs (#180, architecture
// B): intent → PUT → commit. The API decides every upload (who, which key, which type,
// how big) and records it; the bytes never pass through it.
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { fileTypeFromBuffer } from 'file-type';
import type { AuthUser } from '../auth/tokens.js';
import type { StorageConfig } from '../config/storage.js';
import type { FileEntity, FileStatus } from '../entities/index.js';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  isNoSuchUpload,
  listAllParts,
  type UploadRef,
} from '../storage/multipart.js';
import { presignGet, presignPart, presignPut } from '../storage/presign.js';
import { S3, STORAGE_CONFIG } from '../storage/storage.module.js';
import { FilesRepository } from './files.repository.js';
import { isMultipart, MAX_FILE_BYTES, MAX_PARTS, partCountFor, partSizeFor } from './upload-sizes.js';

// The allowlist: each type the API accepts, and the extension the key gets for it. The
// extension comes from here, never from the client's filename. The same list is the
// contentType enum in openapi/openapi.yaml.
export const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Sizes: below MULTIPART_THRESHOLD_BYTES (10 MiB) one presigned PUT, at or above it
// multipart, up to MAX_FILE_BYTES (5 GiB); see upload-sizes.ts. The declared size is
// checked at intent, and the object's real size in commit: a presigned PUT can't cap the
// size itself (#180).

// 5 minutes for a single PUT: enough to start a photo upload from a form, short enough
// that a leaked URL (it's a bearer token, #181) is soon useless.
export const PRESIGN_EXPIRES_SECONDS = 300;

// 1 hour for multipart part URLs: a large upload over a slow connection takes longer than
// 5 minutes, and all the URLs are handed out at once. Still bounded: a resume (GET
// /uploads/:id/parts) signs fresh URLs for the parts that are missing.
export const PART_URL_EXPIRES_SECONDS = 3600;

// 60 s for a download (#182): the redirect is followed at once, so the URL only has to
// outlive that; a leaked one is dead almost immediately, and taking a user's access
// away (in our data) stops their next click, not a URL valid for days.
export const DOWNLOAD_EXPIRES_SECONDS = 60;

// What commit reads to recognise the real type (magic bytes). file-type needs at most
// the first 4100 bytes.
const SNIFF_BYTES = 4100;

// The UploadIntentRequest schema in openapi/openapi.yaml.
export interface UploadIntentRequest {
  // Accepted for the client's benefit and ignored: nothing from it reaches the key.
  filename: string;
  contentType: string;
  size: number;
}

export interface PartUrl {
  partNumber: number;
  url: string;
}

// The UploadIntent schema: one of two shapes, told apart by `kind`.
export type UploadIntent =
  | {
      kind: 'single';
      fileId: string;
      key: string;
      uploadUrl: string;
      method: 'PUT';
      // Exactly these headers on the PUT: Content-Type is signed, so another value → 403.
      headers: { 'Content-Type': string };
      expiresAt: string;
    }
  | {
      kind: 'multipart';
      fileId: string;
      key: string;
      method: 'PUT';
      // Part n covers bytes (n-1)*partSize up to n*partSize (the last one is shorter).
      partSize: number;
      partCount: number;
      parts: PartUrl[];
      expiresAt: string;
    };

// The UploadParts schema: GET /uploads/:id/parts, for resuming.
export interface UploadParts {
  fileId: string;
  partSize: number;
  partCount: number;
  // Already in the store: don't send these again.
  uploadedParts: number[];
  // Fresh URLs for the missing ones only.
  parts: PartUrl[];
  expiresAt: string;
}

// The File schema.
export interface FileView {
  id: string;
  key: string;
  status: FileStatus;
  contentType: string;
  size: number;
  createdAt: string;
  completedAt: string | null;
}

const toView = (file: FileEntity): FileView => ({
  id: file.id,
  key: file.key,
  status: file.status,
  contentType: file.contentType,
  size: Number(file.size),
  createdAt: file.createdAt.toISOString(),
  completedAt: file.completedAt?.toISOString() ?? null,
});

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const expiresAt = (now: Date, seconds: number): string => new Date(now.getTime() + seconds * 1000).toISOString();

// SDK v3 reports a missing object on HEAD as an error named NotFound, status 404, no body.
// Only that is "no object"; anything else (the store down, a timeout, a bad signature)
// is not, and must not become a 409.
const isNotFound = (error: unknown): boolean =>
  (error as { name?: string }).name === 'NotFound' &&
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly files: FilesRepository,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
  ) {}

  async intent(user: AuthUser, { contentType, size }: UploadIntentRequest, now = new Date()): Promise<UploadIntent> {
    // The spec rejects these first (enum, maximum); checked again so the service never
    // depends on the validator being mounted.
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) throw new BadRequestException(`Content type ${contentType} is not allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}.`);
    if (!Number.isInteger(size) || size < 1) throw new BadRequestException('Size must be a positive number of bytes.');
    // The part limit, on its own: with the computed part size it always holds, but it's
    // what stops a too-large file if the part size is ever fixed (5 MiB × 10,000 ≈ 48.8 GiB).
    if (isMultipart(size) && partCountFor(size, partSizeFor(size)) > MAX_PARTS) {
      throw new BadRequestException(`A file of ${size} bytes would need more than ${MAX_PARTS} parts.`);
    }
    if (size > MAX_FILE_BYTES) throw new BadRequestException(`Size must be at most ${MAX_FILE_BYTES} bytes.`);

    // The server picks the key: the owner's id and a new uuid, the extension from the
    // allowlist. The client chooses nothing in it, so it can't write anywhere else.
    const id = randomUUID();
    const key = `uploads/${user.id}/${id}.${ext}`;
    if (isMultipart(size)) return this.multipartIntent(user, { id, key, contentType, size }, now);
    await this.files.insert({ id, key, ownerId: user.id, contentType, size });

    // Signed locally, no call to the store (#181), with Content-Type signed (presign.ts).
    const uploadUrl = await presignPut(this.s3, {
      bucket: this.storage.bucket,
      key,
      contentType,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
    // The file id and the key, never the URL: it's a bearer token.
    this.logger.log(`intent: file ${id} key ${key} (${contentType}, ${size} B) for user ${user.id}`);

    return {
      kind: 'single',
      fileId: id,
      key,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: expiresAt(now, PRESIGN_EXPIRES_SECONDS),
    };
  }

  // Multipart (#183), for files of 10 MiB and up: the store opens the upload and keeps its
  // state under an UploadId, stored on the row; every part gets its own presigned URL.
  private async multipartIntent(
    user: AuthUser,
    { id, key, contentType, size }: { id: string; key: string; contentType: string; size: number },
    now: Date,
  ): Promise<UploadIntent> {
    const partSize = partSizeFor(size);
    const partCount = partCountFor(size, partSize);
    let uploadId: string;
    try {
      uploadId = await createMultipartUpload(this.s3, { bucket: this.storage.bucket, key, contentType });
    } catch (error) {
      this.logger.error(`CreateMultipartUpload for key ${key} failed: ${(error as Error).name}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The file store is unavailable, try again shortly.');
    }
    try {
      await this.files.insert({ id, key, ownerId: user.id, contentType, size, uploadId });
    } catch (error) {
      // No row, so nothing would ever clean this upload up but the lifecycle rule.
      await abortMultipartUpload(this.s3, { bucket: this.storage.bucket, key, uploadId }).catch(() => {});
      throw error;
    }
    const parts = await this.signParts({ bucket: this.storage.bucket, key, uploadId }, range(1, partCount));
    this.logger.log(`intent: file ${id} key ${key} multipart (${contentType}, ${size} B, ${partCount} × ${partSize} B) for user ${user.id}`);
    return { kind: 'multipart', fileId: id, key, method: 'PUT', partSize, partCount, parts, expiresAt: expiresAt(now, PART_URL_EXPIRES_SECONDS) };
  }

  // Resume after a crash (#183): the store knows which parts it already has (ListParts), so
  // the client gets fresh URLs for the missing ones only, and sends nothing twice.
  async resumeParts(user: AuthUser, fileId: string, now = new Date()): Promise<UploadParts> {
    const file = await this.files.findById(fileId);
    if (!file) throw new NotFoundException(`File ${fileId} not found.`);
    if (file.ownerId !== user.id) throw new ForbiddenException(`File ${fileId} is not yours.`);
    if (!file.uploadId) throw new ConflictException(`File ${fileId} is a single PUT upload, not multipart.`);
    if (file.status !== 'PENDING') throw new ConflictException(`File ${fileId} is already ${file.status}.`);

    const ref = { bucket: this.storage.bucket, key: file.key, uploadId: file.uploadId };
    const stored = await this.storeCall(file, () => listAllParts(this.s3, ref), 'ListParts').catch((error: unknown) => {
      if (isNoSuchUpload(error)) throw new ConflictException(`The upload of file ${fileId} no longer exists in the store: start a new upload.`);
      throw error;
    });
    const partSize = partSizeFor(Number(file.size));
    const partCount = partCountFor(Number(file.size), partSize);
    const uploaded = new Set(stored.map(({ partNumber }) => partNumber));
    const missing = range(1, partCount).filter((n) => !uploaded.has(n));
    this.logger.log(`resume: file ${file.id} has parts [${[...uploaded].sort((a, b) => a - b).join(',')}] of ${partCount}, ${missing.length} missing`);
    return {
      fileId: file.id,
      partSize,
      partCount,
      uploadedParts: [...uploaded].sort((a, b) => a - b),
      parts: await this.signParts(ref, missing),
      expiresAt: expiresAt(now, PART_URL_EXPIRES_SECONDS),
    };
  }

  // COMPLETED only when the bytes are really in the store, with the declared size and a
  // real image of the declared type. Otherwise the row stays PENDING. A multipart upload
  // is completed in the store first; then the same checks apply to the whole object.
  async commit(user: AuthUser, fileId: string, now = new Date()): Promise<FileView> {
    const file = await this.files.findById(fileId);
    if (!file) throw new NotFoundException(`File ${fileId} not found.`);
    // fileId comes from the client: only the owner may commit it (the HW#24 pattern).
    if (file.ownerId !== user.id) throw new ForbiddenException(`File ${fileId} is not yours.`);
    // Idempotent: a retried commit gets the same answer, without asking the store again.
    if (file.status === 'COMPLETED') return toView(file);

    if (file.uploadId) await this.completeMultipart(file);

    const object = { Bucket: this.storage.bucket, Key: file.key };
    const head = await this.storeCall(file, () => this.s3.send(new HeadObjectCommand(object)), 'HeadObject').catch((error: unknown) => {
      if (isNotFound(error)) {
        throw new ConflictException(`File ${fileId} has no uploaded object yet: PUT it to the upload URL first.`);
      }
      throw error;
    });

    const declared = Number(file.size);
    if (head.ContentLength !== declared) {
      await this.discard(file, `size ${head.ContentLength} B, declared ${declared} B`);
      throw new UnprocessableEntityException(
        `The uploaded object is ${head.ContentLength} bytes, but ${declared} were declared. It was removed: upload the declared file again.`,
      );
    }

    // Content-Type is only the client's word: read the first bytes and check they really
    // are that kind of image (magic bytes).
    const start = await this.storeCall(
      file,
      () => this.s3.send(new GetObjectCommand({ ...object, Range: `bytes=0-${SNIFF_BYTES - 1}` })),
      'GetObject',
    );
    const detected = (await fileTypeFromBuffer(await start.Body!.transformToByteArray()))?.mime;
    if (detected !== file.contentType) {
      await this.discard(file, `content is ${detected ?? 'unknown'}, declared ${file.contentType}`);
      throw new UnprocessableEntityException(
        `The uploaded object is not ${file.contentType} (detected: ${detected ?? 'unknown'}). It was removed.`,
      );
    }

    if (!(await this.files.markCompleted({ id: file.id, size: head.ContentLength, completedAt: now }))) {
      // Not PENDING any more: a parallel commit completed it (answer with that), or the
      // abandoned-upload cleanup removed the row in between (it then deletes the object).
      const current = await this.files.findById(fileId);
      if (!current) throw new NotFoundException(`File ${fileId} was removed as an abandoned upload.`);
      return toView(current);
    }
    this.logger.log(`commit: file ${file.id} key ${file.key} completed (${head.ContentLength} B)`);
    return toView((await this.files.findById(fileId))!);
  }

  // GET /files/:id (#182): authorize this request, then hand out a fresh 60-second URL for
  // the bytes. Revoking access is a change in our data; the next request gets 403. The
  // owner and admins may read a file; only a COMPLETED one exists for reading.
  async downloadUrl(user: AuthUser, fileId: string): Promise<string> {
    const file = await this.files.findById(fileId);
    if (!file) throw new NotFoundException(`File ${fileId} not found.`);
    if (file.ownerId !== user.id && user.role !== 'admin') throw new ForbiddenException(`File ${fileId} is not yours.`);
    if (file.status !== 'COMPLETED') throw new ConflictException(`File ${fileId} isn't uploaded yet (${file.status}).`);

    const url = await presignGet(this.s3, { bucket: this.storage.bucket, key: file.key, expiresIn: DOWNLOAD_EXPIRES_SECONDS });
    // Who read what: the file id and the key, never the URL.
    this.logger.log(`download: file ${file.id} key ${file.key} by user ${user.id}`);
    return url;
  }

  // The part list from the store's own ListParts, never ETags sent by the client: every
  // part must be there. Complete makes the object appear, whole and at once; before it,
  // HeadObject says NotFound.
  private async completeMultipart(file: FileEntity): Promise<void> {
    const ref = { bucket: this.storage.bucket, key: file.key, uploadId: file.uploadId! };
    let stored;
    try {
      stored = await this.storeCall(file, () => listAllParts(this.s3, ref), 'ListParts');
    } catch (error) {
      // No such upload: a previous commit completed it and failed before saving the row,
      // or it was aborted. The HeadObject that follows tells which (the object, or a 409).
      if (isNoSuchUpload(error)) return;
      throw error;
    }
    const partCount = partCountFor(Number(file.size), partSizeFor(Number(file.size)));
    const have = new Set(stored.map(({ partNumber }) => partNumber));
    const missing = range(1, partCount).filter((n) => !have.has(n));
    if (missing.length > 0) {
      throw new ConflictException(`File ${file.id} is missing parts ${missing.join(', ')} of ${partCount}: upload them (GET /uploads/${file.id}/parts), then commit again.`);
    }
    try {
      const etag = await completeMultipartUpload(this.s3, ref, stored);
      this.logger.log(`commit: file ${file.id} multipart completed in the store (${partCount} parts, ETag ${etag})`);
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === undefined || status >= 500) throw this.storeUnavailable(file, 'CompleteMultipartUpload', error);
      // The store refused the parts (AWS: EntityTooSmall for a part under 5 MiB that isn't
      // the last, InvalidPart). They can't be fixed in place: abort, and the file stays
      // PENDING until the cleanup removes the row.
      await abortMultipartUpload(this.s3, ref).catch(() => {});
      this.logger.warn(`commit: file ${file.id} rejected by the store on Complete (${(error as Error).name}), upload aborted`);
      throw new UnprocessableEntityException(`The store refused to assemble the parts: ${(error as Error).name}. The upload was aborted: start a new one.`);
    }
  }

  private signParts(ref: UploadRef, partNumbers: number[]): Promise<PartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await presignPart(this.s3, { ...ref, partNumber, expiresIn: PART_URL_EXPIRES_SECONDS }),
      })),
    );
  }

  private storeUnavailable(file: FileEntity, name: string, error: unknown): ServiceUnavailableException {
    this.logger.error(`${name} for file ${file.id} key ${file.key} failed: ${(error as Error).name}: ${(error as Error).message}`);
    return new ServiceUnavailableException('The file store is unavailable, try again shortly.');
  }

  // A store call whose failure isn't "no object" or "no upload": logged, then a 503 (the
  // store, not the client, is at fault). NotFound and NoSuchUpload pass through for the
  // caller to map.
  private async storeCall<T>(file: FileEntity, call: () => Promise<T>, name: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isNotFound(error) || isNoSuchUpload(error)) throw error;
      throw this.storeUnavailable(file, name, error);
    }
  }

  // An object that failed a check is deleted, so it can't be served or counted, and the
  // client can PUT the right file again while its URL is still valid. The row stays
  // PENDING. Best effort: a failed delete is logged, and the object stays until a cleanup
  // removes it.
  private async discard(file: FileEntity, reason: string): Promise<void> {
    this.logger.warn(`commit: file ${file.id} key ${file.key} rejected (${reason}), object removed`);
    await this.s3
      .send(new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: file.key }))
      .catch((error: Error) => this.logger.error(`delete of ${file.key} failed: ${error.message}`));
  }
}
