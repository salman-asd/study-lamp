"use client";
import * as React from "react";
import { useAllVideosContext } from "@/components/video/AllVideosProvider";
import type { UserVideoState } from "@/types";

export function useAllVideos(uid: string | undefined) {
  const context = useAllVideosContext();
  const matchesUser = !!uid && context.uid === uid;

  React.useEffect(() => {
    if (uid) void context.load(uid);
  }, [uid, context]);

  const refresh = React.useCallback(() => {
    return uid ? context.load(uid, true) : Promise.resolve();
  }, [uid, context]);

  const patchVideo = React.useCallback((key: string, patch: Partial<UserVideoState>) => {
    if (!matchesUser) return () => undefined;
    return context.patchVideo(key, patch);
  }, [context, matchesUser]);

  return {
    loading: !!uid && (!matchesUser || context.loading),
    playlists: matchesUser ? context.playlists : [],
    videos: matchesUser ? context.videos : [],
    refresh,
    patchVideo,
  };
}
