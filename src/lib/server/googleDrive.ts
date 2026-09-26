import crypto from "crypto";

/**
 * Server-only. Raw REST wrapper around Google's OAuth2 + Drive v3 APIs —
 * deliberately implemented with plain fetch() rather than the `googleapis`
 * npm package, so Phase 13-17 don't add a heavy new dependency for what
 * amounts to a handful of endpoints (token exchange/refresh, files.get/
 * list/create, and the resumable upload initiate call).
 *
 * Scope used everywhere: https://www.googleapis.com/auth/drive.file — Study
 * Lamp can only see files it created or that the user explicitly picked via
 * the Google Picker (see src/components/drive/DrivePicker.tsx). This is a
 * "non-sensitive" scope under Google's OAuth verification rules, so it
 * avoids the security-assessment process the broader drive/drive.readonly
 * scopes require.
 *
 * Required env vars (server-only, never NEXT_PUBLIC_):
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_OAUTH_STATE_SECRET  (generate with: openssl rand -base64 32)
 * Plus one public var so the browser can start the OAuth redirect and open
 * the Picker with the same client id:
 *   NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID
 *   NEXT_PUBLIC_GOOGLE_PICKER_API_KEY  (a browser API key restricted to the
 *     Picker API — see https://console.cloud.google.com/apis/credentials)
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured. See src/lib/server/googleDrive.ts for the full list of required env vars.`);
  return v;
}

export function isDriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
    process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
    process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET
  );
}

/** Builds the redirect_uri from the request's own origin rather than a
 *  hardcoded env var, so this works unchanged across localhost/preview/prod
 *  deployments — it only has to match one of the "Authorized redirect URIs"
 *  configured on the OAuth client in Google Cloud Console. */
export function buildRedirectUri(origin: string): string {
  return `${origin}/api/drive/auth/callback`;
}

// ── OAuth "state" — binds the redirect round-trip to the signed-in uid ─────
// Google's callback is a plain browser GET with no Authorization header, so
// the state param is how we know *which* Study Lamp user is connecting.
// Signed (HMAC-SHA256) and short-lived (10 min) so it can't be forged or replayed.
const STATE_TTL_MS = 10 * 60 * 1000;

export function signDriveState(uid: string): string {
  const payload = `${uid}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", env("GOOGLE_DRIVE_OAUTH_STATE_SECRET")).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyDriveState(state: string): { uid: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 3) return null;
    const [uid, tsRaw, sig] = parts;
    const expected = crypto.createHmac("sha256", env("GOOGLE_DRIVE_OAUTH_STATE_SECRET")).update(`${uid}.${tsRaw}`).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
    return { uid };
  } catch {
    return null;
  }
}

export function buildAuthUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_DRIVE_CLIENT_ID"),
    redirect_uri: buildRedirectUri(origin),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    // Forces Google to re-issue a refresh_token even for a user who
    // connected before — without this, re-connecting after a disconnect
    // would silently come back with no refresh_token at all.
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(code: string, origin: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_DRIVE_CLIENT_ID"),
      client_secret: env("GOOGLE_DRIVE_CLIENT_SECRET"),
      redirect_uri: buildRedirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text().catch(() => "")}`);
  return res.json();
}

/** Returns a fresh short-lived access token for a stored refresh token.
 *  Never persisted — callers use it immediately for one or a few Drive API
 *  calls and then discard it. */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env("GOOGLE_DRIVE_CLIENT_ID"),
      client_secret: env("GOOGLE_DRIVE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`Google token refresh failed (${res.status}): ${body}`);
    err.driveAuthInvalid = res.status === 400 || res.status === 401;
    throw err;
  }
  const data = (await res.json()) as TokenResponse;
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

export async function getGoogleAccountEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error("Unable to read the connected Google account's email.");
  const data = await res.json();
  return data.email as string;
}

// ── Drive v3 file operations ────────────────────────────────────────────

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  thumbnailLink?: string;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
  parents?: string[];
}

const FILE_FIELDS = "id,name,mimeType,size,thumbnailLink,videoMediaMetadata,parents";

