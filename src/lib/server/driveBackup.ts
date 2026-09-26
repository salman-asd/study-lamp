import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";

// Server-only. Phase 17: exports a user's playlists/videos/notes/summaries/
// goals/quiz attempts as one JSON document, uploaded to a "Study Lamp
// Backups" folder in their own connected Drive account (see
// getOrCreateBackupFolder in googleDrive.ts) — a portable, user-owned copy
// independent of Firestore/this app's own uptime or quota.
//
// Restore is additive-only by construction: every doc is written with its
// *original* id (recorded at backup time) via a plain create — see
// restoreBackup below — so a doc that still exists is always left alone,
// never overwritten. That's what makes "preview, then confirm" meaningfully
// safe rather than just a confirmation dialog with no teeth.

function toPlain(value: unknown): unknown {
  if (value instanceof admin.firestore.Timestamp) {
    return { __ts: value.toDate().toISOString() };
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

function fromPlain(value: unknown): unknown {
  if (value && typeof value === "object" && "__ts" in (value as any) && typeof (value as any).__ts === "string") {
    return admin.firestore.Timestamp.fromDate(new Date((value as any).__ts));
  }
  if (Array.isArray(value)) return value.map(fromPlain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromPlain(v)]));
  }
  return value;
}

export interface BackupPayload {
  version: 1;
  createdAt: string;
  ownerId: string;
  playlists: Array<{ id: string; data: Record<string, unknown>; videos: Array<{ id: string; data: Record<string, unknown> }> }>;
  notes: Array<{ id: string; data: Record<string, unknown> }>;
  summaries: Array<{ id: string; data: Record<string, unknown> }>;
  goals: Array<{ id: string; data: Record<string, unknown> }>;
  quizAttempts: Array<{ id: string; data: Record<string, unknown> }>;
}

export async function buildBackupPayload(uid: string): Promise<BackupPayload> {
  const userRef = adminDb.collection("users").doc(uid);

  const [playlistsSnap, notesSnap, summariesSnap, goalsSnap, quizAttemptsSnap] = await Promise.all([
    userRef.collection("personalPlaylists").get(),
    userRef.collection("notes").get(),
    userRef.collection("summaries").get(),
    userRef.collection("goals").get(),
    userRef.collection("quizAttempts").get(),
  ]);

  const playlists = await Promise.all(
    playlistsSnap.docs.map(async (playlistDoc) => {
      const videosSnap = await playlistDoc.ref.collection("videos").get();
      return {
        id: playlistDoc.id,
        data: toPlain(playlistDoc.data()) as Record<string, unknown>,
        videos: videosSnap.docs.map((v) => ({ id: v.id, data: toPlain(v.data()) as Record<string, unknown> })),
      };
    })
  );

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    ownerId: uid,
    playlists,
    notes: notesSnap.docs.map((d) => ({ id: d.id, data: toPlain(d.data()) as Record<string, unknown> })),
    summaries: summariesSnap.docs.map((d) => ({ id: d.id, data: toPlain(d.data()) as Record<string, unknown> })),
    goals: goalsSnap.docs.map((d) => ({ id: d.id, data: toPlain(d.data()) as Record<string, unknown> })),
    quizAttempts: quizAttemptsSnap.docs.map((d) => ({ id: d.id, data: toPlain(d.data()) as Record<string, unknown> })),
  };
}

export interface RestorePreview {
  playlistsToRestore: number;
  videosToRestore: number;
  notesToRestore: number;
  summariesToRestore: number;
  goalsToRestore: number;
  quizAttemptsToRestore: number;
  playlistTitles: string[];
}

/** Read-only — figures out what *would* change without writing anything, so
 *  the UI can show it before the user confirms. */
export async function previewRestore(uid: string, payload: BackupPayload): Promise<RestorePreview> {
  const userRef = adminDb.collection("users").doc(uid);
  const existingPlaylistIds = new Set((await userRef.collection("personalPlaylists").listDocuments()).map((d) => d.id));
  const existingNoteIds = new Set((await userRef.collection("notes").listDocuments()).map((d) => d.id));
  const existingSummaryIds = new Set((await userRef.collection("summaries").listDocuments()).map((d) => d.id));
  const existingGoalIds = new Set((await userRef.collection("goals").listDocuments()).map((d) => d.id));
  const existingQuizAttemptIds = new Set((await userRef.collection("quizAttempts").listDocuments()).map((d) => d.id));

  const newPlaylists = payload.playlists.filter((p) => !existingPlaylistIds.has(p.id));
  return {
    playlistsToRestore: newPlaylists.length,
    videosToRestore: newPlaylists.reduce((sum, p) => sum + p.videos.length, 0),
    notesToRestore: payload.notes.filter((n) => !existingNoteIds.has(n.id)).length,
    summariesToRestore: payload.summaries.filter((s) => !existingSummaryIds.has(s.id)).length,
    goalsToRestore: payload.goals.filter((g) => !existingGoalIds.has(g.id)).length,
    quizAttemptsToRestore: payload.quizAttempts.filter((q) => !existingQuizAttemptIds.has(q.id)).length,
    playlistTitles: newPlaylists.map((p) => String(p.data.title ?? "Untitled playlist")),
  };
}

/** Writes back everything the preview identified as missing. Every write is
 *  a `create()` (Firestore rejects a create against an existing doc id), so
 *  even a concurrent change between preview and confirm fails safely closed
 *  rather than clobbering something. */
export async function restoreBackup(uid: string, payload: BackupPayload): Promise<RestorePreview> {
  const preview = await previewRestore(uid, payload);
  const userRef = adminDb.collection("users").doc(uid);
  const existingPlaylistIds = new Set((await userRef.collection("personalPlaylists").listDocuments()).map((d) => d.id));

  for (const playlist of payload.playlists) {
    if (existingPlaylistIds.has(playlist.id)) continue;
    const playlistRef = userRef.collection("personalPlaylists").doc(playlist.id);
    try {
      await playlistRef.create(fromPlain(playlist.data) as Record<string, unknown>);
    } catch {
      continue; // created concurrently since the preview — skip, don't overwrite
    }
    for (const video of playlist.videos) {
      await playlistRef.collection("videos").doc(video.id).create(fromPlain(video.data) as Record<string, unknown>).catch(() => {});
    }
  }

  const restoreFlat = async (collectionName: string, docs: Array<{ id: string; data: Record<string, unknown> }>) => {
    for (const item of docs) {
      await userRef.collection(collectionName).doc(item.id).create(fromPlain(item.data) as Record<string, unknown>).catch(() => {});
    }
  };
  await restoreFlat("notes", payload.notes);
  await restoreFlat("summaries", payload.summaries);
  await restoreFlat("goals", payload.goals);
  await restoreFlat("quizAttempts", payload.quizAttempts);

  return preview;
}
