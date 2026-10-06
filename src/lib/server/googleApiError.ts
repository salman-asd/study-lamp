/**
 * Typed failure for Google Docs / Sheets REST calls (Z2).
 *
 * Rule 4/5: the message NEVER contains the Google response body, and callers must not return
 * error.message to the browser. Only the status code and a coarse `kind` are kept.
 */
export type GoogleApiErrorKind =
  | "auth" // 401: token rejected
  | "permission" // 403
  | "not_found" // 404 (deleted, trashed, or not visible under drive.file)
  | "revision_changed" // the document changed since the revision we read (writeControl)
  | "rate_limited" // 429
  | "retryable" // 5xx
  | "bad_request" // other 4xx
  | "unknown";

export class GoogleApiError extends Error {
  readonly kind: GoogleApiErrorKind;
  /** HTTP status. Named `status` on purpose: runWithDriveToken retries once when it is 401. */
  readonly status: number;

  constructor(kind: GoogleApiErrorKind, status: number) {
    super(`Google API request failed (${kind})`);
    this.name = "GoogleApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function classifyGoogleStatus(status: number, reason?: string): GoogleApiErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  // Docs answers a stale writeControl.requiredRevisionId with 400 FAILED_PRECONDITION (verify with the Z2 diagnostic).
  if (status === 409 || (status === 400 && reason === "FAILED_PRECONDITION")) return "revision_changed";
  if (status >= 500) return "retryable";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Builds a GoogleApiError from a failed response. Reads only `error.status`, never the message. */
export async function googleApiErrorFromResponse(res: Response): Promise<GoogleApiError> {
  let reason: string | undefined;
  try {
    const body: unknown = await res.json();
    const status = (body as { error?: { status?: unknown } } | null)?.error?.status;
    if (typeof status === "string") reason = status;
  } catch {
    // no JSON body: classify by HTTP status alone
  }
  return new GoogleApiError(classifyGoogleStatus(res.status, reason), res.status);
}
