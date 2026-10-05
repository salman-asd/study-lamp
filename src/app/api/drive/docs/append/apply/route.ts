import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { appendToDocument } from "@/lib/server/googleDocs";
import { applyConfirmed } from "@/lib/server/applyGate";
import { verifyPlanToken } from "@/lib/server/planToken";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body?.planToken === "string" ? body.planToken : "";
  const accepted = Array.isArray(body?.accepted) ? body.accepted.filter((value: unknown) => typeof value === "string") : [];
  if (!token || accepted.length === 0) return NextResponse.json({ error: "planToken and accepted are required." }, { status: 400 });

  try {
    const verified = verifyPlanToken(token, uid, "docs_append");
    const item = verified.items[0];
    if (!item) return NextResponse.json({ error: "No append item was included in this plan." }, { status: 400 });

    const docId = body.documentId || "";
    const docSnap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(docId).get();
    if (!docSnap.exists) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    const doc = docSnap.data() as any;
    if (!doc?.googleNative || !doc?.driveFileId || !doc?.driveConnectionId || doc?.fileType !== "docx") {
      return NextResponse.json({ error: "Only Google-native DOCX documents can be appended to." }, { status: 400 });
    }

    const result = await withDriveAccessToken(uid, doc.driveConnectionId, async (accessToken) => {
      await appendToDocument(accessToken, doc.driveFileId, { revisionId: body.revisionId || "", text: body.text || "", heading: body.heading || "Study Lamp" });
      return { ok: true };
    });

    const decisions = await applyConfirmed({
      token,
      accepted,
      freshPlan: [{
        itemId: item.itemId,
        kind: "append",
        target: "google-doc",
        title: "Google Doc append",
        fields: [{ name: "text", before: "", after: "preview" }],
        risk: "normal",
        fingerprint: item.fingerprint,
      }],
      writers: {
        [item.itemId]: async () => { return; },
      },
      expectedUser: uid,
      expectedScope: "docs_append",
    });

    return NextResponse.json({ ok: result.ok, decisions }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Couldn't append to this Google Doc." }, { status: 400 });
  }
}, { scope: "googleApply", preset: "googleSync", limit: 20, tooManyMessage: "Too many document apply requests. Please slow down." });
