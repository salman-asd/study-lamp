import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { fetchFileContent, getFileMetadata } from "@/lib/server/googleDrive";
import { extractDocumentText, MAX_DOCUMENT_BYTES } from "@/lib/server/documentText";
import { isSameDriveRevision } from "@/lib/server/documentContentUtils";
import { hashDocumentText } from "@/lib/quizSource";
import admin from "firebase-admin";
import type { DocumentFileType } from "@/types";

export interface LoadedDocument {
  id: string;
  title: string;
  fileType: DocumentFileType;
  driveFileId: string;
  driveConnectionId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
}

export async function getPersonalDocument(uid: string, documentId: string): Promise<LoadedDocument | null> {
  const snap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    id: snap.id,
    title: data.title,
    fileType: data.fileType,
    driveFileId: data.driveFileId,
    driveConnectionId: data.driveConnectionId,
    md5Checksum: data.md5Checksum ?? null,
    modifiedTime: data.modifiedTime ?? null,
  };
}

async function readDocumentBytes(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("This document is larger than the 50 MB extraction limit.");
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("This document is larger than the 50 MB extraction limit.");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("This document is larger than the 50 MB extraction limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** Reuses extracted text while Drive's content revision remains unchanged. */
export async function extractPersonalDocumentText(uid: string, doc: LoadedDocument): Promise<string> {
  const documentRef = adminDb.collection("users").doc(uid).collection("personalDocuments").doc(doc.id);
  const cacheRef = documentRef.collection("content").doc("text");

  return withDriveAccessToken(uid, doc.driveConnectionId, async (accessToken) => {
    const metadata = await getFileMetadata(accessToken, doc.driveFileId);
    const revision = { md5Checksum: metadata.md5Checksum ?? null, modifiedTime: metadata.modifiedTime ?? null };
    const cacheSnapshot = await cacheRef.get();
    const cached = cacheSnapshot.data();
    if (
      typeof cached?.text === "string" &&
      isSameDriveRevision(cached, revision)
    ) {
      return cached.text;
    }

    const response = await fetchFileContent(accessToken, doc.driveFileId, null);
    if (!response.ok) throw new Error(`Couldn't download "${doc.title}" from Drive (${response.status}).`);
    const bytes = await readDocumentBytes(response);
    const text = await extractDocumentText(bytes, doc.fileType);
    if (!text.trim()) throw new Error(`No readable text could be extracted from "${doc.title}".`);

    const now = admin.firestore.FieldValue.serverTimestamp();
    await Promise.all([
      cacheRef.set({ ...revision, text, textHash: hashDocumentText(text), updatedAt: now }),
      documentRef.update({ ...revision, updatedAt: now }),
    ]);
    return text;
  });
}
