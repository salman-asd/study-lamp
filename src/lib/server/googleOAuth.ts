import crypto from "crypto";
import { upsertGoogleConnection } from "@/lib/server/googleConnections";
import { featuresFromGrantedScopes, scopesForFeatures, type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_TTL_MS = 10 * 60 * 1000;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function isWorkspaceConfigured(): boolean {
  return Boolean(process.env.GOOGLE_WORKSPACE_CLIENT_ID && process.env.GOOGLE_WORKSPACE_CLIENT_SECRET && process.env.GOOGLE_WORKSPACE_OAUTH_STATE_SECRET);
}

export function buildWorkspaceAuthUrl(origin: string, state: string, features: readonly GoogleWorkspaceFeature[] = []): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_WORKSPACE_CLIENT_ID"),
    redirect_uri: `${origin}/api/google/auth/callback`,
    response_type: "code",
    scope: scopesForFeatures(features).join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export function signWorkspaceState(uid: string, nonce: string, features: readonly GoogleWorkspaceFeature[] = [], nowMs = Date.now()): string {
  const payload = JSON.stringify({ uid, nonce, features: [...features], ts: nowMs });
  const secret = env("GOOGLE_WORKSPACE_OAUTH_STATE_SECRET");
  const signature = crypto.createHmac("sha256", secret).update(`workspace.v1|${payload}`).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

export function verifyWorkspaceState(
  state: string,
  expectedNonce: string | null,
  expectedFeatures: readonly GoogleWorkspaceFeature[] = [],
  nowMs = Date.now(),
): { uid: string; nonce: string; features: GoogleWorkspaceFeature[] } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const payloadPart = decoded.slice(0, lastDot);
    const sigPart = decoded.slice(lastDot + 1);
    const payload = JSON.parse(payloadPart) as { uid?: string; nonce?: string; features?: string[]; ts?: number };
    if (!payload.uid || !payload.nonce || !Number.isFinite(payload.ts)) return null;
    const expectedSignature = crypto.createHmac("sha256", env("GOOGLE_WORKSPACE_OAUTH_STATE_SECRET")).update(`workspace.v1|${payloadPart}`).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sigPart), Buffer.from(expectedSignature))) return null;
    const age = nowMs - Number(payload.ts);
    if (age < 0 || age > STATE_TTL_MS) return null;
    if (expectedNonce && payload.nonce !== expectedNonce) return null;
    const features = Array.isArray(payload.features) ? payload.features.filter((value): value is GoogleWorkspaceFeature => value === "calendar" || value === "tasks") : [];
    if (expectedFeatures.length && features.length && !expectedFeatures.every((feature) => features.includes(feature))) return null;
    if (features.length === 0 && expectedFeatures.length > 0) return null;
    return { uid: payload.uid, nonce: payload.nonce, features };
  } catch {
    return null;
  }
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export async function exchangeCodeForTokens(code: string, origin: string): Promise<GoogleTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_WORKSPACE_CLIENT_ID"),
      client_secret: env("GOOGLE_WORKSPACE_CLIENT_SECRET"),
      redirect_uri: `${origin}/api/google/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`);
  return response.json() as Promise<GoogleTokenResponse>;
}

export async function refreshWorkspaceAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env("GOOGLE_WORKSPACE_CLIENT_ID"),
      client_secret: env("GOOGLE_WORKSPACE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const err: any = new Error(`Google token refresh failed (${response.status}).`);
    err.googleAuthInvalid = response.status === 400 || response.status === 401;
    throw err;
  }
  const data = (await response.json()) as GoogleTokenResponse;
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}

export async function getGoogleAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch(`${USERINFO_ENDPOINT}?alt=json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google userinfo lookup failed (${response.status}).`);
  const data = (await response.json()) as { email?: string };
  if (!data.email) throw new Error("Google did not return an email.");
  return data.email;
}

export async function persistGoogleOAuthTokens(
  uid: string,
  code: string,
  features: readonly GoogleWorkspaceFeature[],
  origin: string,
): Promise<{ ok: true; connection: Awaited<ReturnType<typeof upsertGoogleConnection>> } | { ok: false; error: string }> {
  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    if (!tokens.refresh_token) {
      return { ok: false, error: "Google did not issue a refresh token. Try disconnecting any prior Study Lamp access and reconnect." };
    }

    const googleEmail = await getGoogleAccountEmail(tokens.access_token);
    const connection = await upsertGoogleConnection(uid, {
      googleEmail,
      refreshToken: tokens.refresh_token,
      grantedScopes: [...new Set(features)],
    });
    return { ok: true, connection };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Google OAuth failed." };
  }
}

export function featuresFromGrantedScopeString(scopeString: string | null | undefined): GoogleWorkspaceFeature[] {
  return featuresFromGrantedScopes(scopeString);
}
