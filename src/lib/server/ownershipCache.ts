/**
 * Small per-instance TTL cache for POSITIVE "this uid owns this Drive file"
 * answers. Only positives are cached: a cached "no" would wrongly reject a file
 * that was imported a moment later. A cached "yes" can outlive a deleted video
 * by at most `ttlMs`, which only delays when a signed URL stops being minted.
 */
export class OwnershipCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 5_000,
  ) {}

  static key(uid: string, connectionId: string, fileId: string): string {
    return `${uid}:${connectionId}:${fileId}`;
  }

  has(key: string, now: number = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, now + this.ttlMs);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** Groups items by a key, preserving first-seen key order and item order. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
