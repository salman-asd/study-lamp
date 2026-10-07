import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createSyncHistoryHandler } from "@/lib/server/syncRemovalHandlers";
import { realSyncHistoryDeps } from "@/lib/server/syncRemovalDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** READ-ONLY. The newest 50 sync log entries (goal-level fields only), newest first, paged with `?cursor=`. */
export const GET = withAuthedRoute(createSyncHistoryHandler(realSyncHistoryDeps), {
  scope: "googleSync",
  preset: "googleSync",
  limit: 60,
  tooManyMessage: "Too many history requests. Please slow down.",
});
