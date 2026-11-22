// A child of demo:multipart: uploads parts with their presigned URLs, in order, and after
// STOP_AFTER parts says so and waits, so the parent can SIGKILL it at exactly that point
// (a crash: no cleanup of its own runs). Its whole environment is what the parent passes:
//   PARTS_FILE  JSON { partSize, parts: [{ partNumber, url }] } (the intent's answer)
//   DATA_FILE   the file being uploaded
//   STOP_AFTER  how many parts to send before pausing
// To stdout: "part <n> done" after each part, then "paused".
import { readFileSync } from 'node:fs';

interface Parts {
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

const { partSize, parts } = JSON.parse(readFileSync(process.env.PARTS_FILE!, 'utf8')) as Parts;
const data = readFileSync(process.env.DATA_FILE!);
const stopAfter = Number(process.env.STOP_AFTER);

for (const { partNumber, url } of parts.slice(0, stopAfter)) {
  const body = data.subarray((partNumber - 1) * partSize, partNumber * partSize);
  const response = await fetch(url, { method: 'PUT', body });
  await response.arrayBuffer();
  if (response.status !== 200) {
    console.error(`[multipart-upload] part ${partNumber}: ${response.status}`);
    process.exit(1);
  }
  console.log(`part ${partNumber} done`);
}
console.log('paused');
// Wait for the parent's SIGKILL.
setInterval(() => {}, 60_000);
