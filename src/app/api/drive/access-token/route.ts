import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";

// Returns a short-lived (~1hr) Drive access token, scoped to drive.file, for
// client-side use by the Google Picker only (Phase 14) — the Picker widget
// itself requires a browser-side OAuth token to know which account's files
// to show. This is *not* the same as exposing the long-lived refresh token:
// it expires quickly and is never persisted client-side (not localStorage,
// not React state that outlives the Picker session).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:access-token" })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!isValidDriveConnectionId(connectionId)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    return NextResponse.json({ accessToken });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    console.error("Failed to mint Drive access token", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}
