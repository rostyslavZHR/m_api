// The store's side of a multipart upload (#183): the calls, nothing about who may make
// them. Like a repository for SQL, the service decides; these only talk to the store.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

export interface UploadRef {
  bucket: string;
  key: string;
  uploadId: string;
}

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

// The UploadId is the upload's handle in the store: it survives our process dying, so a
// crashed client can come back and find its parts.
export async function createMultipartUpload(s3: S3Client, { bucket, key, contentType }: { bucket: string; key: string; contentType: string }): Promise<string> {
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  if (!UploadId) throw new Error(`CreateMultipartUpload for ${key} returned no UploadId`);
  return UploadId;
}

// Every part the store has, following the pagination: ListParts returns at most 1,000 per
// page, so a single call would silently lose parts on a big file.
export async function listAllParts(s3: S3Client, { bucket, key, uploadId }: UploadRef): Promise<StoredPart[]> {
  const parts: StoredPart[] = [];
  let marker: string | undefined;
  for (;;) {
    const page = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const part of page.Parts ?? []) {
      parts.push({ partNumber: part.PartNumber!, etag: part.ETag!, size: part.Size ?? 0 });
    }
    if (!page.IsTruncated) return parts;
    marker = page.NextPartNumberMarker;
  }
}

// The part list comes from listAllParts, never from the client: the store's own ETags.
export async function completeMultipartUpload(s3: S3Client, ref: UploadRef, parts: StoredPart[]): Promise<string | undefined> {
  const { ETag } = await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: ref.bucket,
      Key: ref.key,
      UploadId: ref.uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })) },
    }),
  );
  return ETag;
}

export async function abortMultipartUpload(s3: S3Client, { bucket, key, uploadId }: UploadRef): Promise<void> {
  await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

// An upload the store no longer knows: completed, aborted, or expired by the lifecycle rule.
export const isNoSuchUpload = (error: unknown): boolean => (error as { name?: string }).name === 'NoSuchUpload';
