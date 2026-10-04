import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { listDriveConnections } from "@/lib/server/driveConnections";
import { checkRateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:connections" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  const connections = await listDriveConnections(uid);
  return NextResponse.json({ connections });
}
