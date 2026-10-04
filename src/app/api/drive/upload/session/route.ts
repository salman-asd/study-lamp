import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import {
  isSupportedUploadMimeType,
  isValidDriveConnectionId,
  MAX_UPLOAD_BYTES,
  sanitizeDriveFileName,
  startResumableUpload,
} from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";

// Step 1 of "Upload to Drive" (Phase 15). Returns a Drive resumable-upload
// session URL; the browser then PUTs the file bytes straight to Google,
// bypassing our server for the actual (possibly large) upload. Once that PUT
// finishes, Google's response body is the new file's metadata, and the
// client registers it with POST /api/drive/import/file exactly like a
// Picker-selected file.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:upload-session", limit: 10 })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const name = typeof body.name === "string" ? sanitizeDriveFileName(body.name) : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  const sizeBytes = body.sizeBytes;
  if (!isValidDriveConnectionId(connectionId)) {
    return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });
  }
  if (!name || name.length > 200 || !isSupportedUploadMimeType(mimeType)) {
    return NextResponse.json({ error: "A supported filename and MIME type are required." }, { status: 400 });
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File size must be between 1 byte and 2 GB." }, { status: 400 });
  }

  try {
    const uploadUrl = await withDriveAccessToken(uid, connectionId, (accessToken) => (
      startResumableUpload(accessToken, { name, mimeType, sizeBytes })
    ));
    return NextResponse.json({ uploadUrl });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Failed to start Drive upload session", err);
    return NextResponse.json({ error: "Couldn't start the upload to Drive." }, { status: 502 });
  }
}
