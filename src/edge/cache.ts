// The edge's cache: in memory, bounded by bytes, least recently used first out. How long
// a copy stays fresh comes only from the object's own Cache-Control, set when it was
// uploaded (#186). The edge has no TTL of its own: an object without Cache-Control isn't
// cached at all, which is what a real CDN would do with it too, so the bug shows up here
// and not first in production.

export interface CachedObject {
  body: Buffer;
  contentType: string;
  cacheControl: string;
  etag?: string;
  // When the copy was stored or last revalidated, and how long it's fresh from then.
  storedAt: number;
  maxAgeMs: number;
}

// What a Cache-Control value allows a shared cache to do.
export interface Freshness {
  cacheable: boolean;
  maxAgeMs: number;
}

// no-store and private: never in a shared cache. s-maxage (for shared caches) wins over
// max-age. no-cache: may be stored, but must be revalidated before every use (fresh for 0).
// Nothing usable (no header, no max-age): not cached.
export function freshnessOf(cacheControl: string | undefined): Freshness {
  if (!cacheControl) return { cacheable: false, maxAgeMs: 0 };
  const directives = new Map<string, string | undefined>(
    cacheControl
      .toLowerCase()
      .split(',')
      .map((part): [string, string | undefined] => {
        const [name, value] = part.trim().split('=');
        return [name, value];
      }),
  );
  if (directives.has('no-store') || directives.has('private')) return { cacheable: false, maxAgeMs: 0 };
  if (directives.has('no-cache')) return { cacheable: true, maxAgeMs: 0 };
  const seconds = Number(directives.get('s-maxage') ?? directives.get('max-age'));
  if (!Number.isFinite(seconds) || seconds <= 0) return { cacheable: false, maxAgeMs: 0 };
  return { cacheable: true, maxAgeMs: seconds * 1000 };
}

export const isFresh = (entry: CachedObject, now = Date.now()): boolean => now - entry.storedAt < entry.maxAgeMs;

export class EdgeCache {
  // A Map keeps insertion order: re-inserting on use makes the first key the least recent.
  private readonly entries = new Map<string, CachedObject>();
  private bytes = 0;

  constructor(
    // The whole cache.
    private readonly maxBytes: number,
    // One object: anything bigger is served but not kept, so one large asset can't push
    // everything else out (or exhaust memory).
    readonly maxObjectBytes: number,
  ) {}

  get(key: string): CachedObject | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CachedObject): void {
    if (entry.body.length > this.maxObjectBytes) return;
    this.delete(key);
    this.entries.set(key, entry);
    this.bytes += entry.body.length;
    for (const [oldest, old] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= old.body.length;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.body.length;
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }
}
