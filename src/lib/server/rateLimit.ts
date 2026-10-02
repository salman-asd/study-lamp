interface RateLimitOptions {
  scope?: string;
  limit?: number;
  windowMs?: number;
  now?: number;
}

const requestsByKey = new Map<string, number[]>();

/** Per-process sliding-window limiter. Distributed deployments need a shared store. */
export function checkRateLimit(uid: string, options: RateLimitOptions = {}): boolean {
  const scope = options.scope || "default";
  const limit = options.limit ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now();
  const key = `${scope}:${uid}`;
  const cutoff = now - windowMs;
  const timestamps = (requestsByKey.get(key) || []).filter((timestamp) => timestamp > cutoff);

  if (timestamps.length >= limit) {
    requestsByKey.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  requestsByKey.set(key, timestamps);

  if (requestsByKey.size > 10_000) {
    for (const [storedKey, storedTimestamps] of requestsByKey) {
      const active = storedTimestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length) requestsByKey.set(storedKey, active);
      else requestsByKey.delete(storedKey);
    }
  }
  return true;
}