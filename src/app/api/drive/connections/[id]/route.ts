import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { deleteDriveConnection } from "@/lib/server/driveConnections";

interface RouteParams {
  params: { id: string };
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const deleted = await deleteDriveConnection(uid, params.id);
  if (!deleted) return NextResponse.json({ error: "Connection not found." }, { status: 404 });

  // Deliberately does not touch already-imported videos/documents that
  // reference this connection — see deleteDriveConnection's doc comment.
  return NextResponse.json({ ok: true });
}
