import { NextResponse } from "next/server";
import { getGoogleSyncStatus, getGoogleTasksStatus } from "@/lib/server/googleConnections";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Counts come from our own docs only (no Google call). `?target=tasks` returns the Tasks status; default is Calendar. */
export const GET = withAuthedRoute(async ({ uid, req }) => {
  const params = new URL(req.url).searchParams;
  const connectionId = params.get("connectionId");
  try {
    const status = params.get("target") === "tasks" ? await getGoogleTasksStatus(uid, connectionId) : await getGoogleSyncStatus(uid, connectionId);
    return NextResponse.json(status);
  } catch (error) {
    return syncErrorResponse("google sync status", error);
  }
}, { scope: "googleSync", preset: "googleSync", limit: 60, tooManyMessage: "Too many status checks. Please slow down." });
