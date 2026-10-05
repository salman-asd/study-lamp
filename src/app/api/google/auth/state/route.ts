import crypto from "crypto";
import { NextResponse } from "next/server";
import { buildWorkspaceAuthUrl, isWorkspaceConfigured, signWorkspaceState } from "@/lib/server/googleOAuth";
import { type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuthedRoute(async ({ uid, req }) => {
  if (!isWorkspaceConfigured()) {
    return NextResponse.json({ error: "Google Workspace isn't configured on this deployment yet." }, { status: 501 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const requested = parsed.body.features;
  const features = Array.isArray(requested)
    ? [...new Set(requested.filter((value): value is GoogleWorkspaceFeature => value === "calendar" || value === "tasks"))]
    : [];

  if (features.length === 0 || features.length > 2) {
    return NextResponse.json({ error: "Provide one or two Google Workspace features: calendar or tasks." }, { status: 400 });
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const state = signWorkspaceState(uid, nonce, features);
  const response = NextResponse.json({ url: buildWorkspaceAuthUrl(req.nextUrl.origin, state, features) });
  response.cookies.set("sl_google_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google/auth",
    maxAge: 600,
  });
  return response;
}, { scope: "googleSync", preset: "googleSync", limit: 10, tooManyMessage: "Too many connection requests. Please slow down." });
