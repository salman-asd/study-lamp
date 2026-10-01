import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { getOrCreateBackupFolder, listBackupFiles } from "@/lib/server/googleDrive";

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    const folderId = await getOrCreateBackupFolder(accessToken);
    const files = await listBackupFiles(accessToken, folderId);
    return NextResponse.json({ backups: files.map((f) => ({ fileId: f.id, name: f.name })) });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Listing Drive backups failed", err);
    return NextResponse.json({ error: "Couldn't list backups from Drive." }, { status: 502 });
  }
}
