// Step W2: generic Google OAuth2 primitives, shared by the Drive flow
// (src/lib/server/googleDrive.ts) and the Workspace flow
// (src/lib/server/googleWorkspaceAuth.ts and the /api/google/* routes).
//
// Every function takes an explicit {clientId, clientSecret, redirectPath}
// config so the two OAuth clients (Drive and Workspace) each pass their own
// credentials without this module knowing about either. Nothing here reads
// env vars directly — the callers decide which client to use.

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  /** Path only, e.g. "/api/google/auth/callback". The origin is supplied per call. */
  redirectPath: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export function buildRedirectUri(origin: string, redirectPath: string): string {
  return `${origin}${redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`}`;
}

/** Builds the Google consent URL. `options.scope` is a single space-separated
 *  string (Drive keeps its combined DRIVE_SCOPE) so callers are not forced to
 *  switch to an array. */
export function buildGoogleAuthUrl(
  origin: string,
  state: string,
  client: GoogleOAuthClient,
  options: {
    scope: string;
    includeGrantedScopes?: boolean;
    accessType?: "offline" | "online";
    prompt?: string;
  },
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: buildRedirectUri(origin, client.redirectPath),
    response_type: "code",
    scope: options.scope,
    access_type: options.accessType ?? "offline",
    prompt: options.prompt ?? "consent",
    state,
  });
  if (options.includeGrantedScopes) params.set("include_granted_scopes", "true");
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchanges an authorization code for tokens. Throws on any non-2xx so the
 *  caller can turn it into a plain-language message. */
export async function exchangeCode(
  code: string,
  origin: string,
  client: GoogleOAuthClient,
): Promise<GoogleTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: buildRedirectUri(origin, client.redirectPath),
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`);
  return (await response.json()) as GoogleTokenResponse;
}

/** Refreshes a stored refresh token. Marks the thrown error with
 *  `googleAuthInvalid` on 400/401 so callers can flag the connection invalid
 *  (the refresh token was revoked or expired). */
export async function refreshToken(
  refreshTokenValue: string,
  client: GoogleOAuthClient,
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshTokenValue,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const err: any = new Error(`Google token refresh failed (${response.status}).`);
    // Two flag names are set so both existing consumers keep working
    // unchanged: Drive reads `driveAuthInvalid`, Workspace reads
    // `googleAuthInvalid`. Both mean "the refresh token is no longer valid".
    err.googleAuthInvalid = response.status === 400 || response.status === 401;
    err.driveAuthInvalid = err.googleAuthInvalid;
    throw err;
  }
  const data = (await response.json()) as GoogleTokenResponse;
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Best-effort revoke: a network failure here must never block removing the
 *  local connection, so the rejection is swallowed. */
export async function revoke(token: string): Promise<void> {
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}

export async function fetchGoogleAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("Unable to read the connected Google account's email.");
  const data = (await response.json()) as { email?: string };
  if (!data.email) throw new Error("Google did not return an email.");
  return data.email;
}
