// Presigned URLs (#181): signed locally with the client's key, checked by the store on
// use. The expiry is always the caller's: the API passes its product values (300 s for an
// upload, 60 s for a download), the proofs pass 2 s, and no constant is lowered to make
// a test fast.
import { GetObjectCommand, PutObjectCommand, type S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignPut {
  bucket: string;
  key: string;
  contentType: string;
  expiresIn: number;
}

export interface PresignGet {
  bucket: string;
  key: string;
  expiresIn: number;
}

// The presigner signs only `host` unless told otherwise, even with ContentType on the
// command (measured in Phase B: a PUT as image/jpeg was accepted on an image/png URL).
// Naming content-type in signableHeaders makes the PUT carry exactly that header or get 403.
export const presignPut = (s3: S3Client, { bucket, key, contentType, expiresIn }: PresignPut): Promise<string> =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), {
    expiresIn,
    signableHeaders: new Set(['content-type']),
  });

export const presignGet = (s3: S3Client, { bucket, key, expiresIn }: PresignGet): Promise<string> =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });

export interface PresignPart {
  bucket: string;
  key: string;
  uploadId: string;
  partNumber: number;
  expiresIn: number;
}

// One part of a multipart upload (#183). uploadId and partNumber are query parameters of
// the URL, so the signature covers them: a URL for part 2 can't upload part 3, or into
// another upload. No Content-Type: it was fixed at CreateMultipartUpload.
export const presignPart = (s3: S3Client, { bucket, key, uploadId, partNumber, expiresIn }: PresignPart): Promise<string> =>
  getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
