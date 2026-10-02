import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getOrCreateBackupFolder, listBackupFiles } from "@/lib/server/googleDrive";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:backup-list" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!isValidDriveConnectionId(connectionId)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  try {
    const files = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
      const folderId = await getOrCreateBackupFolder(accessToken);
      return listBackupFiles(accessToken, folderId);
    });
    return NextResponse.json({ backups: files.map((f) => ({ fileId: f.id, name: f.name })) });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Listing Drive backups failed", err);
    return NextResponse.json({ error: "Couldn't list backups from Drive." }, { status: 502 });
  }
}
