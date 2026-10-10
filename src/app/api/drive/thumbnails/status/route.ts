import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { countFailedThumbnails, countLegacyThumbnails, countUnattemptedThumbnails } from "@/lib/server/driveThumbnails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Counts for the Drive thumbnails card: { missing, failed, legacy }.
 * Aggregate count() queries only (one small read per ~1000 matching docs), no document is downloaded.
 * `missing` only sees items that already carry `thumbnailAttemptedAt`; items from before that field
 * existed are picked up by the first "Fetch missing thumbnails" run, which normalises them.
 */
export const GET = withAuthedRoute(async ({ uid }) => {
  try {
    const [missing, failed, legacy] = await Promise.all([
      countUnattemptedThumbnails(uid),
      countFailedThumbnails(uid),
      countLegacyThumbnails(uid),
    ]);
    return NextResponse.json({ missing, failed, legacy }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    logServerError("Drive thumbnail status failed", error);
    return NextResponse.json({ error: "Couldn't read Drive thumbnail status." }, { status: 500 });
  }
}, { scope: "drive:thumbnail-status", limit: 30 });
