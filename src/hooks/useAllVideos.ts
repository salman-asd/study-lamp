"use client";
import * as React from "react";
import { useAllVideosContext } from "@/components/video/AllVideosProvider";
import type { UserVideoState } from "@/types";

export function useAllVideos(uid: string | undefined) {
  const context = useAllVideosContext();
  // `context` is a new object on every snapshot change. Depend only on the
  // stable callbacks, otherwise load() -> new snapshot -> new context -> effect
  // -> load() loops forever.
  const { load, patchVideo: patchContextVideo } = context;
  const matchesUser = !!uid && context.uid === uid;

  React.useEffect(() => {
    if (uid) void load(uid);
  }, [uid, load]);

  const refresh = React.useCallback(() => {
    return uid ? load(uid, true) : Promise.resolve();
  }, [uid, load]);

  const patchVideo = React.useCallback((key: string, patch: Partial<UserVideoState>) => {
    if (!matchesUser) return () => undefined;
    return patchContextVideo(key, patch);
  }, [patchContextVideo, matchesUser]);

  return {
    loading: !!uid && (!matchesUser || context.loading),
    playlists: matchesUser ? context.playlists : [],
    videos: matchesUser ? context.videos : [],
    refresh,
    patchVideo,
  };
}
