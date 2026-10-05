export interface GoogleSyncLogField {
  name: string;
  before: string | boolean | null;
  after: string | boolean | null;
}

export interface GoogleSyncLogEntry {
  at: string;
  scope: string;
  direction: string;
  itemKind: string;
  goalId?: string;
  titleSnapshot: string;
  fields: GoogleSyncLogField[];
  result: "applied" | "stale" | "skipped" | "failed";
}

export function logSyncApplied(entry: Omit<GoogleSyncLogEntry, "result">): GoogleSyncLogEntry {
  return { ...entry, result: "applied" };
}

export function pruneGoogleSyncLog(entries: GoogleSyncLogEntry[], maxEntries = 200, pruneThreshold = 220): GoogleSyncLogEntry[] {
  if (entries.length <= pruneThreshold) return entries;
  return entries.slice(0, maxEntries);
}
