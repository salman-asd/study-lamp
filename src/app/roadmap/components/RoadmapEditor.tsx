"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { AiLanguagePicker } from "@/components/ai/AiLanguagePicker";
import { useAiLanguage } from "@/hooks/useAiLanguage";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SortableList } from "@/components/dnd/SortableList";
import { addGoal } from "@/lib/firestore/goals";
import { offerCalendarReview } from "@/lib/calendarGoalHook";
import { useRouter } from "next/navigation";
import { buildPlaylistSearchQuery, goalDraftTargetDate, parseImportedRoadmapText } from "@/lib/roadmapUtils";
import { searchPlaylistsForStep, type YouTubePlaylistSearchResult } from "@/lib/roadmapPlaylistClient";
import { suggestGoalsFromRoadmap, type GoalSuggestion } from "@/lib/goalSuggestionsClient";
import type { Category, LearningRoadmap, RoadmapLevel, RoadmapStep } from "@/types";
import { GripVertical, Plus, Trash2, Youtube, Target, Import } from "lucide-react";
import { toast } from "sonner";
import { GoalSuggestionsList } from "./GoalSuggestionsList";

// ── Editable steps + per-step playlist suggestions + goal suggestions. ──

export function RoadmapEditor({
  category,
  level,
  roadmap,
  onSaveSteps,
  onCreateGoal,
}: {
  category: Category;
  level: RoadmapLevel;
  roadmap: LearningRoadmap | undefined;
  onSaveSteps: (steps: RoadmapStep[]) => void;
  onCreateGoal: (step: RoadmapStep, index: number, linkedPlaylists: { id: string; title: string }[]) => Promise<void>;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const steps = roadmap?.steps ?? [];
  // "Suggest goals" has its own picker: it starts on the saved default and overrides only this generation.
  const { language, languageForRequest, setLanguage, languageReady } = useAiLanguage();

  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState<{ title: string; description: string; detailsText: string }>({
    title: "", description: "", detailsText: "",
  });

  const [playlistResults, setPlaylistResults] = React.useState<Record<number, YouTubePlaylistSearchResult[]>>({});
  const [playlistLoading, setPlaylistLoading] = React.useState<number | null>(null);
  const [addedPlaylists, setAddedPlaylists] = React.useState<{ id: string; title: string }[]>([]);

  const [goalSuggestions, setGoalSuggestions] = React.useState<GoalSuggestion[] | null>(null);
  const [goalsLoading, setGoalsLoading] = React.useState(false);

  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");

  function importSteps() {
    const parsed = parseImportedRoadmapText(importText);
    if (parsed.length === 0) {
      toast.error("Couldn't find any steps in that text — try JSON or a numbered list.");
      return;
    }
    onSaveSteps(parsed);
    setImportOpen(false);
    setImportText("");
    toast.success(`Imported ${parsed.length} step${parsed.length === 1 ? "" : "s"}.`);
  }

  function startEdit(index: number, step: RoadmapStep) {
    setEditingIndex(index);
    setDraft({
      title: step.title,
      description: step.description || "",
      detailsText: (step.details ?? []).join("\n"),
    });
  }

  function commitEdit(index: number) {
    const title = draft.title.trim();
    if (!title) {
      toast.error("A step needs a title.");
      return;
    }
    const details = draft.detailsText.split("\n").map((d) => d.trim()).filter(Boolean).slice(0, 6);
    const nextSteps = steps.map((step, i) =>
      i === index
        ? { ...step, title, description: draft.description.trim(), ...(details.length > 0 ? { details } : { details: undefined }) }
        : step
    );
    onSaveSteps(nextSteps);
    setEditingIndex(null);
  }

  function removeStep(index: number) {
    onSaveSteps(steps.filter((_, i) => i !== index));
    setPlaylistResults((prev) => {
      const { [index]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function addStep() {
    onSaveSteps([...steps, { title: "New step", description: "", order: steps.length }]);
  }

  function reorderSteps(nextSteps: RoadmapStep[]) {
    onSaveSteps(nextSteps);
  }

  async function findPlaylists(index: number, step: RoadmapStep) {
    if (!user) return;
    setPlaylistLoading(index);
    try {
      const idToken = await user.getIdToken();
      const query = buildPlaylistSearchQuery(step.title, category.name);
      const results = await searchPlaylistsForStep(idToken, query, 5);
      setPlaylistResults((prev) => ({ ...prev, [index]: results }));
      if (results.length === 0) toast.info("No playlist suggestions found for this step.");
    } catch (error: any) {
      toast.error(error?.message || "Unable to search for playlists right now.");
    } finally {
      setPlaylistLoading(null);
    }
  }

  function trackAddedPlaylist(result: YouTubePlaylistSearchResult) {
    setAddedPlaylists((prev) => (prev.some((p) => p.id === result.playlistId) ? prev : [...prev, { id: result.playlistId, title: result.title }]));
  }

  async function suggestGoals() {
    if (!user) return;
    setGoalsLoading(true);
    try {
      const idToken = await user.getIdToken();
      const suggestions = await suggestGoalsFromRoadmap(idToken, {
        language: languageForRequest,
        categoryName: category.name,
        level,
        steps: steps.map((step) => ({ title: step.title, description: step.description })),
      });
      setGoalSuggestions(suggestions);
    } catch (error: any) {
      toast.error(error?.message || "Unable to suggest goals right now.");
    } finally {
      setGoalsLoading(false);
    }
  }

  async function acceptGoal(suggestion: GoalSuggestion) {
    if (!user) return;
    try {
      const newGoalId = await addGoal(user.uid, {
        title: suggestion.title,
        notes: suggestion.notes,
        targetDate: goalDraftTargetDate(suggestion.daysFromNow),
        linkedPlaylists: addedPlaylists.length > 0 ? addedPlaylists : undefined,
      });
      setGoalSuggestions((prev) => (prev ? prev.filter((item) => item !== suggestion) : prev));
      toast.success(`Added "${suggestion.title}" to your Goals.`);
      void offerCalendarReview(user, newGoalId, () => router.push("/goals?calendarReview=1"));
    } catch (error: any) {
      toast.error(error?.message || "Unable to add this goal.");
    }
  }

  function dismissGoal(suggestion: GoalSuggestion) {
    setGoalSuggestions((prev) => (prev ? prev.filter((item) => item !== suggestion) : prev));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={addStep}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add step
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen((v) => !v)}>
          <Import className="mr-1 h-3.5 w-3.5" /> Paste / import roadmap
        </Button>
        <Button size="sm" variant="outline" onClick={() => void suggestGoals()} disabled={goalsLoading || steps.length === 0 || !languageReady}>
          <Target className="mr-1 h-3.5 w-3.5" /> {goalsLoading ? "Thinking…" : "Suggest goals from this roadmap"}
        </Button>
        <AiLanguagePicker value={language} onChange={setLanguage} disabled={!languageReady || goalsLoading} />
      </div>

      {importOpen && (
        <div className="space-y-2 rounded-md border border-border bg-background p-3">
          <p className="text-xs text-muted-foreground">
            Paste a roadmap you already have — JSON (<code>{"[{title, description, week, details}]"}</code>), the
            reply from another AI you ran the copied prompt on, or a plain numbered list with indented sub-bullets.
            This replaces the steps below.
          </p>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={"1. Learn basic greetings\n   - Practice 10 phrases daily, e.g. \"Nice to meet you\"\n2. ..."}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={importSteps}>Replace steps</Button>
            <Button size="sm" variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {steps.length === 0 && !importOpen && (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
          No steps yet — add one manually or paste in a roadmap above.
        </p>
      )}

      <SortableList
        items={steps}
        getId={(step) => String(steps.indexOf(step))}
        onReorder={reorderSteps}
        className="space-y-2"
        renderItem={(step, dragHandleProps, index) => (
          <div className="rounded-md bg-background p-2">
            <div className="flex gap-2 text-sm">
              <span
                {...dragHandleProps}
                className="mt-1 inline-flex h-5 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </span>
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {step.week ?? index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                {editingIndex === index ? (
                  <div className="space-y-2">
                    <Input
                      value={draft.title}
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      placeholder="Step title"
                      autoFocus
                    />
                    <Textarea
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      placeholder="One-sentence summary of this step"
                      rows={2}
                    />
                    <Textarea
                      value={draft.detailsText}
                      onChange={(e) => setDraft((d) => ({ ...d, detailsText: e.target.value }))}
                      placeholder={'Details, one bullet per line, e.g.\nPractice 10 new words daily\nWrite 3 sentences using today\'s grammar point, e.g. "I have been studying since 9am."'}
                      rows={4}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => commitEdit(index)}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingIndex(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="block w-full text-left" onClick={() => startEdit(index, step)}>
                    <div className="font-medium">
                      {step.week ? <span className="text-muted-foreground">Week {step.week} — </span> : null}
                      {step.title}
                    </div>
                    {step.description && <p className="text-muted-foreground">{step.description}</p>}
                    {step.details && step.details.length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                        {step.details.map((detail, i) => (
                          <li key={i}>{detail}</li>
                        ))}
                      </ul>
                    )}
                  </button>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => void findPlaylists(index, step)}
                    disabled={playlistLoading === index}
                  >
                    <Youtube className="mr-1 h-3.5 w-3.5" />
                    {playlistLoading === index ? "Searching…" : "Suggested playlists"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => void onCreateGoal(step, index, addedPlaylists)}
                  >
                    <Target className="mr-1 h-3.5 w-3.5" /> Set a goal for this step
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => removeStep(index)}>
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                  </Button>
                </div>

                {playlistResults[index] && playlistResults[index].length > 0 && (
                  <div className="grid gap-2 pt-1 sm:grid-cols-2">
                    {playlistResults[index].map((result) => (
                      <div key={result.playlistId} className="flex gap-2 rounded-md border border-border bg-muted/40 p-2">
                        {result.thumbnailUrl && (
                          <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded">
                            <Image src={result.thumbnailUrl} alt={result.title} fill className="object-cover" sizes="80px" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{result.title}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{result.channelTitle}</p>
                          <Link
                            href={`/playlists/import?url=${encodeURIComponent(result.playlistUrl)}`}
                            className="mt-1 inline-block text-[11px] font-medium text-accent hover:underline"
                            onClick={() => trackAddedPlaylist(result)}
                          >
                            Add to my Playlists
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      />

      {goalSuggestions && goalSuggestions.length > 0 && (
        <GoalSuggestionsList suggestions={goalSuggestions} onAccept={(suggestion) => void acceptGoal(suggestion)} onDismiss={dismissGoal} />
      )}
    </div>
  );
}
