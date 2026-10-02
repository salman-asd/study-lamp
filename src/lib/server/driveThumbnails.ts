import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { DriveApiError, fetchThumbnail } from "@/lib/server/googleDrive";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";

// Drive thumbnails live in a SERVER-ONLY subcollection instead of as base64
// inside every video/document doc (which every list read had to download):
//
//   users/{uid}/driveThumbs/{connectionId}_{fileId}
//     { contentType, bytes (Firestore Bytes), updatedAt }          -> an image
//     { missing: true, updatedAt }                                 -> "Google has none (yet)"
//
// firestore.rules denies all client access to driveThumbs; only the Admin SDK
// (this module, the thumbnail route, import and backfill) touches it. Video and
// document docs keep just the `thumbnailUrl` marker (see driveThumbnailMarker)
// and `thumbnailAttemptedAt`.

/** Raw image cap. Google's s320 thumbnails are typically 10-40 KB. */
export const MAX_THUMBNAIL_BYTES = 200 * 1024;
/** How long a "Google has no thumbnail" answer is trusted before asking again.
 *  Short on purpose: freshly uploaded files get their thumbnail minutes later. */
export const MISSING_THUMBNAIL_RETRY_MS = 30 * 60 * 1000;
/** Legacy base64-in-document format (pre-R3), still decoded by the backfill. */
const LEGACY_MAX_DATA_URL_CHARS = 40 * 1024;
const THUMBNAIL_FETCH_CONCURRENCY = 5;

// SVG is deliberately NOT allowed: served same-origin it can carry script.
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export interface DriveThumbnailImage {
  bytes: Buffer;
  contentType: string;
}

export type StoredThumbnailLookup =
  | { kind: "hit"; image: DriveThumbnailImage }
  | { kind: "missing"; recent: boolean }
  | { kind: "none" };

export type WithDriveToken = <T>(operation: (accessToken: string) => Promise<T>) => Promise<T>;

export function resizeDriveThumbnailUrl(thumbnailLink: string): string {
  const queryIndex = thumbnailLink.indexOf("?");
  const base = queryIndex < 0 ? thumbnailLink : thumbnailLink.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : thumbnailLink.slice(queryIndex);
  const sizedBase = base.replace(/=s\d+(?:-[^?&]*)?$/, "");
  return `${sizedBase}=s320${query}`;
}

/** Firestore document id for a thumbnail. Both parts are validated upstream
 *  (connection id: [A-Za-z0-9]{10,40}; file id: [A-Za-z0-9_-]{10,128}). */
export function driveThumbnailDocId(connectionId: string, fileId: string): string {
  return `${connectionId}_${fileId}`;
}

/** Returns the bare lower-case image type when it is an allowed one, else null. */
export function normalizeImageContentType(header: string | null | undefined): string | null {
  const type = (header || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(type) ? type : null;
}

export function isFreshMissingMarker(updatedAtMs: number, now: number = Date.now()): boolean {
  return now - updatedAtMs < MISSING_THUMBNAIL_RETRY_MS;
}

/** Decodes a legacy `data:image/...;base64,...` thumbnail. Null when malformed or not an allowed image. */
export function parseLegacyThumbnailDataUrl(value: unknown): DriveThumbnailImage | null {
  if (typeof value !== "string" || value.length > LEGACY_MAX_DATA_URL_CHARS) return null;
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const contentType = normalizeImageContentType(match[1]);
  if (!contentType) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  return { bytes, contentType };
}

/** Reads a response body, giving up (null) as soon as it exceeds `maxBytes`. */
export async function readCappedBody(response: Response, maxBytes: number = MAX_THUMBNAIL_BYTES): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
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
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return total ? Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) : null;
}

/**
 * Downloads (does not persist) a thumbnail from Google. Null when Google has
 * none, it is not an allowed image, or it is larger than MAX_THUMBNAIL_BYTES.
 * Throws DriveApiError(401) so withDriveAccessToken can refresh and retry.
 */
