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
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import type { AuthUser } from '../auth/tokens.js';
import type { StorageConfig } from '../config/storage.js';
import type { FileEntity, FileStatus } from '../entities/index.js';
import { S3, STORAGE_CONFIG } from '../storage/storage.module.js';
import { FilesRepository } from './files.repository.js';

// The allowlist: each type the API accepts, and the extension the key gets for it. The
// extension comes from here, never from the client's filename. The same list is the
// contentType enum in openapi/openapi.yaml.
export const ALLOWED_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// 10 MiB: a product photo or an avatar. Checked at intent (the declared size) and in
// commit (the object's real size): a presigned PUT can't cap the size itself (#180).
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// 5 minutes: enough to start a photo upload from a form, short enough that a leaked URL
// (it's a bearer token, #181) is soon useless. A larger file would need longer, or
// multipart (Phase D).
export const PRESIGN_EXPIRES_SECONDS = 300;

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

// The UploadIntent schema.
export interface UploadIntent {
  fileId: string;
  key: string;
  uploadUrl: string;
  method: 'PUT';
  // Exactly these headers on the PUT: Content-Type is signed, so another value → 403.
  headers: { 'Content-Type': string };
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
    if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`Size must be 1 to ${MAX_UPLOAD_BYTES} bytes.`);
    }

    // The server picks the key: the owner's id and a new uuid, the extension from the
    // allowlist. The client chooses nothing in it, so it can't write anywhere else.
    const id = randomUUID();
    const key = `uploads/${user.id}/${id}.${ext}`;
    await this.files.insert({ id, key, ownerId: user.id, contentType, size });

    // Signed locally, no call to the store (#181). ContentType on the command alone isn't
    // enough: the presigner signs only `host` unless told otherwise (measured: the URL
    // then accepted a PUT as image/jpeg), so content-type is named in signableHeaders.
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.storage.bucket, Key: key, ContentType: contentType }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS, signableHeaders: new Set(['content-type']) },
    );
    // The file id and the key, never the URL: it's a bearer token.
    this.logger.log(`intent: file ${id} key ${key} (${contentType}, ${size} B) for user ${user.id}`);

    return {
      fileId: id,
      key,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(now.getTime() + PRESIGN_EXPIRES_SECONDS * 1000).toISOString(),
    };
  }

  // COMPLETED only when the bytes are really in the store, with the declared size and a
  // real image of the declared type. Otherwise the row stays PENDING.
  async commit(user: AuthUser, fileId: string, now = new Date()): Promise<FileView> {
    const file = await this.files.findById(fileId);
    if (!file) throw new NotFoundException(`File ${fileId} not found.`);
    // fileId comes from the client: only the owner may commit it (the HW#24 pattern).
    if (file.ownerId !== user.id) throw new ForbiddenException(`File ${fileId} is not yours.`);
    // Idempotent: a retried commit gets the same answer, without asking the store again.
    if (file.status === 'COMPLETED') return toView(file);

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
      // A parallel commit of the same file won; answer with what it stored.
      return toView((await this.files.findById(fileId))!);
    }
    this.logger.log(`commit: file ${file.id} key ${file.key} completed (${head.ContentLength} B)`);
    return toView((await this.files.findById(fileId))!);
  }

  // A store call whose failure isn't "no object": logged, then a 503 (the store, not the
  // client, is at fault). NotFound passes through for the caller to map.
  private async storeCall<T>(file: FileEntity, call: () => Promise<T>, name: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isNotFound(error)) throw error;
      this.logger.error(`${name} for file ${file.id} key ${file.key} failed: ${(error as Error).name}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The file store is unavailable, try again shortly.');
    }
  }

  // An object that failed a check is deleted, so it can't be served or counted, and the
  // client can PUT the right file again while its URL is still valid. The row stays
  // PENDING. Best effort: a failed delete is logged; a lifecycle rule (Phase D) expires
  // what's left under uploads/.
  private async discard(file: FileEntity, reason: string): Promise<void> {
    this.logger.warn(`commit: file ${file.id} key ${file.key} rejected (${reason}), object removed`);
    await this.s3
      .send(new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: file.key }))
      .catch((error: Error) => this.logger.error(`delete of ${file.key} failed: ${error.message}`));
  }
}
