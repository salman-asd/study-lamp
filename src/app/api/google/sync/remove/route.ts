import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createRemovalApplyHandler } from "@/lib/server/syncRemovalHandlers";
import { realRemovalRouteDeps } from "@/lib/server/syncRemovalDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Explicit REMOVAL of events/tasks Study Lamp created. Needs a "remove" plan token and the exact `confirmCount`.
 * Deletes only remote ids found in this user's own mapping docs, paced in chunks of 25. Never automatic.
 */
export const POST = withAuthedRoute(createRemovalApplyHandler(realRemovalRouteDeps), {
  scope: "googleApply",
  preset: "googleApply",
  limit: 20,
  tooManyMessage: "Too many removals. Please slow down.",
});
