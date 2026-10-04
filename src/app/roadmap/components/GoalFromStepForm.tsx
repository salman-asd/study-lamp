"use client";

import * as React from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { defaultGoalTargetDateForStep } from "@/lib/roadmapGoalUtils";
import { listPersonalPlaylists } from "@/lib/firestore/personalPlaylists";
import type { PersonalPlaylist, RoadmapStep } from "@/types";
import { Check, Target } from "lucide-react";

/**
 * Inline "set a goal from this step" form.
 *
 * Asks which of the user's personal playlists this goal should track rather
 * than guessing: a roadmap step has no stored link to a playlist (suggested
 * playlists are offered at edit time and imported by the user), and a goal
 * linked to the wrong playlist would show confidently wrong progress, which
 * is worse than showing no progress at all. Skipping the step entirely just
 * creates a goal with its own target date.
 */
export function GoalFromStepForm({
  step,
  index,
  busy,
  onCancel,
  onConfirm,
}: {
  step: RoadmapStep;
  index: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (linkedPlaylists: { id: string; title: string }[]) => Promise<void>;
}) {
  const { user } = useAuth();
  const [playlists, setPlaylists] = React.useState<PersonalPlaylist[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = React.useState(true);

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listPersonalPlaylists(user.uid)
      .then((next) => {
        if (!cancelled) setPlaylists(next);
      })
      .catch(() => {
        if (!cancelled) setPlaylists([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPlaylists(false);
      });
    return () => { cancelled = true; };
  }, [user]);

  const linked = playlists
    .filter((playlist) => selectedIds.includes(playlist.id))
    .map((playlist) => ({ id: playlist.id, title: playlist.title }));

  return (
    <div className="mt-2 space-y-2 rounded-md border-dashed border-accent/50 bg-accent/5 p-3">
      <p className="text-xs font-medium">
        New goal: {step.title || `Step ${index + 1}`}
      </p>
      <p className="text-[11px] text-muted-foreground">
        Due {defaultGoalTargetDateForStep(step)}
        {step.week ? ` · step is in week ${step.week}` : " · defaults to 2 weeks out (this step has no week set)"}
      </p>

      {loadingPlaylists ? (
        <p className="text-[11px] text-muted-foreground">Loading your playlists…</p>
      ) : playlists.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No personal playlists yet — the goal will be created without linked content, and you can link it later from{" "}
          <Link href="/goals" className="font-medium text-accent hover:underline">Goals</Link>.
        </p>
      ) : (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">Track progress against (optional):</p>
          <div className="flex flex-wrap gap-1.5">
            {playlists.slice(0, 12).map((playlist) => {
              const active = selectedIds.includes(playlist.id);
              return (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => setSelectedIds((prev) => active ? prev.filter((id) => id !== playlist.id) : [...prev, playlist.id])}
                  className={`rounded-full border px-2.5 py-1 text-xs transition ${active ? "border-accent bg-accent/10 text-accent" : "border-border bg-background hover:border-accent/50"}`}
                >
                  {active && <Check className="mr-1 inline h-3 w-3" />}
                  {playlist.title}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={() => void onConfirm(linked)} loading={busy} disabled={loadingPlaylists}>
          <Target className="mr-1 h-3.5 w-3.5" /> {busy ? "Adding…" : "Add goal"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
