import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { pruneUnreferencedThumbnails } from "@/lib/server/driveThumbnailPrune";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRUNE_BATCH = 50;

/** `{ "dryRun": true }` in the body counts what would be removed without deleting anything. */
async function wantsDryRun(req: Request): Promise<boolean> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && (body as { dryRun?: unknown }).dryRun === true;
  } catch {
    return false; // no body / not JSON: a normal prune call
  }
}

/**
 * Deletes up to 50 driveThumbs docs that no video or document of this user references any more.
 * Call again while `remaining` > 0. A thumbnail still used by another record is never removed.
 * With `{ "dryRun": true }` nothing is deleted and `remaining` is the number that could be removed.
 */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  try {
    const dryRun = await wantsDryRun(req);
    const result = await pruneUnreferencedThumbnails(uid, dryRun ? 0 : PRUNE_BATCH);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Drive thumbnail prune failed", error);
    return NextResponse.json({ error: "Couldn't clean up Drive thumbnails." }, { status: 500 });
  }
}, { scope: "drive:thumbnail-prune", limit: 30 });
