import type { GoogleSyncStatus } from "@/types";

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

export async function getGoogleSyncStatus(idToken: string): Promise<GoogleSyncStatus> {
  const res = await fetch("/api/google/sync/status", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data as GoogleSyncStatus;
}

export async function toggleGoogleCalendar(idToken: string, enabled: boolean): Promise<{ ok: true; connection: { id: string; enabled: boolean } }> {
  const res = await fetch("/api/google/connections/calendar", {
    method: "PATCH",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ calendar: { enabled } }),
  });
  const data = await parseOrThrow(res);
  return data;
}

export async function planGoogleSync(idToken: string, goalIds?: string[]): Promise<{ planToken: string; items: any[]; counts: any; remaining: number }> {
  const res = await fetch("/api/google/sync/plan", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(goalIds && goalIds.length ? { goalIds } : {}),
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
