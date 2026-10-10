import type { DriveConnectionSummary } from "@/types";

/**
 * Pure helpers for the Backups page (Settings -> Backups).
 * A connection Google rejected is shown as "Needs reconnect" instead of being hidden.
 */

export function isUsableConnection(connection: Pick<DriveConnectionSummary, "status">): boolean {
  return connection.status !== "invalid";
}

/** The connection the page works with: the first one that is not rejected. */
export function pickBackupConnection<T extends Pick<DriveConnectionSummary, "status">>(connections: readonly T[]): T | null {
  return connections.find(isUsableConnection) ?? null;
}

/** Error from a Drive call that means "reconnect Google" (the server sends `code: "reconnect"`). */
export function isReconnectError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "reconnect";
}

/** Show the "Reconnect Google" alert when a call said so, or when connections exist but none can be used. */
export function shouldShowReconnectAlert(connections: readonly Pick<DriveConnectionSummary, "status">[], reconnectRequested: boolean): boolean {
  if (reconnectRequested) return true;
  return connections.length > 0 && connections.every((connection) => !isUsableConnection(connection));
}

/** After the server rejects a connection, mirror that locally so the badge shows without a reload. */
export function markConnectionInvalid<T extends Pick<DriveConnectionSummary, "id" | "status">>(connections: readonly T[], id: string): T[] {
  return connections.map((connection) => (connection.id === id ? { ...connection, status: "invalid" as const } : connection));
}

/** Text for any caught value. Never shows raw status text such as "DriveApiError status=401". */
export function backupErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message && !/DriveApiError|status=\d{3}/.test(error.message)) return error.message;
  return fallback;
}
