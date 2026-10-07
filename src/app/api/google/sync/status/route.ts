import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createSyncStatusHandler } from "@/lib/server/syncRouteHandlers";
import { realSyncStatusDeps } from "@/lib/server/syncRouteDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Counts come from our own docs only (no Google call). `?target=tasks` returns the Tasks status; default is Calendar. */
export const GET = withAuthedRoute(createSyncStatusHandler(realSyncStatusDeps), {
  scope: "googleSync",
  preset: "googleSync",
  limit: 60,
  tooManyMessage: "Too many status checks. Please slow down.",
});
