import type { PlanItem, SyncResolution } from "@/lib/sync/plan";
import type { GoogleConnectionSummary, GoogleSyncStatus, GoogleWorkspaceFeature } from "@/types";

async function parseOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function authHeaders(idToken: string, withJson = false): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  };
}

/** W2: the connected Google Workspace accounts (safe summaries only). */
export async function listGoogleConnections(idToken: string): Promise<GoogleConnectionSummary[]> {
  const res = await fetch("/api/google/connections", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.connections;
}

/** W2: starts the OAuth flow for the requested features and navigates the
 *  whole page to the server-built Google auth URL. */
export async function startGoogleConnect(idToken: string, features: GoogleWorkspaceFeature[]): Promise<void> {
  const res = await fetch("/api/google/auth/state", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ features }),
  });
  const data = await parseOrThrow(res);
  if (typeof data.url !== "string" || !data.url.startsWith("https://accounts.google.com/")) {
    throw new Error("Google returned an invalid authorization URL.");
  }
  window.location.assign(data.url);
}

/** W2: disconnects a Workspace account. The stored token is deleted and
 *  revoked at Google; nothing in Calendar or Tasks is deleted. */
export async function disconnectGoogleConnection(idToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`/api/google/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
    headers: authHeaders(idToken),
  });
  await parseOrThrow(res);
}

export async function getGoogleSyncStatus(idToken: string, connectionId?: string): Promise<GoogleSyncStatus> {
  const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  const res = await fetch(`/api/google/sync/status${query}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data as GoogleSyncStatus;
}

/** `connectionId` is the real id of the Google connection (from listGoogleConnections). */
export async function toggleGoogleCalendar(idToken: string, connectionId: string, enabled: boolean): Promise<{ ok: true; connection: { id: string; enabled: boolean } }> {
  const res = await fetch(`/api/google/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ calendar: { enabled } }),
  });
  const data = await parseOrThrow(res);
  return data;
}

export interface GoogleSyncPlanResponse {
  planToken: string;
  items: PlanItem[];
  counts: { push: number; pull: number; conflict: number; attention: number; remoteDeleted: number; orphaned: number };
  orphans: Array<{ goalId: string; titleSnapshot: string; eventId: string }>;
  remaining: number;
}

/** Read-only. Nothing is written anywhere; the response only describes what an apply WOULD do. */
export async function planGoogleSync(idToken: string, goalIds?: string[], connectionId?: string): Promise<GoogleSyncPlanResponse> {
  const res = await fetch("/api/google/sync/plan", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ ...(goalIds && goalIds.length ? { goalIds } : {}), ...(connectionId ? { connectionId } : {}) }),
  });
  const data = await parseOrThrow(res);
  return data as GoogleSyncPlanResponse;
}

export interface GoogleSyncApplyResult {
  itemId: string;
  status: "applied" | "stale" | "skipped" | "failed";
  code?: string;
}

export interface GoogleSyncApplyResponse {
  ok: boolean;
  results: GoogleSyncApplyResult[];
  applied: number;
  skipped: number;
  failed: number;
}

export async function applyGoogleSync(
  idToken: string,
  input: {
    planToken: string;
    accepted: string[];
    /** Keyed by itemId, or `${itemId}:${field}` for one field of a conflict. */
    resolutions?: Record<string, SyncResolution>;
    confirmedDestructive?: string[];
    connectionId?: string;
  },
): Promise<GoogleSyncApplyResponse> {
  const res = await fetch("/api/google/sync/apply", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  return data as GoogleSyncApplyResponse;
}

// ─── Z2: "Add to Google Doc / Sheet" (preview -> confirm -> apply) ──────────────────────────────

export type GoogleAppendTarget = "docs" | "sheets";
export type GoogleDocContentKind = "summary" | "notes" | "quiz_review";

/** `code` mirrors the server: stale | permission | not_found | reconnect | nothing_to_add | plan_already_applied | ... */
export class GoogleAppendError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GoogleAppendError";
    this.code = code;
    this.status = status;
  }
}

export interface GoogleDocsAppendPreview {
  planToken: string;
  item: PlanItem;
  preview: { documentTitle: string; openUrl: string; kind: GoogleDocContentKind; kindLabel: string; heading: string; text: string; truncated: boolean };
}

export interface GoogleSheetsAppendPreview {
  planToken: string;
  item: PlanItem;
  preview: {
    documentTitle: string;
    openUrl: string;
    tab: string;
    willCreateTab: boolean;
    header: Array<string | number> | null;
    rows: Array<Array<string | number>>;
    remaining: number;
  };
}

async function parseAppendResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleAppendError(
      typeof data?.error === "string" ? data.error : `Request failed (${res.status})`,
      typeof data?.code === "string" ? data.code : "error",
      res.status,
    );
  }
  return data as T;
}

/** Read-only. Returns the exact text the server would add, plus a signed plan token. Nothing is written. */
export async function previewGoogleDocAppend(idToken: string, documentId: string, content: GoogleDocContentKind): Promise<GoogleDocsAppendPreview> {
  const res = await fetch("/api/drive/docs/append/preview", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ documentId, content }),
  });
  return parseAppendResponse<GoogleDocsAppendPreview>(res);
}

export async function previewGoogleSheetAppend(idToken: string, documentId: string): Promise<GoogleSheetsAppendPreview> {
  const res = await fetch("/api/drive/sheets/append/preview", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ documentId }),
  });
  return parseAppendResponse<GoogleSheetsAppendPreview>(res);
}

/** The body is ONLY {planToken, accepted, documentId}; the server rebuilds the content itself. */
export async function applyGoogleAppend(
  idToken: string,
  target: GoogleAppendTarget,
  input: { planToken: string; accepted: string[]; documentId: string },
): Promise<{ ok: true; status: "applied"; warnings?: string[] }> {
  const res = await fetch(`/api/drive/${target}/append/apply`, {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ planToken: input.planToken, accepted: input.accepted, documentId: input.documentId }),
  });
  return parseAppendResponse(res);
}
