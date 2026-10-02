import { NextRequest, NextResponse } from "next/server";
import { getAccessTokenForConnection, withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { getFileMetadata } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { createDriveTiming, type DriveTiming } from "@/lib/server/timing";
import { verifyDriveUrl } from "@/lib/server/driveSignedUrl";
import { fetchAndStoreDriveThumbnail, readStoredDriveThumbnail, saveDriveThumbnailReference } from "@/lib/server/driveThumbnails";

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
  if (!checkRateLimit(uid, { scope: "drive:thumbnail" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  try {
    let image = await timing.measure("stored_read_ms", () => readStoredDriveThumbnail(uid, params.fileId, connectionId));
    if (!image) {
      const stored = await withDriveAccessToken(uid, connectionId, async (accessToken) => {
        const meta = await timing.measure("metadata_ms", () => getFileMetadata(accessToken, params.fileId));
        return timing.measure("upstream_ms", () => (
          fetchAndStoreDriveThumbnail(accessToken, meta.thumbnailLink)
        ));
      }, () => timing.measure("token_ms", () => getAccessTokenForConnection(uid, connectionId)));
      await saveDriveThumbnailReference(uid, params.fileId, connectionId, stored);
      image = await timing.measure("stored_read_ms", () => readStoredDriveThumbnail(uid, params.fileId, connectionId));
    }
    if (!image) return NextResponse.json({ error: "No thumbnail available." }, { status: 404 });

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
    console.error("Drive thumbnail proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
