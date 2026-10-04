import { NextResponse } from "next/server";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getOrCreateBackupFolder, isValidDriveConnectionId, uploadJsonFile } from "@/lib/server/googleDrive";
import { buildBackupPayload } from "@/lib/server/driveBackup";
import { withAuthedRoute, readJsonObject } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Heavy Drive work; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!isValidDriveConnectionId(connectionId)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  try {
    const payload = await buildBackupPayload(uid);
    const name = `study-lamp-backup-${payload.createdAt.slice(0, 10)}-${Date.now()}.json`;
    const file = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
      const folderId = await getOrCreateBackupFolder(accessToken);
      return uploadJsonFile(accessToken, folderId, name, payload);
    });
    return NextResponse.json({
      fileId: file.id,
      name: file.name,
      createdAt: payload.createdAt,
      counts: {
        playlists: payload.playlists.length,
        videos: payload.playlists.reduce((sum, p) => sum + p.videos.length, 0),
        notes: payload.notes.length,
        summaries: payload.summaries.length,
        goals: payload.goals.length,
        quizAttempts: payload.quizAttempts.length,
      },
    });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Drive backup failed", err);
    return NextResponse.json({ error: "Couldn't back up to Drive." }, { status: 502 });
  }
}, { scope: "drive:backup" });