export async function fetchAndStoreDriveThumbnail(
  accessToken: string,
  thumbnailLink: string | null | undefined,
): Promise<DriveThumbnailImage | null> {
  if (!thumbnailLink) return null;

  let response: Response;
  try {
    response = await fetchThumbnail(accessToken, resizeDriveThumbnailUrl(thumbnailLink));
  } catch {
    return null;
  }
  if (response.status === 401) throw new DriveApiError(401, "Google Drive rejected the access token.");
  if (!response.ok) return null;

  const contentType = normalizeImageContentType(response.headers.get("content-type") || "image/jpeg");
  if (!contentType) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readCappedBody(response);
  return bytes ? { bytes, contentType } : null;
}

// ── driveThumbs storage ─────────────────────────────────────────────────────
function thumbsCol(uid: string) {
  return adminDb.collection("users").doc(uid).collection("driveThumbs");
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof (value as { toUint8Array?: unknown }).toUint8Array === "function") {
    return Buffer.from((value as { toUint8Array: () => Uint8Array }).toUint8Array());
  }
  return null;
}

export async function saveDriveThumbnail(
  uid: string,
  connectionId: string,
  fileId: string,
  image: DriveThumbnailImage,
): Promise<void> {
  if (image.bytes.length > MAX_THUMBNAIL_BYTES) throw new Error("Thumbnail is too large to store.");
  await thumbsCol(uid).doc(driveThumbnailDocId(connectionId, fileId)).set({
    contentType: image.contentType,
    bytes: image.bytes,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Remembers "Google had no thumbnail" so the route doesn't call Drive on every request. */
export async function markDriveThumbnailMissing(uid: string, connectionId: string, fileId: string): Promise<void> {
  await thumbsCol(uid).doc(driveThumbnailDocId(connectionId, fileId)).set({
    missing: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Reads one thumbnail doc BY ID. The signed URL already binds uid + connection + file, so no ownership query is needed here. */
export async function lookupStoredDriveThumbnail(
  uid: string,
  fileId: string,
  connectionId: string,
): Promise<StoredThumbnailLookup> {
  const snap = await thumbsCol(uid).doc(driveThumbnailDocId(connectionId, fileId)).get();
  if (!snap.exists) return { kind: "none" };
  const data = snap.data() || {};

  const bytes = toBuffer(data.bytes);
  const contentType = normalizeImageContentType(typeof data.contentType === "string" ? data.contentType : null);
  if (bytes && bytes.length && contentType) return { kind: "hit", image: { bytes, contentType } };

  if (data.missing === true) {
    const updatedAtMs = typeof data.updatedAt?.toMillis === "function" ? data.updatedAt.toMillis() : 0;
    return { kind: "missing", recent: isFreshMissingMarker(updatedAtMs) };
  }
  return { kind: "none" };
}

export async function readStoredDriveThumbnail(
  uid: string,
  fileId: string,
  connectionId: string,
): Promise<DriveThumbnailImage | null> {
  const lookup = await lookupStoredDriveThumbnail(uid, fileId, connectionId);
  return lookup.kind === "hit" ? lookup.image : null;
}

export interface DriveThumbnailSource {
  fileId: string;
  thumbnailLink?: string | null;
}

/**
 * Import helper: downloads and stores thumbnails for many files (concurrency
 * 5). NEVER throws — a thumbnail failure must not fail an import. Returns, per
 * input index, whether a thumbnail was stored.
 */
export async function fetchAndSaveDriveThumbnails(
  uid: string,
  connectionId: string,
  items: readonly DriveThumbnailSource[],
  withToken: WithDriveToken,
  concurrency: number = THUMBNAIL_FETCH_CONCURRENCY,
): Promise<boolean[]> {
  const saved = new Array<boolean>(items.length).fill(false);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (!item.thumbnailLink) continue;
      try {
        const image = await withToken((accessToken) => fetchAndStoreDriveThumbnail(accessToken, item.thumbnailLink));
        if (image) {
          await saveDriveThumbnail(uid, connectionId, item.fileId, image);
          saved[index] = true;
        }
      } catch {
        // Best effort: the thumbnail route self-heals on first view.
      }
    }
  }));
  return saved;
}

// ── Backfill / legacy migration ─────────────────────────────────────────────
export interface DriveThumbnailTarget {
  ref: FirebaseFirestore.DocumentReference;
  kind: "video" | "document";
  fileId: string;
  connectionId: string;
  hasMarker: boolean;
  legacyThumbnailData: unknown;
}

type CollectionBuilder = (collection: FirebaseFirestore.CollectionReference) => FirebaseFirestore.Query;

async function userMediaCollections(uid: string): Promise<FirebaseFirestore.CollectionReference[]> {
  const userRef = adminDb.collection("users").doc(uid);
  // select() with no fields returns only references, so playlist docs (and
  // their sortOrder arrays) are not downloaded.
  const playlists = await userRef.collection("personalPlaylists").select().get();
  return [
    ...playlists.docs.map((playlist) => playlist.ref.collection("videos")),
    userRef.collection("personalDocuments"),
  ];
}

function toTarget(doc: FirebaseFirestore.QueryDocumentSnapshot): DriveThumbnailTarget | null {
  const data = doc.data();
  if (typeof data.driveFileId !== "string" || typeof data.driveConnectionId !== "string") return null;
  return {
    ref: doc.ref,
    kind: doc.ref.parent.id === "personalDocuments" ? "document" : "video",
    fileId: data.driveFileId,
    connectionId: data.driveConnectionId,
    hasMarker: typeof data.thumbnailUrl === "string" && data.thumbnailUrl.length > 0,
    legacyThumbnailData: data.thumbnailData,
  };
}

async function collectTargets(uid: string, build: CollectionBuilder, limit: number): Promise<DriveThumbnailTarget[]> {
  const collections = await userMediaCollections(uid);
  const targets: DriveThumbnailTarget[] = [];
  for (const collection of collections) {
    if (targets.length >= limit) break;
    const snapshot = await build(collection).limit(limit - targets.length).get();
    for (const doc of snapshot.docs) {
      const target = toTarget(doc);
      if (target) targets.push(target);
    }
  }
  return targets;
}

async function countTargets(uid: string, build: CollectionBuilder): Promise<number> {
  const collections = await userMediaCollections(uid);
  const counts = await Promise.all(collections.map(async (collection) => (await build(collection).count().get()).data().count));
  return counts.reduce((sum, count) => sum + count, 0);
}

// Single-field queries only, so Firestore's automatic indexes cover them (no
// composite index or collection-group exemption needed). Per-playlist queries
// are used instead of one collectionGroup query because a collection group
// spans ALL users and cannot be scoped to one uid.
const legacyQuery: CollectionBuilder = (collection) => collection.where("thumbnailData", "!=", null);
const unattemptedQuery: CollectionBuilder = (collection) => collection.where("thumbnailAttemptedAt", "==", null);

export function listLegacyThumbnailTargets(uid: string, limit: number): Promise<DriveThumbnailTarget[]> {
  return collectTargets(uid, legacyQuery, limit);
}
export function countLegacyThumbnails(uid: string): Promise<number> {
  return countTargets(uid, legacyQuery);
}
export function listUnattemptedThumbnailTargets(uid: string, limit: number): Promise<DriveThumbnailTarget[]> {
  return collectTargets(uid, unattemptedQuery, limit);
}
export function countUnattemptedThumbnails(uid: string): Promise<number> {
  return countTargets(uid, unattemptedQuery);
}

/** Moves a legacy base64 thumbnail into driveThumbs and strips it from the document. */
export async function migrateLegacyThumbnail(uid: string, target: DriveThumbnailTarget): Promise<void> {
  const image = parseLegacyThumbnailDataUrl(target.legacyThumbnailData);
  if (image) await saveDriveThumbnail(uid, target.connectionId, target.fileId, image);
  await target.ref.update({
    thumbnailData: admin.firestore.FieldValue.delete(),
    ...(target.hasMarker ? {} : { thumbnailUrl: driveThumbnailMarker(target.fileId, target.connectionId) }),
    thumbnailAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Records that a thumbnail fetch was attempted (and makes sure the marker exists). */
export async function markThumbnailAttempted(target: DriveThumbnailTarget): Promise<void> {
  await target.ref.update({
    ...(target.hasMarker ? {} : { thumbnailUrl: driveThumbnailMarker(target.fileId, target.connectionId) }),
    thumbnailAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
