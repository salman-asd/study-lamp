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
  input: { connectionId: string; name: string; mimeType: string }
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

export function driveStreamUrl(fileId: string, connectionId: string, download = false): string {
  return `/api/drive/stream/${fileId}?connectionId=${encodeURIComponent(connectionId)}${download ? "&download=1" : ""}`;
}

export function driveThumbnailUrl(fileId: string, connectionId: string): string {
  return `/api/drive/thumbnail/${fileId}?connectionId=${encodeURIComponent(connectionId)}`;
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
