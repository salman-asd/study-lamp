import { NextResponse } from "next/server";
import { listDriveConnections } from "@/lib/server/driveConnections";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid }) => {
  const connections = await listDriveConnections(uid);
  return NextResponse.json({ connections });
}, { scope: "drive:connections" });
