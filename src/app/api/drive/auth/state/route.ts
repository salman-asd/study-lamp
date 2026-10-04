import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { buildAuthUrl, signDriveState, isDriveConfigured } from "@/lib/server/googleDrive";
import { checkRateLimit } from "@/lib/server/rateLimit";

// Step 1 of the OAuth flow (Phase 13): the browser calls this (authenticated,
// normal fetch with an Authorization header) to get a short-lived signed
// state token, then builds the Google auth URL itself and navigates the
// whole page there. See src/lib/driveClient.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!checkRateLimit(uid, { scope: "drive:auth-state", limit: 10 })) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": "60" } });

  if (!isDriveConfigured()) {
    return NextResponse.json(
      { error: "Google Drive isn't configured on this deployment yet (missing GOOGLE_DRIVE_CLIENT_ID/SECRET)." },
      { status: 501 }
    );
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const state = signDriveState(uid, nonce);
  const response = NextResponse.json({ url: buildAuthUrl(req.nextUrl.origin, state) });
  response.cookies.set("sl_drive_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/drive/auth",
    maxAge: 600,
  });
  return response;
}
