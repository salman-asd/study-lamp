import { sanitizeGeneralPrefs, type GeneralPrefs } from "@/lib/generalPrefs";

async function request(idToken: string, init?: RequestInit): Promise<GeneralPrefs> {
  const res = await fetch("/api/preferences/general", {
    ...init,
    headers: { Authorization: `Bearer ${idToken}`, ...(init?.headers || {}) },
  });
  const data: { error?: string; preferences?: unknown } = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return sanitizeGeneralPrefs(data.preferences);
}

export function getGeneralPrefsRemote(idToken: string) {
  return request(idToken);
}

export function updateGeneralPrefsRemote(idToken: string, partial: Partial<GeneralPrefs>) {
  return request(idToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
}

const cacheKey = (uid: string) => `sl.generalPrefs.${uid}`;

/** localStorage copy so the first paint already has the right layout. Always safe to call. */
export function readCachedGeneralPrefs(uid: string): GeneralPrefs | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(uid));
    return raw ? sanitizeGeneralPrefs(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedGeneralPrefs(uid: string, prefs: GeneralPrefs): void {
  try {
    window.localStorage.setItem(cacheKey(uid), JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the server copy is still correct.
  }
}
