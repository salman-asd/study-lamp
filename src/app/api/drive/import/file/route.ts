import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata, documentFileTypeFromMime, SUPPORTED_VIDEO_MIME_PREFIX, isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { addDriveVideoAdmin, addDriveDocumentAdmin, getOrCreateUnsortedPlaylistAdmin } from "@/lib/server/driveImport";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { fetchAndSaveDriveThumbnails } from "@/lib/server/driveThumbnails";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";

// Imports a single file the user picked via the Google Picker (Phase 14), or
// one just finished uploading straight to Drive from the browser (Phase 15
// — see /api/drive/upload/session). Either flow ends up here to register the
// Drive file as a PersonalVideo or PersonalDocument.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Adjust to the deployment plan limit.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:import-file", preset: "import" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const fileId = typeof body.fileId === "string" ? body.fileId : "";
  const playlistId = typeof body.playlistId === "string" ? body.playlistId : undefined;
  if (!isValidDriveConnectionId(connectionId) || !isValidDriveId(fileId)) {
    return NextResponse.json({ error: "Valid connectionId and fileId are required." }, { status: 400 });
  }

  try {
    const meta = await withDriveAccessToken(uid, connectionId, (accessToken) => getFileMetadata(accessToken, fileId));

    if (meta.mimeType.startsWith(SUPPORTED_VIDEO_MIME_PREFIX)) {
      const targetPlaylistId = playlistId || (await getOrCreateUnsortedPlaylistAdmin(uid));
      // Bytes go to the server-only driveThumbs collection; the video doc only
      // keeps the marker. A thumbnail failure never fails the import.
      await fetchAndSaveDriveThumbnails(uid, connectionId, [{ fileId: meta.id, thumbnailLink: meta.thumbnailLink }], (operation) => (
        withDriveAccessToken(uid, connectionId, operation)
      ));
      const videoId = await addDriveVideoAdmin(uid, targetPlaylistId, {
        title: meta.name,
        videoUrl: `https://drive.google.com/file/d/${meta.id}/view`,
        thumbnailUrl: driveThumbnailMarker(meta.id, connectionId),
        durationSeconds: meta.videoMediaMetadata?.durationMillis ? Math.round(Number(meta.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: meta.id,
        driveConnectionId: connectionId,
        thumbnailAttempted: true,
      });
      return NextResponse.json({ kind: "video", playlistId: targetPlaylistId, videoId });
    }

    const fileType = documentFileTypeFromMime(meta.mimeType);
    if (fileType) {
      await fetchAndSaveDriveThumbnails(uid, connectionId, [{ fileId: meta.id, thumbnailLink: meta.thumbnailLink }], (operation) => (
        withDriveAccessToken(uid, connectionId, operation)
      ));
      const documentId = await addDriveDocumentAdmin(uid, {
        title: meta.name,
        fileType,
        mimeType: meta.mimeType,
        sizeBytes: meta.size ? Number(meta.size) : null,
        driveFileId: meta.id,
        driveConnectionId: connectionId,
        md5Checksum: meta.md5Checksum ?? null,
        modifiedTime: meta.modifiedTime ?? null,
        thumbnailUrl: driveThumbnailMarker(meta.id, connectionId),
        thumbnailAttempted: true,
      });
      return NextResponse.json({ kind: "document", documentId });
    }

    return NextResponse.json({ error: `"${meta.name}" isn't a video or a supported document type (PDF, Word, PowerPoint, Excel).` }, { status: 422 });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    if (err instanceof Error && err.message.startsWith("Drive can't access that file.")) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("Drive file import failed", err);
    return NextResponse.json({ error: "Couldn't import that file from Drive." }, { status: 502 });
  }
}
