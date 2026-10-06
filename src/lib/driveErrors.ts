/**
 * Pure (no server imports) classification of Drive API failures, shared by the
 * server wrapper, the stream route and the UI so each failure gets its own message.
 */
export type DriveErrorCode = "too_large" | "permission" | "not_found" | "unsupported_type" | "auth" | "upstream";

/** Reads error.errors[0].reason from a Google API error body. Never returns the message text. */
export function extractGoogleErrorReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
    const reason = (errors[0] as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason.slice(0, 80);
  }
  return null;
}

export function classifyDriveExportError(status: number, reason?: string | null): DriveErrorCode {
  if (status === 403) return reason === "exportSizeLimitExceeded" ? "too_large" : "permission";
  if (status === 404) return "not_found";
  if (status === 401) return "auth";
  return "upstream";
}

export const DRIVE_ERROR_MESSAGES: Record<DriveErrorCode, string> = {
  too_large: "This Google file is too large to export from Drive.",
  permission: "Study Lamp no longer has permission to open this Google file. Pick it again with the connected account.",
  not_found: "This Google file wasn't found. It may have been moved to the trash or deleted.",
  unsupported_type: "This Drive file isn't a supported Google Doc or Sheet.",
  auth: "Google Drive rejected the connection. Reconnect Drive in Settings.",
  upstream: "Google Drive couldn't serve this file. Try again in a moment.",
};

export function driveHttpStatusForCode(code: DriveErrorCode): number {
  switch (code) {
    case "too_large": return 413;
    case "permission": return 403;
    case "not_found": return 404;
    case "unsupported_type": return 400;
    case "auth": return 409;
    default: return 502;
  }
}

const KNOWN_CODES = new Set<string>(["too_large", "permission", "not_found", "unsupported_type", "auth", "upstream"]);

/** Turns a failed stream-proxy Response into a user-facing message (known codes only; server text is never echoed). */
export async function driveResponseErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  if (body && typeof body.code === "string" && KNOWN_CODES.has(body.code)) return DRIVE_ERROR_MESSAGES[body.code as DriveErrorCode];
  if (response.status === 404) return DRIVE_ERROR_MESSAGES.not_found;
  return fallback;
}
