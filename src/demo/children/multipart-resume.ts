// A child of demo:multipart: a new process after the crash. It asks the API which parts the
// store already has (GET /uploads/:id/parts, built on ListParts), uploads only the missing
// ones with the fresh URLs it gets, and counts what it actually sent. Its whole environment
// is what the parent passes:
//   API_URL, TOKEN (the fixture user's access token), FILE_ID, DATA_FILE
// To stdout: "sent=<n>" (the parts it uploaded), then it exits.
import { readFileSync } from 'node:fs';

interface UploadParts {
  partSize: number;
  uploadedParts: number[];
  parts: { partNumber: number; url: string }[];
}

const response = await fetch(`${process.env.API_URL}/uploads/${process.env.FILE_ID}/parts`, {
  headers: { Authorization: `Bearer ${process.env.TOKEN}` },
});
if (response.status !== 200) {
  console.error(`[multipart-resume] GET /uploads/:id/parts: ${response.status}`);
  process.exit(1);
}
const { partSize, uploadedParts, parts } = (await response.json()) as UploadParts;
console.error(`[multipart-resume] the store has parts [${uploadedParts.join(', ')}]; missing [${parts.map((p) => p.partNumber).join(', ')}]`);

const data = readFileSync(process.env.DATA_FILE!);
let sent = 0;
for (const { partNumber, url } of parts) {
  const put = await fetch(url, { method: 'PUT', body: data.subarray((partNumber - 1) * partSize, partNumber * partSize) });
  await put.arrayBuffer();
  if (put.status !== 200) {
    console.error(`[multipart-resume] part ${partNumber}: ${put.status}`);
    process.exit(1);
  }
  sent++;
}
console.log(`sent=${sent}`);
