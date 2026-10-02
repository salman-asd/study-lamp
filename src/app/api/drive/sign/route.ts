import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { checkRateLimit } from "@/lib/server/rateLimit";
import { ownsDriveFile } from "@/lib/server/driveOwnership";
import { isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";
import { signDriveUrl, type DriveUrlPurpose } from "@/lib/server/driveSignedUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set<DriveUrlPurpose>(["stream", "download", "thumb"]);
const MAX_ITEMS = 50;

interface SignItem {
  fileId: string;
  connectionId: string;
  purpose: DriveUrlPurpose;
}

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:sign" })) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });
  }

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
    const urls = await Promise.all(normalized.map(async (item) => {
      if (!await ownsDriveFile(uid, item.fileId, item.connectionId)) return null;
      const signed = signDriveUrl({ ...item, uid });
      const path = item.purpose === "thumb" ? "thumbnail" : "stream";
      const url = new URL(`/api/drive/${path}/${encodeURIComponent(item.fileId)}`, "https://signed-url.invalid");
      url.searchParams.set("c", item.connectionId);
      url.searchParams.set("u", uid);
      url.searchParams.set("e", String(signed.exp));
      url.searchParams.set("p", item.purpose);
      url.searchParams.set("s", signed.sig);
      return { ...item, url: `${url.pathname}${url.search}`, exp: signed.exp };
    }));

    if (urls.some((item) => item === null)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ urls }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Failed to sign Drive URLs", error);
    return NextResponse.json({ error: "Couldn't prepare Drive URLs." }, { status: 500 });
  }
}