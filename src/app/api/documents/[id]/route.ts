import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { checkRateLimit } from "@/lib/server/rateLimit";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recursive deletes touch several subcollections; adjust to the deployment plan limit.
export const maxDuration = 60;

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Removes a Study Materials record and everything stored under it
 * (quiz cache, extracted-text cache, annotations). Firestore does NOT delete
 * subcollections when the parent is deleted, so a plain client deleteDoc would
 * leave them behind as orphans. The Drive file itself is never touched.
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "document-delete", limit: 60 })) {
    return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
  }

  const documentId = params.id;
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    return NextResponse.json({ error: "Invalid document id." }, { status: 400 });
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const documentRef = userRef.collection("personalDocuments").doc(documentId);
    const snap = await documentRef.get();
    if (!snap.exists) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    // Parent document + quiz/, content/, annotations/ subcollections.
    await adminDb.recursiveDelete(documentRef);

    // Per-document study data saved under the "d_" key prefix (see notes.ts).
    // Best effort: a failure here must not turn a successful removal into an error.
    await Promise.allSettled([
      userRef.collection("summaries").doc(`d_${documentId}`).delete(),
      userRef.collection("notes").doc(`d_${documentId}`).delete(),
    ]);

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Document delete failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Couldn't remove this document." }, { status: 500 });
  }
}
