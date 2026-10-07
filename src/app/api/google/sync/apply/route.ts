import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createSyncApplyHandler } from "@/lib/server/syncRouteHandlers";
import { realSyncApplyDeps } from "@/lib/server/syncRouteDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * APPLY. Verifies the plan token, re-reads CURRENT goals, mappings and LIVE Google data, recomputes the plan and
 * lets the confirmation gate decide. `target` ("calendar" default | "tasks") picks the plan the token belongs to.
 * Content sent to Google is built on the server from stored goals; the request body only says which plan items
 * the user accepted and how they resolved conflicts. After a successful apply, spent token docs are pruned
 * (fire-and-forget). The logic lives in syncRouteHandlers.ts so it can be tested with fakes.
 */
export const POST = withAuthedRoute(createSyncApplyHandler(realSyncApplyDeps), {
  scope: "googleApply",
  preset: "googleApply",
  limit: 20,
  tooManyMessage: "Too many sync applies. Please slow down.",
});
