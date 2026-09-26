import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import type { PersonalPlaylistSortMode, PersonalPlaylistVisibility, WatchStatus } from "@/types";

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
  let added = 0;
  // Sequential, not batched: each call needs its own duplicate + order
  // lookup, and folder imports are expected to be small enough (a Drive
  // folder a student organizes by hand) that this isn't a bottleneck. If
  // that stops being true, revisit with the same chunked-batch approach
  // bulkAddVideosToPersonalPlaylist uses.
  for (const video of videos) {
    await addDriveVideoAdmin(ownerId, playlistId, video);
    added += 1;
  }
  return added;
}

export interface DriveDocumentInput {
  title: string;
  fileType: "pdf" | "docx" | "pptx" | "xlsx";
  mimeType: string;
  sizeBytes?: number | null;
  driveFileId: string;
  driveConnectionId: string;
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
    categoryId: null,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}
