"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { useAllVideos } from "@/hooks/useAllVideos";
import { VideoGrid } from "@/components/video/VideoGrid";
import { toggleFavoriteAny, toggleWatchLaterAny, setPriorityAny, setWatchedAny, updateVideoStateOptimistically } from "@/lib/videoActions";
import type { PriorityLevel, VideoWithState } from "@/types";
import { toast } from "sonner";

export default function FavoritesPage() {
  return (
    <RequireAuth>
      <FavoritesContent />
    </RequireAuth>
  );
}

function FavoritesContent() {
  const { user } = useAuth();
  const { loading, videos, patchVideo } = useAllVideos(user?.uid);
  const favorites = videos.filter((v) => v.state?.isFavorite);

  async function handleUnfavorite(video: VideoWithState) {
    if (!user) return;
    try {
      await updateVideoStateOptimistically(video, { isFavorite: false }, patchVideo, () => toggleFavoriteAny(user.uid, video, false));
      toast.success("Removed from favorites");
    } catch {
      toast.error("Couldn't update favorite status.");
    }
  }
  async function handleToggleWatchLater(video: VideoWithState) {
    if (!user) return;
    const next = !video.state?.isWatchLater;
    try {
      await updateVideoStateOptimistically(video, { isWatchLater: next, watchLaterOrder: next ? Date.now() : undefined }, patchVideo, () => toggleWatchLaterAny(user.uid, video, next));
    } catch {
      toast.error("Couldn't update Watch Later.");
    }
  }
  async function handleSetPriority(video: VideoWithState, p: PriorityLevel) {
    if (!user) return;
    try {
      await updateVideoStateOptimistically(video, { priority: p, priorityOrder: p ? Date.now() : undefined }, patchVideo, () => setPriorityAny(user.uid, video, p));
    } catch {
      toast.error("Couldn't update priority.");
    }
  }
  async function handleToggleWatched(video: VideoWithState) {
    if (!user) return;
    const watched = video.state?.status !== "completed";
    try {
      await updateVideoStateOptimistically(video, {
        status: watched ? "completed" : "not_started",
        watchedPercentage: watched ? 100 : 0,
        completedAt: watched ? video.state?.completedAt || null : null,
      }, patchVideo, () => setWatchedAny(user.uid, video, watched));
    } catch {
      toast.error("Couldn't update watched status.");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="font-display text-2xl font-semibold">Favorites</h1>
          <p className="text-sm text-muted-foreground">Videos you&apos;ve marked as favorites — independent of priority or watch later.</p>
        </div>
        <VideoGrid
          videos={favorites}
          loading={loading}
          emptyTitle="No favorites yet"
          emptyHint='Tap the star on any video to add it here.'
          showActions
          onToggleFavorite={handleUnfavorite}
          onToggleWatchLater={handleToggleWatchLater}
          onSetPriority={handleSetPriority}
          onToggleWatched={handleToggleWatched}
        />
      </div>
    </AppShell>
  );
}
