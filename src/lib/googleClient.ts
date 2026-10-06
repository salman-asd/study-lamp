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

export async function planGoogleSync(idToken: string, goalIds?: string[], connectionId?: string): Promise<{ planToken: string; items: any[]; counts: any; remaining: number }> {
  const res = await fetch("/api/google/sync/plan", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ ...(goalIds && goalIds.length ? { goalIds } : {}), ...(connectionId ? { connectionId } : {}) }),
  });
  const data = await parseOrThrow(res);
  return data;
}

export async function applyGoogleSync(
  idToken: string,
  input: {
    planToken: string;
    accepted: string[];
    resolutions?: Record<string, "use_study_lamp" | "use_google" | "skip">;
    confirmedDestructive?: string[];
    connectionId?: string;
  },
): Promise<{ ok?: boolean; results?: any[]; error?: string }> {
  const res = await fetch("/api/google/sync/apply", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  return data;
}
