import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";

// ─── Ignore list (Z3 item 5) ─────────────────────────────────────────────
//
// users/{uid}/googleIgnored/{target_remoteId}
//   { at: Timestamp }
//
// A remote id stored here tells the planner to skip it when building plans.
// The ignore action is only allowed from the apply route for an item the user
// explicitly chose "Ignore" on (it goes through the plan token).

function ignoredRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleIgnored");
}

/**
 * Returns true when the given remote event for a target should be skipped.
 * target: e.g. "calendar" | "tasks"
 * remoteId: the Google event/task id
 */
export async function isIgnored(uid: string, target: string, remoteId: string): Promise<boolean> {
  const docId = `${target}_${remoteId}`;
  const snap = await ignoredRef(uid).doc(docId).get();
  return snap.exists;
}

/**
 * All remote ids the user chose to ignore for one target, read in a single query (one equality filter, so no
 * composite index). The planner uses this instead of calling isIgnored once per event.
 */
export async function listIgnoredRemoteIds(uid: string, target: string): Promise<Set<string>> {
  const snap = await ignoredRef(uid).where("target", "==", target).limit(1000).get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const remoteId = doc.data().remoteId;
    if (typeof remoteId === "string" && remoteId) ids.add(remoteId);
  }
  return ids;
}

/**
 * Records an ignore for a specific remote item.
 * Only call this from the apply route when the user explicitly chose "Ignore".
 */
export async function ignoreRemote(uid: string, target: string, remoteId: string): Promise<void> {
  const docId = `${target}_${remoteId}`;
  await ignoredRef(uid).doc(docId).set({
    target,
    remoteId,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Removes an ignore entry (used when the user later wants to re-sync).
 */
export async function unignoreRemote(uid: string, target: string, remoteId: string): Promise<void> {
  const docId = `${target}_${remoteId}`;
  await ignoredRef(uid).doc(docId).delete();
}
