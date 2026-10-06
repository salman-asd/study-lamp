import { NextResponse } from "next/server";
import { getGoogleSyncStatus } from "@/lib/server/googleConnections";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid, req }) => {
  const connectionId = new URL(req.url).searchParams.get("connectionId");
  try {
    const status = await getGoogleSyncStatus(uid, connectionId);
    return NextResponse.json(status);
  } catch (error) {
    return syncErrorResponse("google sync status", error);
  }
}, { scope: "googleSync", preset: "googleSync", limit: 60, tooManyMessage: "Too many status checks. Please slow down." });
