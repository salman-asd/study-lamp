import crypto from "crypto";
import admin from "firebase-admin";
import { getNote, getSummary } from "@/lib/firestore/notes";
import { adminDb } from "@/lib/server/firebase-admin";
import { buildPlanItem } from "@/lib/sync/plan";

export type GoogleStudioAppendContent = "summary" | "notes" | "quiz_review";

export function htmlToPlainText(value: string): string {
  const normalized = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ");
  return normalized.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatGoogleDocHeading(date = new Date()): string {
  return `Study Lamp — ${date.toISOString().slice(0, 10)}`;
}

export function buildGoogleDocAppendText(kind: GoogleStudioAppendContent, data: { summary?: string | null; note?: string | null; review?: string | null }): string {
  switch (kind) {
    case "summary": return data.summary?.trim() || "No summary yet.";
    case "notes": return data.note?.trim() || "No notes yet.";
    case "quiz_review": return data.review?.trim() || "No quiz review yet.";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export async function getDocumentAppendPayload(uid: string, documentId: string, kind: GoogleStudioAppendContent): Promise<{ heading: string; text: string; truncated: boolean }> {
  const summary = await getSummary(uid, `d_${documentId}`);
  const note = await getNote(uid, `d_${documentId}`);
  let text: string;

  if (kind === "summary") {
    text = htmlToPlainText(summary?.content ?? "");
  } else if (kind === "notes") {
    text = (note?.content ?? "").replace(/\r\n/g, "\n").trim();
  } else {
    const attemptSnap = await adminDb.collection("users").doc(uid).collection("quizAttempts")
      .where("videoId", "==", `d_${documentId}`)
      .where("source", "==", "document")
      .orderBy("completedAt", "desc")
      .limit(1)
      .get();

    const latest = attemptSnap.docs[0]?.data();
    if (!latest) throw new Error("No quiz results are available yet.");
    const score = Number(latest.score ?? 0);
    const total = Number(latest.totalQuestions ?? 0);
    const percent = total > 0 ? Math.round((score / total) * 100) : 0;
    const wrong = Array.isArray(latest.answers) ? latest.answers.filter((entry: any) => entry && entry.wasCorrect === false).length : 0;
    text = `Latest quiz result: ${score}/${total} (${percent}%). Wrong answers: ${wrong}.`;
  }
  const heading = formatGoogleDocHeading();
  const fullText = `${heading}\n\n${text}`;
  return { heading, text: fullText, truncated: fullText.length > 20_000 };
}

export async function getSheetAppendRows(uid: string, documentId: string): Promise<{ rows: Array<Array<string | number>>; willCreateTab: boolean; tab: string }> {
  const tab = "Study Lamp log";
  const material = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
  const title = material.exists ? String(material.data()?.title ?? "Study material") : "Study material";

  const snap = await adminDb.collection("users").doc(uid).collection("quizAttempts")
    .where("videoId", "==", `d_${documentId}`)
    .where("source", "==", "document")
    .where("googleSheetExportedAt", "==", null)
    .get();

  const rows: Array<Array<string | number>> = [];
  for (const doc of snap.docs) {
    const attempt = doc.data();
    const score = Number(attempt.score ?? 0);
    const total = Number(attempt.totalQuestions ?? 0);
    const percent = total > 0 ? Math.round((score / total) * 100) : 0;
    const stamp = typeof attempt.completedAt?.toDate === "function" ? attempt.completedAt.toDate().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    rows.push([stamp, title, "Document quiz", score, total, `${percent}%`]);
  }
  return { rows, willCreateTab: rows.length > 0, tab };
}

export function buildGoogleAppendPlanItem({ target, title, renderedText, remoteVersion }: { target: string; title: string; renderedText: string; remoteVersion: string | null }) {
  return buildPlanItem({
    kind: "append",
    target,
    title,
    fields: [{ name: "text", before: "", after: renderedText.slice(0, 180) }],
    risk: "normal",
    remoteVersion,
    localValue: renderedText,
  });
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function markQuizAttemptsExported(uid: string, documentId: string): Promise<void> {
  const snap = await adminDb.collection("users").doc(uid).collection("quizAttempts")
    .where("videoId", "==", `d_${documentId}`)
    .where("source", "==", "document")
    .where("googleSheetExportedAt", "==", null)
    .get();

  const batch = adminDb.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, { googleSheetExportedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  if (!snap.empty) await batch.commit();
}
