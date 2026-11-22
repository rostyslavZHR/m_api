// How a file of a given size is uploaded: one presigned PUT, or multipart (#183), and for
// multipart, how big each part is. Computed from the size, never a fixed part size.

const MiB = 1024 * 1024;

// Below this, one PUT; at or above it, multipart. 10 MiB: a typical photo (a few MiB)
// stays a single request, and anything that takes long enough to be worth resuming is
// split. It's also 2 parts of the 5 MiB minimum, so every multipart file has at least
// two real parts (10 MiB → 5 + 5).
export const MULTIPART_THRESHOLD_BYTES = 10 * MiB;

// The store's limits (AWS's): every part except the last at least 5 MiB, at most 10,000
// parts per upload.
export const MIN_PART_BYTES = 5 * MiB;
export const MAX_PARTS = 10_000;

// The largest file this route accepts: 5 GiB, far above any image, and the same as one
// S3 PUT's own maximum. With the computed part size it's 1,024 parts of 5 MiB.
export const MAX_FILE_BYTES = 5 * 1024 * MiB;

// max(5 MiB, ceil(size / 10,000)), rounded up to a whole MiB: the smallest part size that
// keeps the count within 10,000. 11 MiB → 5 MiB parts → 5 + 5 + 1 = 3 parts.
export const partSizeFor = (size: number): number =>
  Math.ceil(Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS)) / MiB) * MiB;

export const partCountFor = (size: number, partSize: number): number => Math.ceil(size / partSize);

export const isMultipart = (size: number): boolean => size >= MULTIPART_THRESHOLD_BYTES;
