/**
 * Pure helpers for the Drive thumbnails card (Settings -> Google). Safe for client and server.
 */

/** "Retry failed" resets at most this many items per call. */
export const RETRY_FAILED_BATCH = 50;

export interface ThumbnailStatus {
  /** Drive items that were never attempted (a fetch will try them). */
  missing: number;
  /** Items whose last attempt stored no image. */
  failed: number;
  /** Items still carrying the old base64 thumbnail inside the document (a fetch migrates them). */
  legacy: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeThumbnailStatus(raw: unknown): ThumbnailStatus {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { missing: count(data.missing), failed: count(data.failed), legacy: count(data.legacy) };
}

/** The counts line under the buttons, e.g. "Missing: 3 · Failed: 1". */
export function thumbnailStatusText(status: ThumbnailStatus): string {
  const parts = [`Missing: ${status.missing}`, `Failed: ${status.failed}`];
  if (status.legacy > 0) parts.push(`To migrate: ${status.legacy}`);
  return parts.join(" · ");
}

/** True when "Fetch missing thumbnails" has something to do. */
export function hasThumbnailsToFetch(status: ThumbnailStatus): boolean {
  return status.missing + status.legacy > 0;
}

/**
 * Loop guard for "call again while remaining > 0". A round that processed nothing must stop the
 * loop even if the server still reports work, so the client can never spin.
 */
export function shouldContinueThumbnailLoop(round: { processed: number; remaining: number }): boolean {
  return round.remaining > 0 && round.processed > 0;
}

/** Never act on more than `max` targets in one call. */
export function limitRetryTargets<T>(targets: readonly T[], max: number = RETRY_FAILED_BATCH): T[] {
  return targets.slice(0, Math.max(0, max));
}
