import type { NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/server/firebase-admin";

/**
 * Verifies the "Authorization: Bearer <idToken>" header against Firebase
 * Admin Auth and returns the caller's uid, or null if missing/invalid.
 *
 * Same check every existing authenticated route already does inline (see
 * src/app/api/youtube-duration/route.ts and src/app/api/find-user/route.ts)
 * — factored out here since Phase 2 adds several new route files that all
 * need it. Existing routes are left untouched; this doesn't change them.
 */
export async function requireAuthenticatedUid(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  // A plain <img src>/<video src> can't set an Authorization header, so the
  // Drive stream/thumbnail proxy routes (Phase 16) pass the ID token as a
  // query param instead. Every other route keeps using the header — this is
  // purely an additional fallback, never a weaker check (verifyIdToken below
  // validates it identically either way).
  const token = match?.[1] || req.nextUrl.searchParams.get("idToken") || "";
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
