"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { useAllVideos } from "@/hooks/useAllVideos";
import { SortableList } from "@/components/dnd/SortableList";
import { VideoListRow } from "@/components/video/VideoListRow";
import { Skeleton } from "@/components/ui/skeleton";
import { setPriorityAny, setWatchedAny, reorderMixedList, updateVideoStateOptimistically } from "@/lib/videoActions";
import { groupVideosByPlaylist, type PlaylistGroup } from "@/lib/groupByPlaylist";
import type { VideoWithState } from "@/types";
import { toast } from "sonner";

const LEVELS: { key: "high" | "medium" | "low"; label: string; emoji: string }[] = [
  { key: "high", label: "High Priority", emoji: "🔴" },
  { key: "medium", label: "Medium Priority", emoji: "🟡" },
  { key: "low", label: "Low Priority", emoji: "🟢" },
];

type LevelGroups = Record<string, PlaylistGroup<VideoWithState>[]>;

export default function PriorityPage() {
  return (
    <RequireAuth>
      <PriorityContent />
    </RequireAuth>
  );
}

function PriorityContent() {
  const { user } = useAuth();
  const { loading, videos, patchVideo } = useAllVideos(user?.uid);
  const [groups, setGroups] = React.useState<LevelGroups>({ high: [], medium: [], low: [] });

  React.useEffect(() => {
    const byLevel: Record<string, VideoWithState[]> = { high: [], medium: [], low: [] };
    videos.forEach((v) => {
      if (v.state?.priority) byLevel[v.state.priority].push(v);
    });
    const next: LevelGroups = {};
    (Object.keys(byLevel) as Array<"high" | "medium" | "low">).forEach((level) => {
      const sorted = [...byLevel[level]].sort(
        (a, b) => (a.state?.priorityOrder || 0) - (b.state?.priorityOrder || 0)
      );
      next[level] = groupVideosByPlaylist(sorted);
    });
    setGroups(next);
  }, [videos]);

  if (!user) return null;

  // Each SortableList instance lives inside one (level, playlist) group.
  // A reorder here only ever reshuffles that group's own videos array and
  // writes priorityOrder for exactly those videos — it can't move a video
  // to a different priority level or a different playlist.
  async function handleReorder(level: string, playlistId: string | null, newOrder: VideoWithState[]) {
    setGroups((g) => ({
      ...g,
      [level]: (g[level] || []).map((pg) => (pg.playlistId === playlistId ? { ...pg, videos: newOrder } : pg)),
    }));
    await reorderMixedList(user!.uid, newOrder, "priorityOrder");
  }

  async function handleChangeLevel(v: VideoWithState, p: "high" | "medium" | "low" | null) {
    try {
      await updateVideoStateOptimistically(v, { priority: p, priorityOrder: p ? Date.now() : undefined }, patchVideo, () => setPriorityAny(user!.uid, v, p));
      toast.success(p ? `Moved to ${p} priority` : "Priority removed");
    } catch {
      toast.error("Couldn't update priority.");
    }
  }

  async function handleMarkWatched(v: VideoWithState) {
    const watched = v.state?.status !== "completed";
    try {
      await updateVideoStateOptimistically(v, {
        status: watched ? "completed" : "not_started",
        watchedPercentage: watched ? 100 : 0,
        completedAt: watched ? v.state?.completedAt || null : null,
      }, patchVideo, () => setWatchedAny(user!.uid, v, watched));
    } catch {
      toast.error("Couldn't update watched status.");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="font-display text-2xl font-semibold">Priority</h1>
          <p className="text-sm text-muted-foreground">Videos you&apos;ve marked important, ordered High → Medium → Low and grouped by playlist.</p>
        </div>

        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[68px] w-full rounded-lg" />)}</div>
        ) : (
          LEVELS.map(({ key, label, emoji }) => {
            const playlistGroups = groups[key] || [];
            const count = playlistGroups.reduce((sum, g) => sum + g.videos.length, 0);
            return (
              <section key={key} className="space-y-3">
                <h2 className="font-display text-base font-semibold">
                  {emoji} {label} <span className="text-sm font-normal text-muted-foreground">({count})</span>
                </h2>
                {count === 0 ? (
                  <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">No videos here.</p>
                ) : (
                  <div className="space-y-4">
                    {playlistGroups.map((pg) => (
                      <div key={pg.playlistId ?? "other"} className="space-y-2">
                        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {pg.playlistTitle} ({pg.videos.length})
                        </h3>
                        <SortableList
                          items={pg.videos}
                          getId={(v) => v.id}
                          onReorder={(newOrder) => handleReorder(key, pg.playlistId, newOrder)}
                          className="space-y-2"
                          renderItem={(v, dragHandleProps) => (
                            <VideoListRow
                              video={v}
                              dragHandleProps={dragHandleProps}
                              onMarkWatched={() => handleMarkWatched(v)}
                              onSetPriority={(p) => handleChangeLevel(v, p)}
                            />
                          )}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </AppShell>
  );
}
