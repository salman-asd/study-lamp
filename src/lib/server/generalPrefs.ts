import { adminDb } from "@/lib/server/firebase-admin";
import { mergeGeneralPrefs, sanitizeGeneralPrefs, type GeneralPrefs } from "@/lib/generalPrefs";

export async function getGeneralPrefs(uid: string): Promise<GeneralPrefs> {
  const snap = await adminDb.collection("users").doc(uid).get();
  return sanitizeGeneralPrefs(snap.data()?.generalPrefs);
}

/** Merges only the validated keys in `partial`; one read + one write. Never touches aiSettings. */
export async function updateGeneralPrefs(uid: string, partial: Partial<GeneralPrefs>): Promise<GeneralPrefs> {
  const ref = adminDb.collection("users").doc(uid);
  const snap = await ref.get();
  const next = mergeGeneralPrefs(snap.data()?.generalPrefs, partial);
  await ref.set({ generalPrefs: next }, { merge: true });
  return next;
}
