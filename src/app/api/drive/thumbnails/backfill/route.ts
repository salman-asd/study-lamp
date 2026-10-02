import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";
import {
  fetchAndStoreDriveThumbnail,
  listDriveThumbnailBackfillTargets,
  saveThumbnailReferenceForTarget,
} from "@/lib/server/driveThumbnails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_SIZE = 25;
const CONCURRENCY = 5;

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:thumbnail-backfill" })) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  try {
    const candidates = await listDriveThumbnailBackfillTargets(uid);
    const batch = candidates.slice(0, BATCH_SIZE);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (cursor < batch.length) {
        const target = batch[cursor++];
        try {
          const stored = await withDriveAccessToken(uid, target.connectionId, async (accessToken) => {
            const metadata = await getFileMetadata(accessToken, target.fileId);
            return fetchAndStoreDriveThumbnail(accessToken, metadata.thumbnailLink);
          });
          await saveThumbnailReferenceForTarget(target, stored);
        } catch (error) {
          if (!(error instanceof DriveConnectionError)) {
            console.error("Drive thumbnail backfill item failed", error);
          }
          await saveThumbnailReferenceForTarget(target, null).catch(() => undefined);
        }
      }
    }));

    return NextResponse.json({ processed: batch.length, remaining: Math.max(0, candidates.length - batch.length) });
  } catch (error) {
    console.error("Drive thumbnail backfill failed", error);
    return NextResponse.json({ error: "Couldn't refresh Drive thumbnails." }, { status: 500 });
  }
}