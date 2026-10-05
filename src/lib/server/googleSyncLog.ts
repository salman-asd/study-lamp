import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";

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
  /** Goal fields only — never tokens or document text (Z3 item 4). */
  goalId?: string;
  titleSnapshot: string;
  targetDateSnapshot?: string | null;
  completedSnapshot?: boolean | null;
  fields: GoogleSyncLogField[];
  result: "applied" | "stale" | "skipped" | "failed";
}

// ─── Persistence (Z3 item 4) ───────────────────────────────────────────────

function syncLogRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleSyncLog");
}

/**
 * Saves one sync log entry and prunes the collection down to 200 entries
 * if it exceeds 220. Writes goal-level fields only — never tokens or document
 * text (Rule 4 / Z3 item 4).
 */
export async function saveSyncLogEntry(uid: string, entry: GoogleSyncLogEntry): Promise<void> {
  await syncLogRef(uid).add({
    ...entry,
    _at: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Prune: keep at most 200 entries when we exceed 220.
  await pruneSyncLog(uid);
}

/**
 * Returns the newest entries (newest first), paginated by cursor.
 */
export async function listSyncLog(
  uid: string,
  cursor?: string,
  limit = 50,
): Promise<{ entries: GoogleSyncLogEntry[]; nextCursor: string | null }> {
  let query = syncLogRef(uid)
    .orderBy("_at", "desc")
    .limit(limit + 1);

  if (cursor) {
    const cursorDoc = await syncLogRef(uid).doc(cursor).get();
    if (cursorDoc.exists) {
      query = query.startAfter(cursorDoc);
    }
  }

  const snap = await query.get();
  const hasMore = snap.docs.length > limit;
  const docs = hasMore ? snap.docs.slice(0, limit) : snap.docs;

  const entries = docs.map((doc) => {
    const data = doc.data() as GoogleSyncLogEntry & { _at?: unknown };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _at, ...entry } = data;
    return entry as GoogleSyncLogEntry;
  });

  return {
    entries,
    nextCursor: hasMore ? docs[docs.length - 1].id : null,
  };
}

/**
 * Prune: delete the oldest entries down to 200 when the count exceeds 220.
 * Queries by _at desc, skips 200, deletes up to the next 50 (one batch).
 */
async function pruneSyncLog(uid: string): Promise<void> {
  const snap = await syncLogRef(uid)
    .orderBy("_at", "desc")
    .offset(200)
    .limit(50)
    .get();

  if (snap.empty) return;

  const batch = adminDb.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
}

// ─── Pure helpers (kept for tests / apply routes) ─────────────────────────

export function logSyncApplied(entry: Omit<GoogleSyncLogEntry, "result">): GoogleSyncLogEntry {
  return { ...entry, result: "applied" };
}

/**
 * Pure in-memory prune — used in tests.
 * pruneGoogleSyncLog(entries, maxEntries, pruneThreshold): oldest-first slice.
 */
export function pruneGoogleSyncLog(entries: GoogleSyncLogEntry[], maxEntries = 200, pruneThreshold = 220): GoogleSyncLogEntry[] {
  if (entries.length <= pruneThreshold) return entries;
  return entries.slice(0, maxEntries);
}
