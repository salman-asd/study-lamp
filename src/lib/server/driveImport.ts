import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import type { PersonalPlaylistSortMode, PersonalPlaylistVisibility, WatchStatus } from "@/types";
import { assignDriveVideoOrders, chunkForBatches, dedupeDriveItems } from "@/lib/server/driveImportUtils";

// Server-only, Admin-SDK mirror of the write paths in
// src/lib/firestore/personalPlaylists.ts. The API routes under
// /api/drive/import/* run with no signed-in Firebase Auth client context (the
// caller is verified via requireAuthenticatedUid, not the client SDK), so
// they can't reuse those functions directly — they'd be evaluated against
// firestore.rules as an unauthenticated request and rejected. This module
// intentionally duplicates just the handful of write shapes Drive import
// needs, using the Admin SDK (which bypasses rules, same as quiz.ts).

function playlistsCol(ownerId: string) {
  return adminDb.collection("users").doc(ownerId).collection("personalPlaylists");
}
function videosCol(ownerId: string, playlistId: string) {
  return playlistsCol(ownerId).doc(playlistId).collection("videos");
}

export async function getOrCreateUnsortedPlaylistAdmin(ownerId: string): Promise<string> {
  const existing = await playlistsCol(ownerId).where("isUnsorted", "==", true).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = playlistsCol(ownerId).doc();
  await ref.set({
    title: "Unsorted",
    description: "Videos saved without a playlist.",
    isUnsorted: true,
    visibility: "private" as PersonalPlaylistVisibility,
    sortMode: "custom" as PersonalPlaylistSortMode,
    sortOrder: [],
    videoCount: 0,
    totalDurationSeconds: 0,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function createPlaylistAdmin(ownerId: string, title: string, categoryId: string | null = null): Promise<string> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = playlistsCol(ownerId).doc();
  await ref.set({
    title,
    description: "",
    visibility: "private" as PersonalPlaylistVisibility,
    categoryId,
    tagIds: [],
    sortMode: "custom" as PersonalPlaylistSortMode,
    sortOrder: [],
    videoCount: 0,
    totalDurationSeconds: 0,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export interface DriveVideoInput {
  title: string;
  videoUrl: string;
  thumbnailUrl: string;
  durationSeconds?: number;
  driveFileId: string;
  driveConnectionId: string;
  /** True when a thumbnail download was attempted (bytes live in driveThumbs, not here). */
  thumbnailAttempted?: boolean;
}

/** Adds one Drive-backed video to a playlist. Dedupes on driveFileId (a
 *  Drive file id is a stable, unique key — unlike a shareable link, which
 *  can vary) rather than videoUrl. */
export async function addDriveVideoAdmin(ownerId: string, playlistId: string, video: DriveVideoInput): Promise<string> {
  const dup = await videosCol(ownerId, playlistId).where("driveFileId", "==", video.driveFileId).limit(1).get();
  if (!dup.empty) return dup.docs[0].id;

  const existing = await videosCol(ownerId, playlistId).count().get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = videosCol(ownerId, playlistId).doc();
  await ref.set({
    title: video.title,
    videoUrl: video.videoUrl,
    thumbnailUrl: video.thumbnailUrl,
    thumbnailAttemptedAt: video.thumbnailAttempted ? admin.firestore.FieldValue.serverTimestamp() : null,
    durationSeconds: video.durationSeconds ?? 0,
    platform: "google_drive",
    driveFileId: video.driveFileId,
    driveConnectionId: video.driveConnectionId,
    order: existing.data().count,
    status: "not_started" as WatchStatus,
    watchedPercentage: 0,
    currentPositionSeconds: 0,
    isFavorite: false,
    isWatchLater: false,
    priority: null,
    lastWatchedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const playlistRef = playlistsCol(ownerId).doc(playlistId);
  const playlistSnap = await playlistRef.get();
  const currentSortOrder = (playlistSnap.data()?.sortOrder as string[] | undefined) || [];
  await playlistRef.update({
    sortOrder: [...currentSortOrder, ref.id],
    videoCount: admin.firestore.FieldValue.increment(1),
    summaryStale: true,
    totalDurationSeconds: admin.firestore.FieldValue.increment(video.durationSeconds || 0),
    updatedAt: now,
  });
  return ref.id;
}

export interface BulkAddResult {
  added: number;
  /** Items skipped because the file was already imported (or repeated in the request). */
  duplicates: number;
}

export async function playlistExistsAdmin(ownerId: string, playlistId: string): Promise<boolean> {
  return (await playlistsCol(ownerId).doc(playlistId).get()).exists;
}

/** Drive file ids already imported into a playlist (used to skip duplicates before fetching thumbnails). */
export async function getExistingDriveVideoFileIds(ownerId: string, playlistId: string): Promise<Set<string>> {
  const snapshot = await videosCol(ownerId, playlistId).select("driveFileId").get();
  return new Set(snapshot.docs.map((doc) => doc.get("driveFileId")).filter((id): id is string => typeof id === "string"));
}

/** Drive file ids already imported as Study Materials documents. */
export async function getExistingDriveDocumentFileIds(ownerId: string): Promise<Set<string>> {
  const snapshot = await documentsCollection(ownerId).select("driveFileId").get();
  return new Set(snapshot.docs.map((doc) => doc.get("driveFileId")).filter((id): id is string => typeof id === "string"));
}

function documentsCollection(ownerId: string) {
  return adminDb.collection("users").doc(ownerId).collection("personalDocuments");
}

export async function bulkAddDriveVideosAdmin(ownerId: string, playlistId: string, videos: DriveVideoInput[]): Promise<number> {
  return (await bulkAddDriveVideosWithStats(ownerId, playlistId, videos)).added;
}

/**
 * Adds many Drive videos to a playlist. The playlist document (sortOrder,
 * videoCount, duration, summaryStale) is updated in the LAST write batch,
 * together with that batch's videos, so the playlist can never be left
 * pointing at a different set of videos than the ones that were written. If a
 * later batch fails, videos already committed by earlier batches are removed
 * again (best effort) before the error is rethrown.
 */
export async function bulkAddDriveVideosWithStats(ownerId: string, playlistId: string, videos: DriveVideoInput[]): Promise<BulkAddResult> {
  if (videos.length === 0) return { added: 0, duplicates: 0 };

  const playlistRef = playlistsCol(ownerId).doc(playlistId);
  const [existingVideos, playlistSnapshot] = await Promise.all([
    videosCol(ownerId, playlistId).select("driveFileId").get(),
    playlistRef.get(),
  ]);
  if (!playlistSnapshot.exists) throw new Error("Playlist not found.");

  const existingFileIds = existingVideos.docs
    .map((doc) => doc.get("driveFileId"))
    .filter((fileId): fileId is string => typeof fileId === "string");
  const newVideos = dedupeDriveItems(videos, existingFileIds);
  const duplicates = videos.length - newVideos.length;
  if (newVideos.length === 0) return { added: 0, duplicates };

  const orderedVideos = assignDriveVideoOrders(newVideos, existingVideos.size);
  const videoRefs = orderedVideos.map(() => videosCol(ownerId, playlistId).doc());
  const now = admin.firestore.FieldValue.serverTimestamp();

  const playlist = playlistSnapshot.data();
  const currentSortOrder = Array.isArray(playlist?.sortOrder) ? playlist.sortOrder as string[] : [];
  const durationAdded = newVideos.reduce((total, video) => total + (video.durationSeconds || 0), 0);
  const playlistUpdate = {
    sortOrder: [...currentSortOrder, ...videoRefs.map((ref) => ref.id)],
    videoCount: existingVideos.size + newVideos.length,
    summaryStale: true,
    totalDurationSeconds: (Number(playlist?.totalDurationSeconds) || 0) + durationAdded,
    updatedAt: now,
  };

  const chunks = chunkForBatches(orderedVideos);
  const committed: FirebaseFirestore.DocumentReference[] = [];
  let offset = 0;
  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const batch = adminDb.batch();
      const chunk = chunks[chunkIndex];
      chunk.forEach(({ item: video, order }, index) => {
        batch.set(videoRefs[offset + index], {
          title: video.title,
          videoUrl: video.videoUrl,
          thumbnailUrl: video.thumbnailUrl,
          thumbnailAttemptedAt: video.thumbnailAttempted ? now : null,
          durationSeconds: video.durationSeconds ?? 0,
          platform: "google_drive",
          driveFileId: video.driveFileId,
          driveConnectionId: video.driveConnectionId,
          order,
          status: "not_started" as WatchStatus,
          watchedPercentage: 0,
          currentPositionSeconds: 0,
          isFavorite: false,
          isWatchLater: false,
          priority: null,
          lastWatchedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      });
      if (chunkIndex === chunks.length - 1) batch.update(playlistRef, playlistUpdate);
      await batch.commit();
      committed.push(...videoRefs.slice(offset, offset + chunk.length));
      offset += chunk.length;
    }
  } catch (error) {
    await Promise.allSettled(committed.map((ref) => ref.delete()));
    throw error;
  }

  return { added: newVideos.length, duplicates };
}

export interface DriveDocumentInput {
  title: string;
  fileType: "pdf" | "docx" | "pptx" | "xlsx";
  mimeType: string;
  sizeBytes?: number | null;
  driveFileId: string;
  driveConnectionId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  /** Marker for the server-side thumbnail (see driveThumbnailMarker). */
  thumbnailUrl?: string | null;
  thumbnailAttempted?: boolean;
}

export async function addDriveDocumentAdmin(ownerId: string, doc: DriveDocumentInput): Promise<string> {
  const col = adminDb.collection("users").doc(ownerId).collection("personalDocuments");
  const dup = await col.where("driveFileId", "==", doc.driveFileId).limit(1).get();
  if (!dup.empty) return dup.docs[0].id;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = col.doc();
  await ref.set({
    title: doc.title,
    fileType: doc.fileType,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes ?? null,
    driveFileId: doc.driveFileId,
    driveConnectionId: doc.driveConnectionId,
    md5Checksum: doc.md5Checksum ?? null,
    modifiedTime: doc.modifiedTime ?? null,
    thumbnailUrl: doc.thumbnailUrl ?? null,
    thumbnailAttemptedAt: doc.thumbnailAttempted ? admin.firestore.FieldValue.serverTimestamp() : null,
    categoryId: null,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function bulkAddDriveDocumentsAdmin(ownerId: string, documents: DriveDocumentInput[]): Promise<number> {
  return (await bulkAddDriveDocumentsWithStats(ownerId, documents)).added;
}

/** Documents keep no counters on a parent doc, so each batch is independent; every batch may use all 400 writes. */
export async function bulkAddDriveDocumentsWithStats(ownerId: string, documents: DriveDocumentInput[]): Promise<BulkAddResult> {
  if (documents.length === 0) return { added: 0, duplicates: 0 };

  const documentsCol = documentsCollection(ownerId);
  const existingFileIds = await getExistingDriveDocumentFileIds(ownerId);
  const newDocuments = dedupeDriveItems(documents, existingFileIds);
  const duplicates = documents.length - newDocuments.length;
  if (newDocuments.length === 0) return { added: 0, duplicates };

  const now = admin.firestore.FieldValue.serverTimestamp();
  const refs = newDocuments.map(() => documentsCol.doc());
  let offset = 0;
  for (const chunk of chunkForBatches(newDocuments, 400, 0)) {
    const batch = adminDb.batch();
    chunk.forEach((document, index) => {
      batch.set(refs[offset + index], {
        title: document.title,
        fileType: document.fileType,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes ?? null,
        driveFileId: document.driveFileId,
        driveConnectionId: document.driveConnectionId,
        md5Checksum: document.md5Checksum ?? null,
        modifiedTime: document.modifiedTime ?? null,
        thumbnailUrl: document.thumbnailUrl ?? null,
        thumbnailAttemptedAt: document.thumbnailAttempted ? now : null,
        categoryId: null,
        tagIds: [],
        createdAt: now,
        updatedAt: now,
      });
    });
    await batch.commit();
    offset += chunk.length;
  }

  return { added: newDocuments.length, duplicates };
}
