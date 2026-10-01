import { adminDb } from "@/lib/server/firebase-admin";

/**
 * Confirms the requesting uid actually owns a PersonalVideo or
 * PersonalDocument referencing this Drive file, before the stream/thumbnail
 * proxy routes (Phase 16) will forward any bytes. This is the whole reason
 * those routes exist instead of handing the browser a Drive URL directly —
 * without this check, any signed-in user who learned another user's fileId
 * could read their file.
 */
export async function ownsDriveFile(uid: string, fileId: string, connectionId: string): Promise<boolean> {
  // Videos live nested under users/{uid}/personalPlaylists/{playlistId}/videos/{videoId}.
  // We don't know playlistId, so use a collectionGroup query and confirm the
  // matched doc's path actually belongs to this uid (Firestore collectionGroup
  // queries span all users, so the path check is the ownership boundary).
  const videoMatch = await adminDb
    .collectionGroup("videos")
    .where("driveFileId", "==", fileId)
    .where("driveConnectionId", "==", connectionId)
    .limit(5)
    .get();
  if (videoMatch.docs.some((d) => d.ref.path.startsWith(`users/${uid}/personalPlaylists/`))) return true;

  const docMatch = await adminDb
    .collection("users")
    .doc(uid)
    .collection("personalDocuments")
    .where("driveFileId", "==", fileId)
    .where("driveConnectionId", "==", connectionId)
    .limit(1)
    .get();
  return !docMatch.empty;
}
