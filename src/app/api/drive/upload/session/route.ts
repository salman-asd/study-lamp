import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { startResumableUpload } from "@/lib/server/googleDrive";

// Step 1 of "Upload to Drive" (Phase 15). Returns a Drive resumable-upload
// session URL; the browser then PUTs the file bytes straight to Google,
// bypassing our server for the actual (possibly large) upload. Once that PUT
// finishes, Google's response body is the new file's metadata, and the
// client registers it with POST /api/drive/import/file exactly like a
// Picker-selected file.
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
  const name = typeof body.name === "string" ? body.name : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
  if (!connectionId || !name) {
    return NextResponse.json({ error: "connectionId and name are required." }, { status: 400 });
  }

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const uploadUrl = await startResumableUpload(accessToken, { name, mimeType });
    return NextResponse.json({ uploadUrl });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Failed to start Drive upload session", err);
    return NextResponse.json({ error: "Couldn't start the upload to Drive." }, { status: 502 });
  }
}
