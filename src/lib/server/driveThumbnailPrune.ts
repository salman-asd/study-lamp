import { adminDb } from "@/lib/server/firebase-admin";
import admin from "firebase-admin";
import { chunkItems, groupBy } from "@/lib/server/ownershipCache";
import { queryOwnedFileIds } from "@/lib/server/driveOwnership";
import { driveThumbnailDocId } from "@/lib/server/driveThumbnails";
import { findUnreferencedThumbnailIds, parseThumbnailDocId } from "@/lib/server/thumbnailPrune";

const IN_QUERY_LIMIT = 30;
const SCAN_PAGE_SIZE = 500;
/** Upper bound on thumbnail docs examined per call (ids only, no image bytes are read). */
const MAX_SCAN = 3000;
const LOOKUP_CONCURRENCY = 8;

function thumbsCol(uid: string) {
  return adminDb.collection("users").doc(uid).collection("driveThumbs");
}

/** Deletes one thumbnail unless a video or document of this user still references the file. Uncached check. */
export async function removeThumbnailIfUnreferenced(uid: string, connectionId: string, fileId: string): Promise<boolean> {
  const referenced = await queryOwnedFileIds(uid, connectionId, [fileId]);
  if (referenced.length > 0) return false;
  await thumbsCol(uid).doc(driveThumbnailDocId(connectionId, fileId)).delete();
  return true;
}

/** Deletes up to `limit` unreferenced thumbnail docs. `remaining` = unreferenced docs found but not deleted. */
export async function pruneUnreferencedThumbnails(uid: string, limit: number): Promise<{ pruned: number; remaining: number }> {
  const ids: string[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (ids.length < MAX_SCAN) {
    let query = thumbsCol(uid).orderBy(admin.firestore.FieldPath.documentId()).select().limit(SCAN_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;
    ids.push(...page.docs.map((doc) => doc.id));
    last = page.docs[page.docs.length - 1];
    if (page.size < SCAN_PAGE_SIZE) break;
  }

  const parsed = ids.map((id) => ({ id, parts: parseThumbnailDocId(id) })).filter((entry) => entry.parts !== null);
  const byConnection = groupBy(parsed, (entry) => entry.parts!.connectionId);
  const lookups: Array<() => Promise<string[]>> = [];
  for (const [connectionId, group] of byConnection) {
    for (const chunk of chunkItems(group.map((entry) => entry.parts!.fileId), IN_QUERY_LIMIT)) {
      lookups.push(() => queryOwnedFileIds(uid, connectionId, chunk));
    }
  }

  const referencedKeys = new Set<string>();
  for (let index = 0; index < lookups.length; index += LOOKUP_CONCURRENCY) {
    const results = await Promise.all(lookups.slice(index, index + LOOKUP_CONCURRENCY).map((run) => run()));
    for (const keys of results) for (const key of keys) referencedKeys.add(key);
  }

  const unreferenced = findUnreferencedThumbnailIds(ids, referencedKeys);
  const toDelete = unreferenced.slice(0, limit);
  if (toDelete.length > 0) {
    const batch = adminDb.batch();
    for (const id of toDelete) batch.delete(thumbsCol(uid).doc(id));
    await batch.commit();
  }
  return { pruned: toDelete.length, remaining: unreferenced.length - toDelete.length };
}
