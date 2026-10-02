import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { deleteDriveConnection } from "@/lib/server/driveConnections";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:connections-delete" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });
  if (!isValidDriveConnectionId(params.id)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  const deleted = await deleteDriveConnection(uid, params.id);
  if (!deleted) return NextResponse.json({ error: "Connection not found." }, { status: 404 });

  // Deliberately does not touch already-imported videos/documents that
  // reference this connection — see deleteDriveConnection's doc comment.
  return NextResponse.json({ ok: true });
}
