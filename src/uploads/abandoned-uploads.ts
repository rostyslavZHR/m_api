// The cleanup of abandoned uploads: intent recorded a PENDING row (and maybe the client
// PUT an object), but commit never came. A lifecycle rule can't do this: it acts on
// objects in the store, never on rows, and by prefix and age it can't tell a pending
// object from a committed one under uploads/. So it's ours, row and object together.
//
// Run by the daily cleanup job (src/jobs), or by hand. Two steps, so a commit can land
// between them, and the second step is the safe one:
//   1. find: PENDING rows older than the threshold;
//   2. remove: per row, DELETE … WHERE status = 'PENDING' first; only if that deleted the
//      row is the object deleted. A row a commit completed in between survives, and so
//      does its object.
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AbandonedFile, FilesRepository } from './files.repository.js';

// An upload URL lives 5 minutes; a day is far past any upload still in progress.
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
// Rows per run: a backlog is cleared over several runs, never in one huge pass.
const BATCH = 500;

export interface CleanupDeps {
  files: FilesRepository;
  s3: S3Client;
  bucket: string;
  log: (message: string) => void;
}

export interface CleanupResult {
  // Rows (and their objects) removed.
  removed: number;
  // Rows a commit completed after they were read: kept.
  completedMeanwhile: number;
  // Rows removed whose object couldn't be deleted (logged; the object is left behind).
  objectErrors: number;
}

export const findAbandoned = (files: FilesRepository, now = new Date()): Promise<AbandonedFile[]> =>
  files.findPendingOlderThan(new Date(now.getTime() - ABANDONED_AFTER_MS), BATCH);

export async function removeAbandoned({ files, s3, bucket, log }: CleanupDeps, abandoned: AbandonedFile[]): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, completedMeanwhile: 0, objectErrors: 0 };
  for (const file of abandoned) {
    if (!(await files.deleteIfPending(file.id))) {
      result.completedMeanwhile++;
      log(`abandoned uploads: file ${file.id} was completed meanwhile, kept`);
      continue;
    }
    // The row is gone, so nothing can commit it now. DeleteObject on a key with no object
    // still succeeds (204), so "never uploaded" needs no special case. Multipart rows
    // (upload_id) will need AbortMultipartUpload first (Phase D).
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.key }));
      result.removed++;
    } catch (error) {
      result.objectErrors++;
      log(`abandoned uploads: file ${file.id} removed, but its object ${file.key} wasn't: ${(error as Error).message}`);
    }
  }
  return result;
}

export async function cleanupAbandonedUploads(deps: CleanupDeps, now = new Date()): Promise<CleanupResult> {
  return removeAbandoned(deps, await findAbandoned(deps.files, now));
}
