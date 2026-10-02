"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { useAllVideos } from "@/hooks/useAllVideos";
import { SortableList } from "@/components/dnd/SortableList";
import { VideoListRow } from "@/components/video/VideoListRow";
import { Skeleton } from "@/components/ui/skeleton";
import { toggleWatchLaterAny, setWatchedAny, setPriorityAny, reorderMixedList, updateVideoStateOptimistically } from "@/lib/videoActions";
import { groupVideosByPlaylist, type PlaylistGroup } from "@/lib/groupByPlaylist";
import type { VideoWithState } from "@/types";
import { toast } from "sonner";

export default function WatchLaterPage() {
  return (
    <RequireAuth>
      <WatchLaterContent />
    </RequireAuth>
  );
}

function WatchLaterContent() {
  const { user } = useAuth();
  const { loading, videos, patchVideo } = useAllVideos(user?.uid);
  const [groups, setGroups] = React.useState<PlaylistGroup<VideoWithState>[]>([]);

  React.useEffect(() => {
    const list = videos
      .filter((v) => v.state?.isWatchLater)
      .sort((a, b) => (a.state?.watchLaterOrder || 0) - (b.state?.watchLaterOrder || 0));
    setGroups(groupVideosByPlaylist(list));
  }, [videos]);

  if (!user) return null;

  const totalCount = groups.reduce((sum, g) => sum + g.videos.length, 0);

  // Reordering is scoped to a single playlist group: the drag only ever
  // reorders within the group it started in (SortableList instances are
  // independent per group), and the write only touches the videos in that
  // group's own array — a video's playlist membership never changes here.
  async function handleReorder(playlistId: string | null, newOrder: VideoWithState[]) {
    setGroups((gs) => gs.map((g) => (g.playlistId === playlistId ? { ...g, videos: newOrder } : g)));
    await reorderMixedList(user!.uid, newOrder, "watchLaterOrder");
  }

  async function handleRemove(v: VideoWithState) {
    try {
      await updateVideoStateOptimistically(v, { isWatchLater: false, watchLaterOrder: undefined }, patchVideo, () => toggleWatchLaterAny(user!.uid, v, false));
      toast.success("Removed from Watch Later");
    } catch {
      toast.error("Couldn't remove video from Watch Later.");
    }
  }

  async function handleMarkWatched(v: VideoWithState) {
    const next = v.state?.status !== "completed";
    try {
      await updateVideoStateOptimistically(v, {
        status: next ? "completed" : "not_started",
        watchedPercentage: next ? 100 : 0,
        completedAt: next ? v.state?.completedAt || null : null,
      }, patchVideo, () => setWatchedAny(user!.uid, v, next));
      toast.success(next ? "Marked watched" : "Marked unwatched");
    } catch {
      toast.error("Couldn't update watched status.");
    }
  }

  async function handlePriority(v: VideoWithState, p: "high" | "medium" | "low" | null) {
    try {
      await updateVideoStateOptimistically(v, { priority: p, priorityOrder: p ? Date.now() : undefined }, patchVideo, () => setPriorityAny(user!.uid, v, p));
    } catch {
      toast.error("Couldn't update priority.");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Watch Later</h1>
          <p className="text-sm text-muted-foreground">Videos you&apos;ve saved to come back to, grouped by playlist. Drag to reorder within a group.</p>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[68px] w-full rounded-lg" />)}
          </div>
        ) : totalCount === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            Nothing saved yet — tap &quot;Watch Later&quot; on any video to add it here.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.playlistId ?? "other"} className="space-y-2">
              <h2 className="font-display text-base font-semibold">
                {group.playlistTitle}{" "}
                <span className="text-sm font-normal text-muted-foreground">({group.videos.length})</span>
              </h2>
              <SortableList
                items={group.videos}
                getId={(v) => v.id}
                onReorder={(newOrder) => handleReorder(group.playlistId, newOrder)}
                className="space-y-2"
                renderItem={(v, dragHandleProps) => (
                  <VideoListRow
                    video={v}
                    dragHandleProps={dragHandleProps}
                    onMarkWatched={() => handleMarkWatched(v)}
                    onRemove={() => handleRemove(v)}
                    onSetPriority={(p) => handlePriority(v, p)}
                  />
                )}
              />
            </section>
          ))
        )}
      </div>
    </AppShell>
  );
}
