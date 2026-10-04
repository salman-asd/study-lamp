import { NextResponse } from "next/server";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { downloadJsonFile, isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { previewRestore, restoreBackup, type BackupPayload } from "@/lib/server/driveBackup";
import { withAuthedRoute, readJsonObject } from "@/lib/server/routeHelpers";

// Two-step by design (Phase 17): { confirm: false | omitted } only previews
// what would change; { confirm: true } is the one call that actually
// writes. The UI (src/app/settings/backup/page.tsx) always calls this once
// without confirm to show counts, then again with confirm only after the
// user clicks through a dialog — never silently.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Heavy Drive work; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsedBody = await readJsonObject(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  const fileId = typeof body.fileId === "string" ? body.fileId : "";
  const confirm = body.confirm === true;
  if (!isValidDriveConnectionId(connectionId) || !isValidDriveId(fileId)) {
    return NextResponse.json({ error: "Valid connectionId and fileId are required." }, { status: 400 });
  }

  try {
    const raw = await withDriveAccessToken(uid, connectionId, (accessToken) => downloadJsonFile(accessToken, fileId));
    const payload = raw as BackupPayload;
    if (payload?.version !== 1 || !Array.isArray(payload.playlists)) {
      return NextResponse.json({ error: "That file doesn't look like a Study Lamp backup." }, { status: 422 });
    }
    if (payload.ownerId !== uid) {
      return NextResponse.json({ error: "This backup belongs to a different Study Lamp account." }, { status: 403 });
    }

    const result = confirm ? await restoreBackup(uid, payload) : await previewRestore(uid, payload);
    return NextResponse.json({ confirmed: confirm, ...result });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Drive restore failed", err);
    return NextResponse.json({ error: "Couldn't restore from that backup." }, { status: 502 });
  }
}, { scope: "drive:backup-restore" });
