import admin from "firebase-admin";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { logServerError } from "@/lib/server/logError";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { validateQuizAttemptInput } from "@/lib/quizAttempt";

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = validateQuizAttemptInput(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  try {
    const ref = await adminDb.collection("users").doc(uid).collection("quizAttempts").add({
      userId: uid,
      ...result.value,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ id: ref.id }, { status: 201 });
  } catch (error) {
    logServerError("Failed to save quiz attempt", error);
    return NextResponse.json({ error: "Failed to save quiz attempt." }, { status: 500 });
  }
}
