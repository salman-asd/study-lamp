import { NextResponse } from "next/server";
import { findOwnedDriveFiles, ownedKey } from "@/lib/server/driveOwnership";
import { isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { logServerError } from "@/lib/server/logError";
import { DriveSigningConfigError, signDriveUrl, type DriveUrlPurpose } from "@/lib/server/driveSignedUrl";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set<DriveUrlPurpose>(["stream", "download", "thumb", "export", "export_download"]);
const MAX_ITEMS = 50;

interface SignItem {
  fileId: string;
  connectionId: string;
  purpose: DriveUrlPurpose;
}

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `items must contain between 1 and ${MAX_ITEMS} entries.` }, { status: 400 });
  }

  const normalized: SignItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return NextResponse.json({ error: "Each item requires a valid fileId, connectionId, and purpose." }, { status: 400 });
    }
    const value = item as Record<string, unknown>;
    if (!isValidDriveId(value.fileId) || !isValidDriveConnectionId(value.connectionId) || !PURPOSES.has(value.purpose as DriveUrlPurpose)) {
      return NextResponse.json({ error: "Each item requires a valid fileId, connectionId, and purpose." }, { status: 400 });
    }
    normalized.push({ fileId: value.fileId, connectionId: value.connectionId, purpose: value.purpose as DriveUrlPurpose });
  }

  try {
    // One batched ownership lookup (cached for 60 s) instead of two queries per item.
    const owned = await findOwnedDriveFiles(uid, normalized);

    // Never fail the whole batch: one unowned/missing file only fails its own
    // entry, and the response keeps the request order.
    const urls = normalized.map((item) => {
      if (!owned.has(ownedKey(item))) return { ...item, error: "not_found" as const };
      const signed = signDriveUrl({ ...item, uid });
      const path = item.purpose === "thumb" ? "thumbnail" : "stream";
      const url = new URL(`/api/drive/${path}/${encodeURIComponent(item.fileId)}`, "https://signed-url.invalid");
      url.searchParams.set("c", item.connectionId);
      url.searchParams.set("u", uid);
      url.searchParams.set("e", String(signed.exp));
      url.searchParams.set("p", item.purpose);
      url.searchParams.set("s", signed.sig);
      return { ...item, url: `${url.pathname}${url.search}`, exp: signed.exp };
    });

    return NextResponse.json({ urls }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DriveSigningConfigError) {
      // Server misconfiguration: the same for every user, so say so instead of a vague 500.
      logServerError("Drive URL signing is not configured (set DRIVE_URL_SIGNING_SECRET)", error);
      return NextResponse.json({ error: "Drive URL signing is not configured on the server." }, { status: 503 });
    }
    logServerError("Failed to sign Drive URLs", error);
    return NextResponse.json({ error: "Couldn't prepare Drive URLs." }, { status: 500 });
  }
}, { scope: "drive:sign", preset: "sign" });