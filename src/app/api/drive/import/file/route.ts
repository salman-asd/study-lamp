import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata, documentFileTypeFromMime, SUPPORTED_VIDEO_MIME_PREFIX } from "@/lib/server/googleDrive";
import { addDriveVideoAdmin, addDriveDocumentAdmin, getOrCreateUnsortedPlaylistAdmin } from "@/lib/server/driveImport";

// Imports a single file the user picked via the Google Picker (Phase 14), or
// one just finished uploading straight to Drive from the browser (Phase 15
// — see /api/drive/upload/session). Either flow ends up here to register the
// Drive file as a PersonalVideo or PersonalDocument.
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
  const fileId = typeof body.fileId === "string" ? body.fileId : "";
  const playlistId = typeof body.playlistId === "string" ? body.playlistId : undefined;
  if (!connectionId || !fileId) {
    return NextResponse.json({ error: "connectionId and fileId are required." }, { status: 400 });
  }

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const meta = await getFileMetadata(accessToken, fileId);

    if (meta.mimeType.startsWith(SUPPORTED_VIDEO_MIME_PREFIX)) {
      const targetPlaylistId = playlistId || (await getOrCreateUnsortedPlaylistAdmin(uid));
      const videoId = await addDriveVideoAdmin(uid, targetPlaylistId, {
        title: meta.name,
        videoUrl: `https://drive.google.com/file/d/${meta.id}/view`,
        thumbnailUrl: `/api/drive/thumbnail/${meta.id}?connectionId=${connectionId}`,
        durationSeconds: meta.videoMediaMetadata?.durationMillis ? Math.round(Number(meta.videoMediaMetadata.durationMillis) / 1000) : 0,
        driveFileId: meta.id,
        driveConnectionId: connectionId,
      });
      return NextResponse.json({ kind: "video", playlistId: targetPlaylistId, videoId });
    }

    const fileType = documentFileTypeFromMime(meta.mimeType);
    if (fileType) {
      const documentId = await addDriveDocumentAdmin(uid, {
        title: meta.name,
        fileType,
        mimeType: meta.mimeType,
        sizeBytes: meta.size ? Number(meta.size) : null,
        driveFileId: meta.id,
        driveConnectionId: connectionId,
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
