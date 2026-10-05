import { NextResponse } from "next/server";
import { listGoogleConnections } from "@/lib/server/googleConnections";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid }) => {
  const connections = await listGoogleConnections(uid);
  return NextResponse.json({ connections });
}, { scope: "googleSync", preset: "googleSync", limit: 30, tooManyMessage: "Too many connection reads. Please slow down." });
