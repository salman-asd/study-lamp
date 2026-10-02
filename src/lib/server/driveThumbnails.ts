import { adminDb } from "@/lib/server/firebase-admin";
import { DriveApiError, fetchThumbnail } from "@/lib/server/googleDrive";
import admin from "firebase-admin";

const MAX_INLINE_DATA_URL_CHARS = 40 * 1024;
const MAX_THUMBNAIL_DOWNLOAD_BYTES = 30 * 1024;
const BACKFILL_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export interface StoredDriveThumbnail {
  thumbnailData: string | null;
}

export interface DriveThumbnailImage {
  bytes: Buffer;
  contentType: string;
}

export interface DriveThumbnailTarget {
  ref: FirebaseFirestore.DocumentReference;
  fileId: string;
  connectionId: string;
}

interface ThumbnailOwnerRecord {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
}

export function resizeDriveThumbnailUrl(thumbnailLink: string): string {
  const queryIndex = thumbnailLink.indexOf("?");
  const base = queryIndex < 0 ? thumbnailLink : thumbnailLink.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : thumbnailLink.slice(queryIndex);
  const sizedBase = base.replace(/=s\d+(?:-[^?&]*)?$/, "");
  return `${sizedBase}=s320${query}`;
}

export function createInlineThumbnailDataUrl(bytes: Buffer, contentType: string): string | null {
  if (!contentType.toLowerCase().startsWith("image/")) return null;
  const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
  return dataUrl.length <= MAX_INLINE_DATA_URL_CHARS ? dataUrl : null;
}

async function readThumbnailBytes(response: Response): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_THUMBNAIL_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_THUMBNAIL_DOWNLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function fetchAndStoreDriveThumbnail(
  accessToken: string,
  thumbnailLink: string | null | undefined,
): Promise<StoredDriveThumbnail | null> {
  if (!thumbnailLink) return null;

  let response: Response;
  try {
    response = await fetchThumbnail(accessToken, resizeDriveThumbnailUrl(thumbnailLink));
  } catch {
    return null;
  }
  if (response.status === 401) throw new DriveApiError(401, "Google Drive rejected the access token.");
  if (!response.ok) return null;

  const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) return null;
  const bytes = await readThumbnailBytes(response);
  if (!bytes) return null;
  const dataUrl = createInlineThumbnailDataUrl(bytes, contentType);
  return dataUrl ? { thumbnailData: dataUrl } : null;
}

async function findThumbnailOwnerRecord(uid: string, fileId: string, connectionId: string): Promise<ThumbnailOwnerRecord | null> {
  const videoSnapshot = await adminDb.collectionGroup("videos")
    .where("driveFileId", "==", fileId)
    .where("driveConnectionId", "==", connectionId)
    .limit(10)
    .get();
  const video = videoSnapshot.docs.find((doc) => doc.ref.path.startsWith(`users/${uid}/personalPlaylists/`));
  if (video) return { ref: video.ref, data: video.data() };

  const documentSnapshot = await adminDb.collection("users").doc(uid).collection("personalDocuments")
    .where("driveFileId", "==", fileId)
    .where("driveConnectionId", "==", connectionId)
    .limit(1)
    .get();
  const document = documentSnapshot.docs[0];
  return document ? { ref: document.ref, data: document.data() } : null;
}

function parseInlineDataUrl(value: unknown): DriveThumbnailImage | null {
  if (typeof value !== "string" || value.length > MAX_INLINE_DATA_URL_CHARS) return null;
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) return null;
  return { bytes, contentType: match[1].toLowerCase() };
}

export async function readStoredDriveThumbnail(
  uid: string,
  fileId: string,
  connectionId: string,
): Promise<DriveThumbnailImage | null> {
  const owner = await findThumbnailOwnerRecord(uid, fileId, connectionId);
  if (!owner) return null;
  return parseInlineDataUrl(owner.data.thumbnailData);
}

export async function saveDriveThumbnailReference(
  uid: string,
  fileId: string,
  connectionId: string,
  stored: StoredDriveThumbnail | null,
): Promise<void> {
  const owner = await findThumbnailOwnerRecord(uid, fileId, connectionId);
  if (!owner) return;
  await owner.ref.update({
    thumbnailData: stored?.thumbnailData ?? null,
    thumbnailAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function markDriveThumbnailAttempted(uid: string, fileId: string, connectionId: string): Promise<void> {
  await saveDriveThumbnailReference(uid, fileId, connectionId, null);
}

export async function listDriveThumbnailBackfillTargets(uid: string): Promise<DriveThumbnailTarget[]> {
  const playlistSnapshot = await adminDb.collection("users").doc(uid).collection("personalPlaylists").get();
  const videoSnapshots = await Promise.all(playlistSnapshot.docs.map((playlist) => playlist.ref.collection("videos").get()));
  const now = Date.now();
  const videos = videoSnapshots.flatMap((snapshot) => snapshot.docs)
    .filter((doc) => {
      const data = doc.data();
      const triedAt = data.thumbnailAttemptedAt?.toMillis?.() ?? 0;
      return typeof data.driveFileId === "string" && typeof data.driveConnectionId === "string" &&
        !data.thumbnailData &&
        now - triedAt >= BACKFILL_RETRY_AFTER_MS;
    })
    .map((doc) => ({ ref: doc.ref, fileId: doc.get("driveFileId") as string, connectionId: doc.get("driveConnectionId") as string }));

  const documentSnapshot = await adminDb.collection("users").doc(uid).collection("personalDocuments").get();
  const documents = documentSnapshot.docs
    .filter((doc) => {
      const data = doc.data();
      const triedAt = data.thumbnailAttemptedAt?.toMillis?.() ?? 0;
      return typeof data.driveFileId === "string" && typeof data.driveConnectionId === "string" &&
        !data.thumbnailData &&
        now - triedAt >= BACKFILL_RETRY_AFTER_MS;
    })
    .map((doc) => ({ ref: doc.ref, fileId: doc.get("driveFileId") as string, connectionId: doc.get("driveConnectionId") as string }));

  return [...videos, ...documents];
}

export async function saveThumbnailReferenceForTarget(
  target: DriveThumbnailTarget,
  stored: StoredDriveThumbnail | null,
): Promise<void> {
  await target.ref.update({
    thumbnailData: stored?.thumbnailData ?? null,
    thumbnailAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
