import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { fetchFileContent } from "@/lib/server/googleDrive";
import { ownsDriveFile } from "@/lib/server/driveOwnership";

interface RouteParams {
  params: { fileId: string };
}

// Secure playback/download proxy (Phase 16): VideoPlayer and the Study
// Materials viewer point a plain <video>/<iframe>/<a download> at this URL
// instead of ever receiving a Drive URL or access token directly. Every
// request is (a) authenticated via the caller's own Firebase ID token and
// (b) checked against ownsDriveFile before a single byte is streamed.
//
// Range headers are forwarded both ways so seeking/resuming a large video
// works exactly like any other platform — the browser's own <video> element
// issues ranged requests automatically once it sees Accept-Ranges: bytes.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = req.nextUrl.searchParams.get("connectionId");
  const download = req.nextUrl.searchParams.get("download") === "1";
  if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });

  const allowed = await ownsDriveFile(uid, params.fileId, connectionId);
  if (!allowed) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const upstream = await fetchFileContent(accessToken, params.fileId, req.headers.get("range"));

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: "Google Drive couldn't serve this file." }, { status: upstream.status === 404 ? 404 : 502 });
    }

    const headers = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "private, max-age=0, no-store");
    if (download) headers.set("Content-Disposition", "attachment");

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Drive stream proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
