import { NextRequest, NextResponse } from "next/server";
import { getAccessTokenForConnection, withDriveAccessToken, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { fetchFileContent } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { createDriveTiming, type DriveTiming } from "@/lib/server/timing";
import { verifyDriveUrl, type DriveUrlPurpose } from "@/lib/server/driveSignedUrl";

interface RouteParams {
  params: { fileId: string };
}

// Signed capability URLs let native media elements fetch this proxy without
// exposing Firebase or Google tokens. The signature binds the file,
// connection, purpose, and user until the URL expires.
//
// Range headers are forwarded both ways so seeking/resuming a large video
// works exactly like any other platform — the browser's own <video> element
// issues ranged requests automatically once it sees Accept-Ranges: bytes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stay within the route duration supported by the deployment plan.
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: RouteParams) {
  const timing = createDriveTiming("stream");
  try {
    return await getStreamResponse(req, params, timing);
  } finally {
    timing.log();
  }
}

async function getStreamResponse(req: NextRequest, params: RouteParams["params"], timing: DriveTiming) {
  const uid = req.nextUrl.searchParams.get("u") || "";
  const connectionId = req.nextUrl.searchParams.get("c") || "";
  const exp = Number(req.nextUrl.searchParams.get("e"));
  const purpose = req.nextUrl.searchParams.get("p") as DriveUrlPurpose | null;
  const sig = req.nextUrl.searchParams.get("s") || "";
  const exportPurpose = purpose === "export" || purpose === "export_download";
  const allowedPurpose = purpose === "stream" || purpose === "download" || exportPurpose;
  if (!purpose || !allowedPurpose) {
    return NextResponse.json({ error: "Invalid or expired Drive URL." }, { status: 401 });
  }
  const validSignature = await timing.measure("signature_ms", async () => (
    verifyDriveUrl({ uid, fileId: params.fileId, connectionId, purpose, exp, sig })
  ));
  if (!validSignature) {
    return NextResponse.json({ error: "Invalid or expired Drive URL." }, { status: 401 });
  }
  if (!checkRateLimit(uid, { scope: "drive:stream", preset: "stream" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  const download = purpose === "download" || purpose === "export_download";

  try {
    const upstream = await withDriveAccessToken(
      uid,
      connectionId,
      async (accessToken) => {
        if (exportPurpose) {
          const metadata = await import("@/lib/server/googleDrive").then(({ getFileMetadata, nativeExportMime }) => getFileMetadata(accessToken, params.fileId).then((meta) => ({
            meta,
            exportMime: nativeExportMime(meta.mimeType),
          })));
          if (!metadata.exportMime) {
            throw new Error("This Drive file isn't a supported Google native document.");
          }
          return timing.measure("upstream_ms", () => import("@/lib/server/googleDrive").then(({ exportFile }) => exportFile(accessToken, params.fileId, metadata.exportMime!)));
        }
        return timing.measure("upstream_ms", () => fetchFileContent(accessToken, params.fileId, req.headers.get("range")));
      },
      () => timing.measure("token_ms", () => getAccessTokenForConnection(uid, connectionId)),
    );

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: "Google Drive couldn't serve this file." }, { status: upstream.status === 404 ? 404 : 502 });
    }

    const headers = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    const contentType = (upstream.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "private, max-age=0, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    if (download || !(contentType.startsWith("video/") || contentType === "application/pdf" || contentType.startsWith("image/"))) {
      headers.set("Content-Disposition", "attachment");
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    logServerError("Drive stream proxy failed", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
