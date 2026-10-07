import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createRemovalPreviewHandler } from "@/lib/server/syncRemovalHandlers";
import { realRemovalRouteDeps } from "@/lib/server/syncRemovalDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PREVIEW of an explicit removal. Performs ZERO writes and makes no Google call (Global Rule 15): it only counts the
 * events/tasks recorded in this user's own mapping docs and signs a "remove" plan token over them.
 */
export const POST = withAuthedRoute(createRemovalPreviewHandler(realRemovalRouteDeps), {
  scope: "googleSync",
  preset: "googleSync",
  limit: 30,
  tooManyMessage: "Too many removal previews. Please slow down.",
});
