import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { fetchFileContent } from "@/lib/server/googleDrive";
import { extractDocumentText } from "@/lib/server/documentText";
import type { DocumentFileType } from "@/types";

export interface LoadedDocument {
  id: string;
  title: string;
  fileType: DocumentFileType;
  driveFileId: string;
  driveConnectionId: string;
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
  };
}

/** Downloads the document's bytes from Drive and extracts plain text. Not
 *  cached (see documentText.ts's doc comment) — this runs once per summary
 *  or quiz *generation* request, which is already gated by the sourceHash
 *  cache one layer up, same as a video's transcript fetch. */
export async function extractPersonalDocumentText(uid: string, doc: LoadedDocument): Promise<string> {
  const res = await withDriveAccessToken(uid, doc.driveConnectionId, (accessToken) => (
    fetchFileContent(accessToken, doc.driveFileId, null)
  ));
  if (!res.ok) throw new Error(`Couldn't download "${doc.title}" from Drive (${res.status}).`);
  const arrayBuffer = await res.arrayBuffer();
  const text = await extractDocumentText(Buffer.from(arrayBuffer), doc.fileType);
  if (!text.trim()) throw new Error(`No readable text could be extracted from "${doc.title}".`);
  return text;
}
