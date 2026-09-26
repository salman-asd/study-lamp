import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata, listFolderVideoFiles } from "@/lib/server/googleDrive";
import { createPlaylistAdmin, bulkAddDriveVideosAdmin } from "@/lib/server/driveImport";

// Imports a picked Drive folder as a new playlist, one video per file in the
// folder (direct children only — no recursive sub-folders, matching Phase
// 14's "one level" design). The playlist's category is left for the user to
// set from the normal playlist-rename dialog afterward; see the note in
// README-drive.md about the AI category-suggestion step this phase skipped.
export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const folderId = typeof body.folderId === "string" ? body.folderId : "";
  if (!connectionId || !folderId) {
    return NextResponse.json({ error: "connectionId and folderId are required." }, { status: 400 });
  }

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const folderMeta = await getFileMetadata(accessToken, folderId);
    const files = await listFolderVideoFiles(accessToken, folderId);

    if (files.length === 0) {
      return NextResponse.json({ error: `"${folderMeta.name}" doesn't contain any video files.` }, { status: 422 });
    }

    const playlistId = await createPlaylistAdmin(uid, folderMeta.name);
    const added = await bulkAddDriveVideosAdmin(
      uid,
      playlistId,
      files.map((f) => ({
        title: f.name,
        videoUrl: `https://drive.google.com/file/d/${f.id}/view`,
        thumbnailUrl: `/api/drive/thumbnail/${f.id}?connectionId=${connectionId}`,
        durationSeconds: f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: f.id,
        driveConnectionId: connectionId,
      }))
    );

    return NextResponse.json({ playlistId, videoCount: added });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Drive folder import failed", err);
    return NextResponse.json({ error: "Couldn't import that folder from Drive." }, { status: 502 });
  }
}
