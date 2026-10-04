import type { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/server/firebase-admin";

/**
 * Verifies the "Authorization: Bearer <idToken>" header against Firebase
 * Admin Auth and returns the caller's uid, or null if missing/invalid.
 *
 * Same check every authenticated route uses; browser requests must send the
 * token in Authorization rather than a query string.
 */
export async function requireAuthenticatedUid(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] || "";
  if (!token) return null;

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

export async function requireAdminUid(req: NextRequest): Promise<string | null> {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return null;

  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    const role = snap.exists ? snap.data()?.role : null;
    return role === "admin" ? uid : null;
  } catch {
    return null;
  }
}
