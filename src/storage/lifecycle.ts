// The bucket's lifecycle rule (#184): the store itself aborts multipart uploads nobody
// completed, 7 days after they started. Trap 1 of #184: an Expiration rule doesn't remove
// unfinished uploads; only this action does. It's the backstop under our own cleanup (the
// daily job), for uploads that have no row to find them by.
//
// Applied idempotently (Put replaces the whole configuration with the same one) by the
// API at startup: the dev store keeps its data on a tmpfs, so a restart of the store
// forgets the bucket's configuration along with everything else. That's a workaround for
// this dev store only: on real S3 the rule is set once, as infrastructure (Terraform,
// CloudFormation, a setup script), and stays; the app shouldn't own it there.
import { GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, type S3Client } from '@aws-sdk/client-s3';

export const ABORT_INCOMPLETE_RULE_ID = 'abort-incomplete-multipart';
export const ABORT_INCOMPLETE_AFTER_DAYS = 7;

export async function applyLifecycle(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: ABORT_INCOMPLETE_RULE_ID,
            Status: 'Enabled',
            // The whole bucket: any upload left unfinished, whatever its key.
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_AFTER_DAYS },
          },
        ],
      },
    }),
  );
}

// The rule as the store reports it, or undefined if it isn't set.
export async function readAbortRule(s3: S3Client, bucket: string): Promise<{ status?: string; days?: number } | undefined> {
  const { Rules } = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  const rule = Rules?.find((r) => r.ID === ABORT_INCOMPLETE_RULE_ID && r.AbortIncompleteMultipartUpload);
  return rule && { status: rule.Status, days: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation };
}
