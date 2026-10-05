import { NextRequest, NextResponse } from "next/server";
import { verifyWorkspaceState, persistGoogleOAuthTokens, isWorkspaceConfigured } from "@/lib/server/googleOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectAndClearNonce(settingsUrl: URL): NextResponse {
  const response = NextResponse.redirect(settingsUrl);
  response.cookies.set("sl_google_nonce", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google/auth",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  if (!isWorkspaceConfigured()) {
    return NextResponse.json({ error: "Google Workspace isn't configured on this deployment yet." }, { status: 501 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const settingsUrl = new URL("/settings/google", request.url);
  const nonceCookie = request.cookies.get("sl_google_nonce")?.value ?? null;

  if (error) {
    settingsUrl.searchParams.set("error", error === "access_denied" ? "You did not grant Google Calendar access." : error);
    return redirectAndClearNonce(settingsUrl);
  }

  if (!code || !state || !nonceCookie) {
    settingsUrl.searchParams.set("error", "Missing code, state, or OAuth nonce from Google.");
    return redirectAndClearNonce(settingsUrl);
  }

  const verification = verifyWorkspaceState(state, nonceCookie);
  if (!verification || !verification.uid) {
    settingsUrl.searchParams.set("error", "That connection link expired or is invalid. Try connecting again.");
    return redirectAndClearNonce(settingsUrl);
  }

  const tokenResult = await persistGoogleOAuthTokens(verification.uid, code, verification.features, request.nextUrl.origin);
  if (!tokenResult.ok) {
    settingsUrl.searchParams.set("error", tokenResult.error || "Google OAuth failed.");
    return redirectAndClearNonce(settingsUrl);
  }

  settingsUrl.searchParams.set("connected", tokenResult.connection.googleEmail || "Google account");
  return redirectAndClearNonce(settingsUrl);
}
