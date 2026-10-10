import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { countFailedThumbnails, listFailedThumbnailTargets, resetThumbnailAttempts } from "@/lib/server/driveThumbnails";
import { RETRY_FAILED_BATCH, limitRetryTargets } from "@/lib/driveThumbnailStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Makes up to 50 failed thumbnail items "never attempted" again, so the next
 * "Fetch missing thumbnails" run tries them. Call again while `remaining` > 0.
 * Only clears the attempt flags; nothing is deleted.
 */
export const POST = withAuthedRoute(async ({ uid }) => {
  try {
    const targets = limitRetryTargets(await listFailedThumbnailTargets(uid, RETRY_FAILED_BATCH));
    const reset = await resetThumbnailAttempts(targets);
    const remaining = reset === 0 ? 0 : await countFailedThumbnails(uid);
    return NextResponse.json({ reset, remaining }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Drive thumbnail retry failed", error);
    return NextResponse.json({ error: "Couldn't reset the failed thumbnails." }, { status: 500 });
  }
}, { scope: "drive:thumbnail-retry", limit: 30 });
