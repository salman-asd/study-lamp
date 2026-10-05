import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { fetchDocumentBytes, getFileMetadata } from "@/lib/server/googleDrive";
import { extractDocumentText, MAX_DOCUMENT_BYTES } from "@/lib/server/documentText";
import { isSameDriveRevision } from "@/lib/server/documentContentUtils";
import { hashDocumentText } from "@/lib/server/sourceHash";
import { chunkDocId, joinTextChunks, splitTextIntoChunks } from "@/lib/server/textChunks";
import admin from "firebase-admin";
import type { DocumentFileType } from "@/types";

export interface LoadedDocument {
  id: string;
  title: string;
  fileType: DocumentFileType;
  mimeType?: string;
  driveFileId: string;
  driveConnectionId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  googleNative?: boolean;
}

export async function getPersonalDocument(uid: string, documentId: string): Promise<LoadedDocument | null> {
  const snap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    id: snap.id,
    title: data.title,
    fileType: data.fileType,
    mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
    driveFileId: data.driveFileId,
    driveConnectionId: data.driveConnectionId,
    md5Checksum: data.md5Checksum ?? null,
    modifiedTime: data.modifiedTime ?? null,
    googleNative: Boolean(data.googleNative),
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
  const contentCol = documentRef.collection("content");
  const metaRef = contentCol.doc("meta");
  const legacyRef = contentCol.doc("text"); // pre-chunking single document, still read for backward compatibility

  return withDriveAccessToken(uid, doc.driveConnectionId, async (accessToken) => {
    const metadata = await getFileMetadata(accessToken, doc.driveFileId);
    const revision = { md5Checksum: metadata.md5Checksum ?? null, modifiedTime: metadata.modifiedTime ?? null };
    const [metaSnapshot, legacySnapshot] = await Promise.all([metaRef.get(), legacyRef.get()]);
    const meta = metaSnapshot.data();
    if (meta && Number.isInteger(meta.chunks) && meta.chunks > 0 && isSameDriveRevision(meta, revision)) {
      const chunkSnapshots = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => contentCol.doc(chunkDocId(i)).get()));
      const parts = chunkSnapshots.map((snapshot) => snapshot.data()?.text);
      if (parts.every((part): part is string => typeof part === "string")) {
        const text = joinTextChunks(parts);
        if (hashDocumentText(text) === meta.textHash) return text;
      }
      // A missing or corrupted chunk falls through to a fresh extraction.
    }
    const legacy = legacySnapshot.data();
    if (typeof legacy?.text === "string" && isSameDriveRevision(legacy, revision)) {
      return legacy.text; // migrated to chunks on the next extraction
    }

    const response = await fetchDocumentBytes(accessToken, {
      driveFileId: doc.driveFileId,
      mimeType: doc.mimeType || "application/octet-stream",
      googleNative: Boolean(doc.googleNative),
    });
    if (!response.ok) throw new Error(`Couldn't download "${doc.title}" from Drive (${response.status}).`);
    const bytes = await readDocumentBytes(response);
    const text = await extractDocumentText(bytes, doc.fileType);
    if (!text.trim()) throw new Error(`No readable text could be extracted from "${doc.title}".`);

    const now = admin.firestore.FieldValue.serverTimestamp();
    const chunks = splitTextIntoChunks(text);
    const previousChunks = Number.isInteger(meta?.chunks) ? meta!.chunks as number : 0;

    // Chunks, meta, legacy cleanup and stale-chunk cleanup commit together.
    const batch = adminDb.batch();
    chunks.forEach((part, index) => batch.set(contentCol.doc(chunkDocId(index)), { text: part }));
    for (let index = chunks.length; index < previousChunks; index++) batch.delete(contentCol.doc(chunkDocId(index)));
    if (legacySnapshot.exists) batch.delete(legacyRef);
    batch.set(metaRef, { ...revision, chunks: chunks.length, textHash: hashDocumentText(text), updatedAt: now });
    batch.update(documentRef, { ...revision, updatedAt: now });
    await batch.commit();
    return text;
  });
}
