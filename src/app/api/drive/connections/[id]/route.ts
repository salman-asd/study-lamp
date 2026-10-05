import { NextResponse } from "next/server";
import { deleteDriveConnection } from "@/lib/server/driveConnections";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  if (!isValidDriveConnectionId(params.id)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  const deleted = await deleteDriveConnection(uid, params.id);
  if (!deleted) return NextResponse.json({ error: "Connection not found." }, { status: 404 });

  // Deliberately does not touch already-imported videos/documents that
  // reference this connection — see deleteDriveConnection's doc comment.
  return NextResponse.json({ ok: true });
}, { scope: "drive:connections-delete" });
