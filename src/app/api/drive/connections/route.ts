import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { listDriveConnections } from "@/lib/server/driveConnections";

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connections = await listDriveConnections(uid);
  return NextResponse.json({ connections });
}
