import type { DriveConnectionSummary } from "@/types";

// Thin client-side wrappers around the /api/drive/* routes, mirroring the
// pattern in src/lib/aiConnectionsClient.ts.

async function parseOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function authHeaders(idToken: string, withJson = false): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  };
}

export async function listDriveConnections(idToken: string): Promise<DriveConnectionSummary[]> {
  const res = await fetch("/api/drive/connections", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.connections;
}

export async function disconnectDrive(idToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`/api/drive/connections/${connectionId}`, { method: "DELETE", headers: authHeaders(idToken) });
  await parseOrThrow(res);
}

/** Kicks off the OAuth connect flow and navigates to the server-built Google
 *  auth URL. Google eventually redirects back to /settings/drive via our own
 *  /api/drive/auth/callback route. */
export async function startDriveConnect(idToken: string): Promise<void> {
  const res = await fetch("/api/drive/auth/state", { method: "POST", headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  if (typeof data.url !== "string" || !data.url.startsWith("https://accounts.google.com/")) {
    throw new Error("Google Drive returned an invalid authorization URL.");
  }
  window.location.href = data.url;
}

/** Short-lived (~1hr) access token for client-side use by the Google Picker
 *  only. Never stored beyond the Picker session. */
export async function getDriveAccessToken(idToken: string, connectionId: string): Promise<string> {
  const res = await fetch(`/api/drive/access-token?connectionId=${encodeURIComponent(connectionId)}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.accessToken;
}

export interface DriveImportResult {
  kind: "video" | "document";
  playlistId?: string;
  videoId?: string;
  documentId?: string;
}

export type DriveSignedUrlPurpose = "stream" | "download" | "thumb";

export interface DriveSignedUrlItem {
  fileId: string;
  connectionId: string;
  purpose: DriveSignedUrlPurpose;
}

interface CachedSignedUrl {
  url: string;
  exp: number;
}

interface PendingSignedUrl extends DriveSignedUrlItem {
  uid: string;
  idToken: string;
  resolve: (url: string) => void;
  reject: (error: Error) => void;
}

const signedUrlCache = new Map<string, CachedSignedUrl>();
const pendingSignedUrls: PendingSignedUrl[] = [];
const SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60_000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 500;
let signFlushQueued = false;

function signedUrlCacheKey(uid: string, item: DriveSignedUrlItem): string {
  return `${uid}:${item.purpose}:${item.connectionId}:${item.fileId}`;
}

function queueSignedUrl(item: DriveSignedUrlItem, uid: string, idToken: string): Promise<string> {
  const key = signedUrlCacheKey(uid, item);
  const cached = signedUrlCache.get(key);
  if (cached && cached.exp * 1000 - SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) {
    signedUrlCache.delete(key);
    signedUrlCache.set(key, cached);
    return Promise.resolve(cached.url);
  }

  return new Promise((resolve, reject) => {
    pendingSignedUrls.push({ ...item, uid, idToken, resolve, reject });
    if (!signFlushQueued) {
      signFlushQueued = true;
      queueMicrotask(() => { void flushSignedUrlQueue(); });
    }
  });
}

async function flushSignedUrlQueue(): Promise<void> {
  signFlushQueued = false;
  const batch = pendingSignedUrls.splice(0, 50);
  const byUser = new Map<string, PendingSignedUrl[]>();
  for (const entry of batch) {
    const entries = byUser.get(entry.uid) || [];
    entries.push(entry);
    byUser.set(entry.uid, entries);
  }

  await Promise.all(Array.from(byUser.values(), async (entries) => {
    const first = entries[0];
    try {
      const res = await fetch("/api/drive/sign", {
        method: "POST",
        headers: authHeaders(first.idToken, true),
        body: JSON.stringify({ items: entries.map(({ fileId, connectionId, purpose }) => ({ fileId, connectionId, purpose })) }),
      });
      const data = await parseOrThrow(res);
      if (!Array.isArray(data.urls) || data.urls.length !== entries.length) {
        throw new Error("Google Drive returned an incomplete signed URL response.");
      }

      for (let index = 0; index < entries.length; index++) {
        const signed = data.urls[index] as { url?: unknown; exp?: unknown };
        if (typeof signed.url !== "string" || typeof signed.exp !== "number") {
          throw new Error("Google Drive returned an invalid signed URL.");
        }
        const entry = entries[index];
        const key = signedUrlCacheKey(entry.uid, entry);
        signedUrlCache.delete(key);
        signedUrlCache.set(key, { url: signed.url, exp: signed.exp });
        while (signedUrlCache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
          const oldestKey = signedUrlCache.keys().next().value;
          if (oldestKey === undefined) break;
          signedUrlCache.delete(oldestKey);
        }
        entry.resolve(signed.url);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Couldn't prepare a Drive URL.");
      entries.forEach((entry) => entry.reject(normalized));
    }
  }));

  if (pendingSignedUrls.length && !signFlushQueued) {
    signFlushQueued = true;
    queueMicrotask(() => { void flushSignedUrlQueue(); });
  }
}

export async function getSignedDriveUrls(
  idToken: string,
  uid: string,
  items: DriveSignedUrlItem[],
): Promise<string[]> {
  return Promise.all(items.map((item) => queueSignedUrl(item, uid, idToken)));
}

export async function backfillDriveThumbnails(idToken: string): Promise<{ processed: number; remaining: number }> {
  const res = await fetch("/api/drive/thumbnails/backfill", {
    method: "POST",
    headers: authHeaders(idToken),
  });
  return parseOrThrow(res);
}

export async function importDriveFile(
  idToken: string,
  input: { connectionId: string; fileId: string; playlistId?: string }
): Promise<DriveImportResult> {
  const res = await fetch("/api/drive/import/file", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  return parseOrThrow(res);
}

export async function importDriveFolder(
  idToken: string,
  input: { connectionId: string; folderId: string }
): Promise<{ playlistId: string; videoCount: number }> {
  const res = await fetch("/api/drive/import/folder", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  return parseOrThrow(res);
}

export async function startDriveUploadSession(
  idToken: string,
  input: { connectionId: string; name: string; mimeType: string; sizeBytes: number }
): Promise<string> {
  const res = await fetch("/api/drive/upload/session", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  return data.uploadUrl;
}

/** Uploads bytes straight to Google's resumable session URL — no
 *  Authorization header needed here (see startResumableUpload's comment in
 *  googleDrive.ts). Reports progress via onProgress(0-100) using XHR since
 *  fetch doesn't expose upload progress. */
export function uploadFileToDrive(uploadUrl: string, file: File, onProgress?: (pct: number) => void): Promise<{ id: string; name: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Drive returned an unexpected response after upload."));
        }
      } else {
        reject(new Error(`Upload to Drive failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload to Drive failed (network error)."));
    xhr.send(file);
  });
}

export interface BackupSummary {
  fileId: string;
  name: string;
  createdAt?: string;
  counts?: Record<string, number>;
}

export async function createDriveBackup(idToken: string, connectionId: string): Promise<BackupSummary> {
  const res = await fetch("/api/drive/backup", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId }),
  });
  return parseOrThrow(res);
}

export async function listDriveBackups(idToken: string, connectionId: string): Promise<{ fileId: string; name: string }[]> {
  const res = await fetch(`/api/drive/backup/list?connectionId=${encodeURIComponent(connectionId)}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.backups;
}

export interface RestorePreview {
  confirmed: boolean;
  playlistsToRestore: number;
  videosToRestore: number;
  notesToRestore: number;
  summariesToRestore: number;
  goalsToRestore: number;
  quizAttemptsToRestore: number;
  playlistTitles: string[];
}

export async function previewDriveRestore(idToken: string, connectionId: string, fileId: string): Promise<RestorePreview> {
  const res = await fetch("/api/drive/backup/restore", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId, fileId, confirm: false }),
  });
  return parseOrThrow(res);
}

export async function confirmDriveRestore(idToken: string, connectionId: string, fileId: string): Promise<RestorePreview> {
  const res = await fetch("/api/drive/backup/restore", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId, fileId, confirm: true }),
  });
  return parseOrThrow(res);
}
