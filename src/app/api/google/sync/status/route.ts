import { NextResponse } from "next/server";
import { getGoogleSyncStatus } from "@/lib/server/googleConnections";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid }) => {
  const status = await getGoogleSyncStatus(uid);
  return NextResponse.json(status);
}, { scope: "googleSync", preset: "googleSync", limit: 60, tooManyMessage: "Too many status checks. Please slow down." });
