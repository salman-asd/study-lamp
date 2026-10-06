import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { pruneUnreferencedThumbnails } from "@/lib/server/driveThumbnailPrune";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRUNE_BATCH = 50;

/**
 * Deletes up to 50 driveThumbs docs that no video or document of this user references any more.
 * Call again while `remaining` > 0. A thumbnail still used by another record is never removed.
 */
export const POST = withAuthedRoute(async ({ uid }) => {
  try {
    const result = await pruneUnreferencedThumbnails(uid, PRUNE_BATCH);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Drive thumbnail prune failed", error);
    return NextResponse.json({ error: "Couldn't clean up Drive thumbnails." }, { status: 500 });
  }
}, { scope: "drive:thumbnail-prune", limit: 30 });
