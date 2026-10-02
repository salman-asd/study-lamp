import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata, listFolderVideoFiles, isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { createPlaylistAdmin, bulkAddDriveVideosAdmin } from "@/lib/server/driveImport";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { fetchAndSaveDriveThumbnails } from "@/lib/server/driveThumbnails";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";

// Imports a picked Drive folder as a new playlist, one video per file in the
// folder (direct children only — no recursive sub-folders, matching Phase
// 14's "one level" design). The playlist's category is left for the user to
// set from the normal playlist-rename dialog afterward; see the note in
// README-drive.md about the AI category-suggestion step this phase skipped.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:import-folder", preset: "import" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const folderId = typeof body.folderId === "string" ? body.folderId : "";
  if (!isValidDriveConnectionId(connectionId) || !isValidDriveId(folderId)) {
    return NextResponse.json({ error: "Valid connectionId and folderId are required." }, { status: 400 });
  }

  try {
    const { folderMeta, files } = await withDriveAccessToken(uid, connectionId, async (accessToken) => ({
      folderMeta: await getFileMetadata(accessToken, folderId),
      files: await listFolderVideoFiles(accessToken, folderId),
    }));

    if (files.length === 0) {
      return NextResponse.json({ error: `"${folderMeta.name}" doesn't contain any video files.` }, { status: 422 });
    }

    // Thumbnail bytes are stored server-side (driveThumbs, concurrency 5); the
    // video docs below only carry the marker. Never fails the import.
    await fetchAndSaveDriveThumbnails(
      uid,
      connectionId,
      files.map((file) => ({ fileId: file.id, thumbnailLink: file.thumbnailLink })),
      (operation) => withDriveAccessToken(uid, connectionId, operation),
    );

    const playlistId = await createPlaylistAdmin(uid, folderMeta.name);
    const added = await bulkAddDriveVideosAdmin(
      uid,
      playlistId,
      files.map((f) => ({
        title: f.name,
        videoUrl: `https://drive.google.com/file/d/${f.id}/view`,
        thumbnailUrl: driveThumbnailMarker(f.id, connectionId),
        durationSeconds: f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: f.id,
        driveConnectionId: connectionId,
        thumbnailAttempted: true,
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
