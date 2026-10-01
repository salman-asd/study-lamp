import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata, fetchThumbnail } from "@/lib/server/googleDrive";
import { ownsDriveFile } from "@/lib/server/driveOwnership";

interface RouteParams {
  params: { fileId: string };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });

  const allowed = await ownsDriveFile(uid, params.fileId, connectionId);
  if (!allowed) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const meta = await getFileMetadata(accessToken, params.fileId);
    if (!meta.thumbnailLink) return NextResponse.json({ error: "No thumbnail available." }, { status: 404 });

    const upstream = await fetchThumbnail(accessToken, meta.thumbnailLink);
    if (!upstream.ok) return NextResponse.json({ error: "Couldn't load the thumbnail." }, { status: 502 });

    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set("Cache-Control", "private, max-age=3600");
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Drive thumbnail proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
