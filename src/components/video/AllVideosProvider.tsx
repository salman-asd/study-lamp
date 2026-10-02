"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { listPlaylists, listVideos } from "@/lib/firestore/playlists";
import { getAllUserVideoStates } from "@/lib/firestore/userVideoState";
import { listAllPersonalVideos } from "@/lib/firestore/personalPlaylists";
import { personalVideoToVideoWithState } from "@/lib/personalVideoAdapter";
import { mapWithConcurrency, shouldApplyCachedSnapshot, videoKey } from "@/lib/allVideosUtils";
import type { Playlist, UserVideoState, VideoWithState } from "@/types";

const CACHE_TTL_MS = 2 * 60_000;
const VIDEO_LOAD_CONCURRENCY = 8;

interface VideoSnapshot {
  uid?: string;
  loading: boolean;
  playlists: Playlist[];
  videos: VideoWithState[];
  fetchedAt: number;
}

interface AllVideosContextValue extends VideoSnapshot {
  load: (uid: string, force?: boolean) => Promise<void>;
  patchVideo: (key: string, patch: Partial<UserVideoState>) => () => void;
}

const EMPTY_SNAPSHOT: VideoSnapshot = {
  loading: false,
  playlists: [],
  videos: [],
  fetchedAt: 0,
};

const AllVideosContext = React.createContext<AllVideosContextValue | null>(null);

export function AllVideosProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const activeUid = user?.uid;
  const [snapshot, setSnapshot] = React.useState<VideoSnapshot>(EMPTY_SNAPSHOT);
  const snapshotRef = React.useRef(snapshot);
  const activeUidRef = React.useRef(activeUid);
  const cacheRef = React.useRef(new Map<string, VideoSnapshot>());
  const inFlightRef = React.useRef(new Map<string, Promise<void>>());

  activeUidRef.current = activeUid;

  const updateSnapshot = React.useCallback((next: VideoSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    if (next.uid && next.fetchedAt) cacheRef.current.set(next.uid, next);
  }, []);

  React.useEffect(() => {
    if (!activeUid) {
      cacheRef.current.clear();
      inFlightRef.current.clear();
      updateSnapshot(EMPTY_SNAPSHOT);
      return;
    }

    if (snapshotRef.current.uid === activeUid) return;

    const cached = cacheRef.current.get(activeUid);
    updateSnapshot(cached ? { ...cached, loading: false } : { ...EMPTY_SNAPSHOT, uid: activeUid });
  }, [activeUid, updateSnapshot]);

  const load = React.useCallback(async (uid: string, force = false) => {
    const cached = cacheRef.current.get(uid);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      // Fresh cache: only publish when the visible snapshot is for another user
      // or still loading. Publishing an identical snapshot re-renders consumers
      // for nothing (and used to retrigger useAllVideos' effect forever).
      const current = snapshotRef.current;
      if (activeUidRef.current === uid && shouldApplyCachedSnapshot({
        currentUid: current.uid,
        currentLoading: current.loading,
        targetUid: uid,
      })) {
        updateSnapshot({ ...cached, loading: false });
      }
      return;
    }

    const inFlight = inFlightRef.current.get(uid);
    if (inFlight) return inFlight;

    if (activeUidRef.current === uid) {
      const current = snapshotRef.current;
      if (cached) {
        // Stale-while-revalidate: keep showing cached data while refetching.
        if (shouldApplyCachedSnapshot({ currentUid: current.uid, currentLoading: current.loading, targetUid: uid })) {
          updateSnapshot({ ...cached, loading: false });
        }
      } else if (current.uid !== uid || !current.loading) {
        updateSnapshot({ uid, loading: true, playlists: [], videos: [], fetchedAt: 0 });
      }
    }

    const request = (async () => {
      try {
        const [playlists, states, personalVideos] = await Promise.all([
          listPlaylists(false),
          getAllUserVideoStates(uid),
          listAllPersonalVideos(uid),
        ]);
        const sharedVideoLists = await mapWithConcurrency(playlists, VIDEO_LOAD_CONCURRENCY, async (playlist) => {
          const videos = await listVideos(playlist.id);
          return videos.map((video) => ({
            ...video,
            state: states[video.id] || null,
            playlistTitle: playlist.title,
            source: "shared" as const,
          }));
        });
        const next: VideoSnapshot = {
          uid,
          loading: false,
          playlists,
          videos: [...sharedVideoLists.flat(), ...personalVideos.map(personalVideoToVideoWithState)],
          fetchedAt: Date.now(),
        };
        cacheRef.current.set(uid, next);
        if (activeUidRef.current === uid) updateSnapshot(next);
      } catch (error) {
        console.error("Failed to load all videos", error);
        if (activeUidRef.current === uid) {
          const latest = cacheRef.current.get(uid);
          updateSnapshot(latest ? { ...latest, loading: false } : { ...EMPTY_SNAPSHOT, uid });
        }
      } finally {
        inFlightRef.current.delete(uid);
      }
    })();
    inFlightRef.current.set(uid, request);
    return request;
  }, [updateSnapshot]);

  React.useEffect(() => {
    if (!activeUid) return;
    const revalidateIfStale = () => {
      const cached = cacheRef.current.get(activeUid);
      if (cached && Date.now() - cached.fetchedAt >= CACHE_TTL_MS) void load(activeUid, true);
    };
    window.addEventListener("focus", revalidateIfStale);
    return () => window.removeEventListener("focus", revalidateIfStale);
  }, [activeUid, load]);

  const patchVideo = React.useCallback((key: string, patch: Partial<UserVideoState>) => {
    const before = snapshotRef.current;
    const original = before.videos.find((video) => videoKey(video) === key);
    if (!before.uid || !original) return () => undefined;

    const previousState = original.state;
    const defaults: UserVideoState = {
      videoId: original.id,
      playlistId: original.playlistId,
      status: "not_started",
      watchedPercentage: 0,
      currentPositionSeconds: 0,
      isFavorite: false,
      isWatchLater: false,
      priority: null,
      lastWatchedAt: null,
      completedAt: null,
      updatedAt: null,
    };
    const optimisticState = { ...(previousState || defaults), ...patch };
    const patchSnapshot = (statePatch: Partial<UserVideoState>, onlyIfUnchanged = false) => {
      const current = snapshotRef.current;
      if (current.uid !== before.uid) return;
      updateSnapshot({
        ...current,
        videos: current.videos.map((video) => {
          if (videoKey(video) !== key) return video;
          const currentState = video.state || defaults;
          const applicable = Object.fromEntries(Object.entries(statePatch).filter(([field]) => (
            !onlyIfUnchanged || currentState[field as keyof UserVideoState] === optimisticState[field as keyof UserVideoState]
          )));
          return { ...video, state: { ...currentState, ...applicable } };
        }),
      });
    };

    patchSnapshot(patch);
    return () => {
      const previousValues = Object.fromEntries(Object.keys(patch).map((field) => [
        field,
        previousState ? previousState[field as keyof UserVideoState] : defaults[field as keyof UserVideoState],
      ])) as Partial<UserVideoState>;
      patchSnapshot(previousValues, true);
    };
  }, [updateSnapshot]);

  const value = React.useMemo<AllVideosContextValue>(() => ({ ...snapshot, load, patchVideo }), [snapshot, load, patchVideo]);
  return <AllVideosContext.Provider value={value}>{children}</AllVideosContext.Provider>;
}

export function useAllVideosContext(): AllVideosContextValue {
  const context = React.useContext(AllVideosContext);
  if (!context) throw new Error("useAllVideos must be used within AllVideosProvider.");
  return context;
}
