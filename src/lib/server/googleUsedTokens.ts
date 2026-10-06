import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";

// ─── One-time plan tokens (Z3 item 6) ─────────────────────────────────────
//
// users/{uid}/googleUsedTokens/{jti}
//   { exp: number, at: Timestamp }
//
// markTokenUsed is called by the apply routes BEFORE any write, inside a
// Firestore transaction. The second use of the same token returns false and the
// route answers 409 "plan already applied".

function usedTokensRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleUsedTokens");
}

/**
 * Records that the token with this jti has been used.
 * Returns true when it was newly claimed (safe to proceed), false when it was
 * already used (replay — reject).
 */
export async function markTokenUsed(uid: string, jti: string, exp: number): Promise<boolean> {
  const ref = usedTokensRef(uid).doc(jti);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, {
      exp,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/**
 * Prunes spent tokens whose exp has already passed, oldest-first, up to `limit`
 * per call. Called opportunistically after a successful apply so the
 * subcollection does not grow without bound (there is no cron in this project).
 */
export async function pruneUsedTokens(uid: string, nowMs = Date.now(), limit = 100): Promise<number> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const snap = await usedTokensRef(uid)
    .where("exp", "<=", nowSeconds)
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  const batch = adminDb.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}
