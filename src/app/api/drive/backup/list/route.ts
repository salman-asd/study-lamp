import { NextResponse } from "next/server";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { driveRouteErrorResponse } from "@/lib/server/driveRouteError";
import { getOrCreateBackupFolder, listBackupFiles } from "@/lib/server/googleDrive";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid, req }) => {
  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!isValidDriveConnectionId(connectionId)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  try {
    const files = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
      const folderId = await getOrCreateBackupFolder(accessToken);
      return listBackupFiles(accessToken, folderId);
    });
    return NextResponse.json({ backups: files.map((f) => ({ fileId: f.id, name: f.name })) });
  } catch (err) {
    return driveRouteErrorResponse(uid, connectionId, err, { logLabel: "Listing Drive backups failed", fallbackMessage: "Couldn't list backups from Drive." });
  }
}, { scope: "drive:backup-list" });
