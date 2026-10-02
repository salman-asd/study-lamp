import { adminDb } from "@/lib/server/firebase-admin";
import { OwnershipCache, chunkItems, groupBy } from "@/lib/server/ownershipCache";

/**
 * Confirms the requesting uid actually owns a PersonalVideo or
 * PersonalDocument referencing this Drive file, before the stream/thumbnail
 * proxy routes (Phase 16) will forward any bytes. This is the whole reason
 * those routes exist instead of handing the browser a Drive URL directly —
 * without this check, any signed-in user who learned another user's fileId
 * could read their file.
 */

export interface DriveFileRef {
  fileId: string;
  connectionId: string;
}

// Firestore allows at most 30 values in an `in` filter.
const IN_QUERY_LIMIT = 30;
const ownershipCache = new OwnershipCache(60_000);

/**
 * Batch ownership check. Returns the cache-style keys (see ownedKey) of the
 * files the user owns. Instead of two queries per file it issues, per Drive
 * connection and chunk of up to 30 files, ONE collection-group query for
 * videos and ONE query for documents; recent positive answers come from a
 * 60-second per-instance cache.
 */
export async function findOwnedDriveFiles(uid: string, files: readonly DriveFileRef[]): Promise<Set<string>> {
  const owned = new Set<string>();
  const pending: DriveFileRef[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const key = ownedKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ownershipCache.has(OwnershipCache.key(uid, file.connectionId, file.fileId))) owned.add(key);
    else pending.push(file);
  }
  if (pending.length === 0) return owned;

  const lookups: Array<Promise<string[]>> = [];
  for (const [connectionId, group] of groupBy(pending, (file) => file.connectionId)) {
    for (const chunk of chunkItems(group.map((file) => file.fileId), IN_QUERY_LIMIT)) {
      lookups.push(queryOwnedFileIds(uid, connectionId, chunk));
    }
  }

  const found = (await Promise.all(lookups)).flat();
  const foundKeys = new Set(found);
  for (const file of pending) {
    const key = ownedKey(file);
    if (!foundKeys.has(key)) continue;
    owned.add(key);
    ownershipCache.add(OwnershipCache.key(uid, file.connectionId, file.fileId));
  }
  return owned;
}

export function ownedKey(file: DriveFileRef): string {
  return `${file.connectionId}:${file.fileId}`;
}

async function queryOwnedFileIds(uid: string, connectionId: string, fileIds: string[]): Promise<string[]> {
  // Videos live nested under users/{uid}/personalPlaylists/{playlistId}/videos/{videoId}.
  // We don't know playlistId, so use a collectionGroup query and confirm the
  // matched doc's path actually belongs to this uid (Firestore collectionGroup
  // queries span all users, so the path check is the ownership boundary).
  const [videoMatch, documentMatch] = await Promise.all([
    adminDb
      .collectionGroup("videos")
      .where("driveConnectionId", "==", connectionId)
      .where("driveFileId", "in", fileIds)
      .limit(fileIds.length * 5)
      .get(),
    adminDb
      .collection("users")
      .doc(uid)
      .collection("personalDocuments")
      .where("driveConnectionId", "==", connectionId)
      .where("driveFileId", "in", fileIds)
      .get(),
  ]);

  const ownedIds = new Set<string>();
  for (const doc of videoMatch.docs) {
    if (doc.ref.path.startsWith(`users/${uid}/personalPlaylists/`)) ownedIds.add(doc.get("driveFileId") as string);
  }
  for (const doc of documentMatch.docs) ownedIds.add(doc.get("driveFileId") as string);
  return Array.from(ownedIds, (fileId) => ownedKey({ fileId, connectionId }));
}

export async function ownsDriveFile(uid: string, fileId: string, connectionId: string): Promise<boolean> {
  const owned = await findOwnedDriveFiles(uid, [{ fileId, connectionId }]);
  return owned.has(ownedKey({ fileId, connectionId }));
}
