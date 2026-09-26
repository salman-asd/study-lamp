import { NextRequest, NextResponse } from "next/server";
import { verifyDriveState, exchangeCodeForTokens, getGoogleAccountEmail } from "@/lib/server/googleDrive";
import { upsertDriveConnection } from "@/lib/server/driveConnections";

// Step 2 of the OAuth flow: Google redirects the user's browser here with
// ?code&state (no Authorization header — this is a plain top-level
// navigation, not a fetch from our own client code). The signed `state`
// param is what ties this back to a Study Lamp user (see signDriveState).
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const settingsUrl = new URL("/settings/drive", origin);

  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    settingsUrl.searchParams.set("error", error === "access_denied" ? "You didn't grant access, so nothing was connected." : error);
    return NextResponse.redirect(settingsUrl);
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) {
    settingsUrl.searchParams.set("error", "Missing code or state from Google.");
    return NextResponse.redirect(settingsUrl);
  }

  const verified = verifyDriveState(state);
  if (!verified) {
    settingsUrl.searchParams.set("error", "That connection link expired or is invalid. Try connecting again.");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    if (!tokens.refresh_token) {
      // Shouldn't happen given access_type=offline&prompt=consent, but if a
      // user somehow lands here without one, we have nothing to store.
      settingsUrl.searchParams.set("error", "Google didn't grant offline access. Try disconnecting any prior Study Lamp access in your Google Account settings, then reconnect.");
      return NextResponse.redirect(settingsUrl);
    }
    const googleEmail = await getGoogleAccountEmail(tokens.access_token);
    await upsertDriveConnection(verified.uid, { googleEmail, refreshToken: tokens.refresh_token, scope: tokens.scope });
    settingsUrl.searchParams.set("connected", googleEmail);
    return NextResponse.redirect(settingsUrl);
  } catch (err) {
    console.error("Drive OAuth callback failed", err);
    settingsUrl.searchParams.set("error", "Something went wrong connecting Google Drive. Please try again.");
    return NextResponse.redirect(settingsUrl);
  }
}
