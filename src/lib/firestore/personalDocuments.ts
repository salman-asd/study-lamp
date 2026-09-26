import {
  collection, deleteDoc, doc, getDoc, getDocs, orderBy, query,
  serverTimestamp, updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { PersonalDocument } from "@/types";

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

export async function deletePersonalDocument(ownerId: string, documentId: string): Promise<void> {
  // Only removes the Study Lamp record — the underlying Drive file is left
  // untouched, matching every other Drive-import surface's "we don't own
  // your Drive" stance.
  await deleteDoc(doc(db, "users", ownerId, "personalDocuments", documentId));
}
