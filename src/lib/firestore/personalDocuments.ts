import {
  collection, doc, getDoc, getDocs, orderBy, query,
  serverTimestamp, setDoc, updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { parseDocumentAnnotations, serializeDocumentAnnotations } from "@/lib/documentAnnotations";
import type { PersonalDocument } from "@/types";
import { normalizeReaderProgress, type ReaderFileType, type ReaderProgressInput } from "@/lib/readerProgress";

// users/{ownerId}/personalDocuments/{id} — see the PersonalDocument doc
// comment in src/types/index.ts. Creation happens server-side only, via
// /api/drive/import/file (a document's bytes always come from Drive — see
// Phase 13-16's comments) — this module is read/rename/delete from the
// client, mirroring personalPlaylists.ts's ownerId-explicit pattern.

const documentsCol = (ownerId: string) => collection(db, "users", ownerId, "personalDocuments");

export async function listPersonalDocuments(ownerId: string): Promise<PersonalDocument[]> {
  const snap = await getDocs(query(documentsCol(ownerId), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PersonalDocument, "id">) }));
}

export async function getPersonalDocumentClient(ownerId: string, documentId: string): Promise<PersonalDocument | null> {
  const snap = await getDoc(doc(db, "users", ownerId, "personalDocuments", documentId));
  return snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<PersonalDocument, "id">) }) : null;
}

export async function renamePersonalDocument(ownerId: string, documentId: string, title: string): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), { title: title.trim(), updatedAt: serverTimestamp() });
}

export async function updatePersonalDocumentClassification(
  ownerId: string,
  documentId: string,
  classification: { categoryId: string | null; tagIds: string[] },
): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), {
    ...classification,
    updatedAt: serverTimestamp(),
  });
}

/** Saves the reading position for a PDF, Word or Excel document. The shape is normalised
 *  (clamped, only the fields that belong to `fileType`) so it always satisfies the Firestore rules. */
export async function updatePersonalDocumentReadingProgress(
  ownerId: string,
  documentId: string,
  progress: ReaderProgressInput,
  fileType: ReaderFileType = "pdf",
): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), {
    readerProgress: { ...normalizeReaderProgress(progress, fileType), updatedAt: serverTimestamp() },
  });
}

function documentAnnotationsRef(ownerId: string, documentId: string) {
  return doc(db, "users", ownerId, "personalDocuments", documentId, "annotations", "main");
}

export async function getPersonalDocumentAnnotations(ownerId: string, documentId: string): Promise<unknown[]> {
  const snapshot = await getDoc(documentAnnotationsRef(ownerId, documentId));
  if (!snapshot.exists()) return [];
  return parseDocumentAnnotations(snapshot.data()?.annotationsJson);
}

export async function savePersonalDocumentAnnotations(
  ownerId: string,
  documentId: string,
  annotations: unknown[],
): Promise<void> {
  const annotationsJson = serializeDocumentAnnotations(annotations);
  await setDoc(documentAnnotationsRef(ownerId, documentId), {
    annotationsJson,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function deletePersonalDocument(idToken: string, documentId: string): Promise<void> {
  // Only removes the Study Lamp record (and its quiz/content/annotations
  // subcollections) — the underlying Drive file is left untouched, matching
  // every other Drive-import surface's "we don't own your Drive" stance.
  // Goes through the server because Firestore does not cascade-delete
  // subcollections and the client rules deny reads/writes on `content`.
  const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}