export async function getFileMetadata(accessToken: string, fileId: string): Promise<DriveFileMeta> {
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Unable to read file metadata from Drive (${res.status}).`);
  return res.json();
}

/** Lists the direct video children of a folder (one level — matches "pick a
 *  folder → one video per file" from Phase 14, no recursive sub-folders). */
export async function listFolderVideoFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  return listFolderFiles(accessToken, folderId, "mimeType contains 'video/'");
}

export async function listFolderDocumentFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  const mimeQuery = SUPPORTED_DOCUMENT_MIME_TYPES.map((m) => `mimeType = '${m}'`).join(" or ");
  return listFolderFiles(accessToken, folderId, `(${mimeQuery})`);
}

async function listFolderFiles(accessToken: string, folderId: string, mimeClause: string): Promise<DriveFileMeta[]> {
  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and ${mimeClause}`);
    const url = `${DRIVE_API}/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Unable to list the Drive folder's contents (${res.status}).`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/** Streams a file's raw bytes from Drive, forwarding a Range header both
 *  ways so the caller (the secure playback/download proxy) can support
 *  seeking and resumable downloads. Returns the raw fetch Response — the
 *  caller pipes .body straight through rather than buffering it. */
export async function fetchFileContent(accessToken: string, fileId: string, range?: string | null): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (range) headers.Range = range;
  return fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers });
}

/** Proxies a Drive-hosted thumbnail (thumbnailLink requires the same OAuth
 *  session that owns the file — it isn't a public URL). */
export async function fetchThumbnail(accessToken: string, thumbnailLink: string): Promise<Response> {
  return fetch(thumbnailLink, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** Finds (or creates) a top-level "Study Lamp Backups" folder in the
 *  connected Drive account. Looked up by name each time rather than cached,
 *  since it's one cheap extra call and avoids ever creating a duplicate. */
export async function getOrCreateBackupFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    "name = 'Study Lamp Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents"
  );
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.ok) {
    const data = await res.json();
    if (data.files?.[0]?.id) return data.files[0].id;
  }
  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Study Lamp Backups", mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!createRes.ok) throw new Error("Unable to create the Study Lamp Backups folder in Drive.");
  const created = await createRes.json();
  return created.id;
}

export async function listBackupFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  return listFolderFiles(accessToken, folderId, "mimeType = 'application/json'");
}

/** Uploads a small JSON payload as a new file (single-request "multipart"
 *  upload — fine for backups, which are plain JSON text well under Drive's
 *  5MB simple-upload-friendly size in nearly every real account). */
export async function uploadJsonFile(accessToken: string, folderId: string, name: string, json: unknown): Promise<DriveFileMeta> {
  const boundary = `slboundary${crypto.randomBytes(8).toString("hex")}`;
  const metadata = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Unable to upload backup to Drive (${res.status}).`);
  return res.json();
}

export async function downloadJsonFile(accessToken: string, fileId: string): Promise<unknown> {
  const res = await fetchFileContent(accessToken, fileId, null);
  if (!res.ok) throw new Error(`Unable to download backup from Drive (${res.status}).`);
  return res.json();
}

/** Starts a resumable upload session (Phase 15). Returns the session URI the
 *  browser then PUTs the file bytes to directly — per Google's own docs,
 *  "the session URI can be used without further authorization for the
 *  duration of the session," so this is the only step that needs our
 *  server-held access token. The heavy upload itself never touches our
 *  server (avoids platform body-size/time limits for large videos). */
export async function startResumableUpload(
  accessToken: string,
  input: { name: string; mimeType: string; folderId?: string | null }
): Promise<string> {
  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=resumable`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.mimeType,
    },
    body: JSON.stringify({ name: input.name, ...(input.folderId ? { parents: [input.folderId] } : {}) }),
  });
  if (!res.ok) throw new Error(`Unable to start a Drive upload session (${res.status}): ${await res.text().catch(() => "")}`);
  const location = res.headers.get("Location") || res.headers.get("location");
  if (!location) throw new Error("Drive did not return an upload session URL.");
  return location;
}

export const SUPPORTED_VIDEO_MIME_PREFIX = "video/";

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
];

export function documentFileTypeFromMime(mimeType: string): "pdf" | "docx" | "pptx" | "xlsx" | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("wordprocessingml")) return "docx";
  if (mimeType.includes("presentationml")) return "pptx";
  if (mimeType.includes("spreadsheetml")) return "xlsx";
  return null;
}
