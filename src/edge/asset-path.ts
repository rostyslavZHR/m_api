// Which object a request may reach through the edge: only keys under assets/, after the
// path is decoded and normalized, so /assets/../uploads/119/x.png can't escape the prefix.
// On Garage this function is the only thing keeping the edge out of uploads/: the edge's
// key is read-only, but Garage grants per bucket, so it can read every prefix. (On AWS the
// OAC bucket policy's Resource, hw26-files/assets/*, enforces the prefix in the store too.)
// The query string is dropped: it's never part of the key or the cache key, so ?v=1, ?v=2
// can't turn one asset into endless misses against the store.
import { posix } from 'node:path';

export const ASSETS_PREFIX = 'assets/';

// The object key for a request URL, or null (→ 404) for anything outside assets/.
export function assetKeyOf(rawUrl: string): string | null {
  const pathname = rawUrl.split('?')[0].split('#')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  // A backslash or a NUL has no business in an asset name, and some stores or proxies
  // treat a backslash as a separator.
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  // Normalize first ("/assets/../uploads/x" → "/uploads/x"), then require the prefix.
  const key = posix.normalize(decoded).replace(/^\/+/, '');
  if (!key.startsWith(ASSETS_PREFIX) || key.length === ASSETS_PREFIX.length || key.endsWith('/')) return null;
  return key;
}
