import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { getDocumentEnd } from "@/lib/server/googleDocs";
import { buildGoogleAppendPlanItem, getDocumentAppendPayload, type GoogleStudioAppendContent } from "@/lib/server/googleAppend";
import { signPlanToken } from "@/lib/server/planToken";
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

  const documentId = typeof body?.documentId === "string" ? body.documentId.trim() : "";
  const kind = typeof body?.content === "string" ? body.content : "";
  if (!documentId || !["summary", "notes", "quiz_review"].includes(kind)) {
    return NextResponse.json({ error: "documentId and content are required." }, { status: 400 });
  }

  const docSnap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
  if (!docSnap.exists) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const doc = docSnap.data() as any;
  if (!doc?.googleNative || !doc?.driveFileId || !doc?.driveConnectionId || doc?.fileType !== "docx") {
    return NextResponse.json({ error: "Only Google-native DOCX documents can be appended to." }, { status: 400 });
  }

  try {
    const payload = await getDocumentAppendPayload(uid, documentId, kind as GoogleStudioAppendContent);
    const openUrl = `https://docs.google.com/document/d/${doc.driveFileId}/edit`;
    const data = await withDriveAccessToken(uid, doc.driveConnectionId, async (accessToken) => {
      const endInfo = await getDocumentEnd(accessToken, doc.driveFileId);
      const renderedText = payload.text;
      const item = buildGoogleAppendPlanItem({
        target: `google-doc:${documentId}:${kind}`,
        title: `${doc.title} — ${kind}`,
        renderedText,
        remoteVersion: endInfo.revisionId,
      });
      const token = signPlanToken({ uid, scope: "docs_append", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }] });
      return {
        planToken: token,
        item,
        preview: {
          documentTitle: doc.title,
          openUrl,
          heading: payload.heading,
          text: payload.text.replace(new RegExp(`^${payload.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*`), ""),
          truncated: payload.truncated,
        },
      };
    });
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Failed to prepare the document preview." }, { status: 400 });
  }
}, { scope: "googleSync", preset: "googleSync", limit: 30, tooManyMessage: "Too many document preview requests. Please slow down." });
