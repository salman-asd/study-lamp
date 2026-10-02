import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import type { PersonalPlaylistSortMode, PersonalPlaylistVisibility, WatchStatus } from "@/types";
import { assignDriveVideoOrders, dedupeDriveItems } from "@/lib/server/driveImportUtils";

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

export async function bulkAddDriveVideosAdmin(ownerId: string, playlistId: string, videos: DriveVideoInput[]): Promise<number> {
  if (videos.length === 0) return 0;

  const playlistRef = playlistsCol(ownerId).doc(playlistId);
  const [existingVideos, playlistSnapshot] = await Promise.all([
    videosCol(ownerId, playlistId).select("driveFileId").get(),
    playlistRef.get(),
  ]);
  const existingFileIds = existingVideos.docs
    .map((doc) => doc.get("driveFileId"))
    .filter((fileId): fileId is string => typeof fileId === "string");
  const newVideos = dedupeDriveItems(videos, existingFileIds);
  if (newVideos.length === 0) return 0;

  const orderedVideos = assignDriveVideoOrders(newVideos, existingVideos.size);
  const videoRefs = orderedVideos.map(({ item }) => videosCol(ownerId, playlistId).doc());
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (let offset = 0; offset < orderedVideos.length; offset += 400) {
    const batch = adminDb.batch();
    const chunk = orderedVideos.slice(offset, offset + 400);
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
    await batch.commit();
  }

  const playlist = playlistSnapshot.data();
  const currentSortOrder = Array.isArray(playlist?.sortOrder) ? playlist.sortOrder as string[] : [];
  const durationAdded = newVideos.reduce((total, video) => total + (video.durationSeconds || 0), 0);
  await playlistRef.update({
    sortOrder: [...currentSortOrder, ...videoRefs.map((ref) => ref.id)],
    videoCount: existingVideos.size + newVideos.length,
    summaryStale: true,
    totalDurationSeconds: (Number(playlist?.totalDurationSeconds) || 0) + durationAdded,
    updatedAt: now,
  });

  return newVideos.length;
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
  if (documents.length === 0) return 0;

  const documentsCol = adminDb.collection("users").doc(ownerId).collection("personalDocuments");
  const existingDocuments = await documentsCol.select("driveFileId").get();
  const existingFileIds = existingDocuments.docs
    .map((doc) => doc.get("driveFileId"))
    .filter((fileId): fileId is string => typeof fileId === "string");
  const newDocuments = dedupeDriveItems(documents, existingFileIds);
  if (newDocuments.length === 0) return 0;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const refs = newDocuments.map(() => documentsCol.doc());
  for (let offset = 0; offset < newDocuments.length; offset += 400) {
    const batch = adminDb.batch();
    newDocuments.slice(offset, offset + 400).forEach((document, index) => {
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
  }

  return newDocuments.length;
}
