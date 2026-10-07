import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createSyncPlanHandler } from "@/lib/server/syncRouteHandlers";
import { realSyncPlanDeps } from "@/lib/server/syncRouteDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * PREVIEW. Performs ZERO writes: no Google write, no goal write, no Firestore mapping or sync-state write
 * (Global Rule 15). `targets` defaults to ["calendar"]; Tasks is planned only when asked for explicitly.
 * Response: the Calendar plan at the top level (unchanged shape) plus an optional `tasks` plan.
 * The logic lives in syncRouteHandlers.ts so it can be tested with fakes.
 */
export const POST = withAuthedRoute(createSyncPlanHandler(realSyncPlanDeps), {
  scope: "googleSync",
  preset: "googleSync",
  limit: 30,
  tooManyMessage: "Too many sync checks. Please slow down.",
});
