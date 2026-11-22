// The only place that creates S3 clients (HW#26). A plain function, so scripts and
// demos use it too; StorageModule wraps it for Nest.
import { S3Client } from '@aws-sdk/client-s3';
import type { StorageConfig } from '../config/storage.js';

export function createS3Client({ endpoint, region, accessKeyId, secretAccessKey }: StorageConfig): S3Client {
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    // An emulator: requests go to the given URL instead of AWS's regional endpoint.
    // Unset means real AWS.
    ...(endpoint && {
      endpoint,
      // http://host/bucket/key, not http://bucket.host/key: the virtual-hosted form needs
      // a DNS name per bucket, which a local store doesn't have. With an IP endpoint
      // (127.0.0.1) the SDK falls back to path style by itself, which hides a missing
      // flag until the endpoint is a hostname (http://garage:3900 → ENOTFOUND
      // hw26-files.garage).
      forcePathStyle: true,
    }),
    // Checksums only where S3 requires them (#181). The SDK's default adds a checksum to
    // uploads; a presigned URL is signed before the body exists, so it would sign the
    // checksum of an empty body, and the URL would then only accept an empty file.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
