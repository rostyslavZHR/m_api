// A child of demo:upload: one PUT with a presigned URL, from a process that has no
// credentials of any kind. Its whole environment is what the parent passes:
//   PUT_URL, PUT_CONTENT_TYPE, PUT_FILE (nothing else: no S3_*, no AWS_*, no PATH, no HOME)
// To stderr: the variable names it has and how many look like credentials (0).
// To stdout: status=<the store's answer>.
import { readFileSync } from 'node:fs';

const names = Object.keys(process.env).sort();
const credentials = names.filter((name) => /^(S3_|AWS_)/.test(name));
console.error(`[put-offline] env: ${names.join(', ')}; S3_*/AWS_* variables: ${credentials.length}`);

const response = await fetch(process.env.PUT_URL!, {
  method: 'PUT',
  headers: { 'Content-Type': process.env.PUT_CONTENT_TYPE! },
  body: readFileSync(process.env.PUT_FILE!),
});
await response.arrayBuffer();
console.log(`status=${response.status}`);
