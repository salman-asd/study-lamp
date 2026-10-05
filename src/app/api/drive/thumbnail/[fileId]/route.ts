import { NextRequest, NextResponse } from "next/server";
import { getAccessTokenForConnection, withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { getFileMetadata } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { createDriveTiming, type DriveTiming } from "@/lib/server/timing";
import { verifyDriveUrl } from "@/lib/server/driveSignedUrl";
import {
  fetchAndStoreDriveThumbnail,
  lookupStoredDriveThumbnail,
  markDriveThumbnailMissing,
  saveDriveThumbnail,
  type DriveThumbnailImage,
} from "@/lib/server/driveThumbnails";

interface RouteParams {
  params: { fileId: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: RouteParams) {
  const timing = createDriveTiming("thumbnail");
  try {
    return await getThumbnailResponse(req, params, timing);
  } finally {
    timing.log();
  }
}

async function getThumbnailResponse(req: NextRequest, params: RouteParams["params"], timing: DriveTiming) {
  const uid = req.nextUrl.searchParams.get("u") || "";
  const connectionId = req.nextUrl.searchParams.get("c") || "";
  const exp = Number(req.nextUrl.searchParams.get("e"));
  const purpose = req.nextUrl.searchParams.get("p");
  const sig = req.nextUrl.searchParams.get("s") || "";
  const validSignature = purpose === "thumb" && await timing.measure("signature_ms", async () => (
    verifyDriveUrl({ uid, fileId: params.fileId, connectionId, purpose, exp, sig })
  ));
  if (!validSignature) {
    return NextResponse.json({ error: "Invalid or expired Drive URL." }, { status: 401 });
  }
  if (!checkRateLimit(uid, { scope: "drive:thumbnail", preset: "thumbnail" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  try {
    const lookup = await timing.measure("stored_read_ms", () => lookupStoredDriveThumbnail(uid, params.fileId, connectionId));
    let image: DriveThumbnailImage | null = lookup.kind === "hit" ? lookup.image : null;
    if (lookup.kind === "missing" && lookup.recent) {
      // Google had no thumbnail a moment ago; don't ask Drive again on every request.
      return NextResponse.json({ error: "No thumbnail available." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    }
    if (!image) {
      // Self-heal: fetch from Google once, keep the bytes server-side, then serve them.
      image = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
        const meta = await timing.measure("metadata_ms", () => getFileMetadata(accessToken, params.fileId));
        return timing.measure("upstream_ms", () => (
          fetchAndStoreDriveThumbnail(accessToken, meta.thumbnailLink)
        ));
      }, () => timing.measure("token_ms", () => getAccessTokenForConnection(uid, connectionId)));
      if (image) await saveDriveThumbnail(uid, connectionId, params.fileId, image);
      else await markDriveThumbnailMissing(uid, connectionId, params.fileId).catch(() => undefined);
    }
    if (!image) return NextResponse.json({ error: "No thumbnail available." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });

    const headers = new Headers();
    const contentType = image.contentType.split(";")[0].trim().toLowerCase();
    headers.set("Content-Type", contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    if (!contentType.startsWith("image/")) headers.set("Content-Disposition", "attachment");
    headers.set("Cache-Control", "private, max-age=86400, immutable");
    return new NextResponse(Uint8Array.from(image.bytes), { status: 200, headers });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    logServerError("Drive thumbnail proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
