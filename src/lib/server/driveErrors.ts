import { DRIVE_ERROR_MESSAGES } from "@/lib/driveErrors";

/**
 * Pure (no Firestore, no Next) mapping of Drive failures to route responses, so every Drive route
 * answers the same way and the rules are unit-tested with plain objects.
 *
 * Errors are recognised by `name`, not `instanceof`, so this file imports nothing heavy.
 * `DriveApiError` (googleDrive.ts) and `DriveConnectionError` (driveConnections.ts) both set it.
 */

export const RECONNECT_ROUTE_MESSAGE = "Google rejected the saved permission. Reconnect Google in Settings -> Google.";

export interface DriveRouteErrorResponse {
  status: number;
  body: { error: string; code?: "reconnect" };
}

interface NamedError {
  name: string;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

function asNamedError(err: unknown, name: string): NamedError | null {
  return err instanceof Error && err.name === name ? (err as unknown as NamedError) : null;
}

function driveApiStatus(err: unknown): number | null {
  const api = asNamedError(err, "DriveApiError");
  return api && typeof api.status === "number" ? api.status : null;
}

/**
 * Maps a failure from a Drive call to { status, body }.
 *  - connection missing -> 404; connection needs reconnecting -> 409 + code "reconnect"; network -> 503
 *  - Google 401 (it already survived the retry with a fresh token) -> 409 + code "reconnect"
 *  - Google 403 -> 403 with the fixed permission wording
 *  - anything else -> 502 with `fallbackMessage` (never the raw error text, which may contain Google details)
 */
export function mapDriveRouteError(err: unknown, fallbackMessage: string): DriveRouteErrorResponse {
  const connection = asNamedError(err, "DriveConnectionError");
  if (connection) {
    const message = typeof connection.message === "string" && connection.message ? connection.message : fallbackMessage;
    if (connection.code === "not_found") return { status: 404, body: { error: message } };
    if (connection.code === "invalid") return { status: 409, body: { error: message, code: "reconnect" } };
    if (connection.code === "network") return { status: 503, body: { error: message } };
    return { status: 502, body: { error: fallbackMessage } };
  }

  const status = driveApiStatus(err);
  if (status === 401) return { status: 409, body: { error: RECONNECT_ROUTE_MESSAGE, code: "reconnect" } };
  if (status === 403) return { status: 403, body: { error: DRIVE_ERROR_MESSAGES.permission } };
  return { status: 502, body: { error: fallbackMessage } };
}

/** True only for a Google 401 that survived the retry: the saved permission is no longer valid. */
export function shouldMarkConnectionRejected(err: unknown): boolean {
  return driveApiStatus(err) === 401;
}

/** Remembers when each key was last written so a flood of failing requests causes at most one write per interval. */
export const REJECTION_WRITE_INTERVAL_MS = 60 * 60_000;

export class RejectionThrottle {
  private readonly lastWrite = new Map<string, number>();
  constructor(private readonly intervalMs: number = REJECTION_WRITE_INTERVAL_MS, private readonly maxKeys: number = 1000) {}

  /** True (and records the time) when a write is allowed for `key` now. */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const last = this.lastWrite.get(key);
    if (last !== undefined && now - last < this.intervalMs) return false;
    this.lastWrite.set(key, now);
    if (this.lastWrite.size > this.maxKeys) {
      const oldest = this.lastWrite.keys().next().value;
      if (oldest !== undefined) this.lastWrite.delete(oldest);
    }
    return true;
  }
}

export interface RejectionStore {
  /** Marks the document that holds the token as invalid. Returns false when the connection does not exist. */
  markInvalid(uid: string, connectionId: string): Promise<boolean>;
  invalidateToken(uid: string, connectionId: string): void;
}

/**
 * Flags a connection whose token Google rejected even after a fresh one was tried, so Settings shows
 * "Needs reconnecting". At most one write per connection per hour. Never deletes anything and never
 * touches grantedScopes (that is the store's contract). Returns true when a write was made.
 */
export async function markConnectionRejected(
  store: RejectionStore,
  throttle: RejectionThrottle,
  uid: string,
  connectionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  store.invalidateToken(uid, connectionId);
  if (!throttle.tryAcquire(`${uid}:${connectionId}`, now)) return false;
  return store.markInvalid(uid, connectionId);
}
