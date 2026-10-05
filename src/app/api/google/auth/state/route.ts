import crypto from "crypto";
import { NextResponse } from "next/server";
import { buildWorkspaceAuthUrl, isWorkspaceConfigured, signWorkspaceState, WORKSPACE_NONCE_COOKIE } from "@/lib/server/googleWorkspaceAuth";
import { type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isWorkspaceFeature(value: unknown): value is GoogleWorkspaceFeature {
  return value === "calendar" || value === "tasks";
}

export const POST = withAuthedRoute(async ({ uid, req }) => {
  if (!isWorkspaceConfigured()) {
    return NextResponse.json({ error: "Google Workspace isn't configured on this deployment yet." }, { status: 501 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const requested: unknown = parsed.body.features;
  // Must be an array of 1-2 values, each exactly "calendar" or "tasks", with
  // no duplicates. Anything else (wrong type, unknown value, too many) -> 400.
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 2 || !requested.every(isWorkspaceFeature)) {
    return NextResponse.json({ error: "Provide one or two Google Workspace features: calendar or tasks." }, { status: 400 });
  }
  const features = Array.from(new Set(requested));
  if (features.length !== requested.length) {
    return NextResponse.json({ error: "Provide one or two Google Workspace features: calendar or tasks." }, { status: 400 });
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const state = signWorkspaceState(uid, nonce, features);
  const response = NextResponse.json({ url: buildWorkspaceAuthUrl(req.nextUrl.origin, state, features) });
  response.cookies.set(WORKSPACE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google/auth",
    maxAge: 600,
  });
  return response;
}, { scope: "google:auth-state", preset: "authSensitive" });
