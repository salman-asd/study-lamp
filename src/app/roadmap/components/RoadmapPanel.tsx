"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import type { Category, LearningRoadmap, RoadmapLevel, RoadmapStep } from "@/types";
import { Sparkles, PencilLine, Copy, Eye } from "lucide-react";
import { toast } from "sonner";
import type { AiLanguage } from "@/lib/ai/types";
import { PromptBuilderPanel } from "./PromptBuilderPanel";
import { RoadmapView } from "./RoadmapView";
import { RoadmapEditor } from "./RoadmapEditor";

// ── The single roadmap panel for a category+level. ──

export function RoadmapPanel({
  category,
  level,
  language,
  subtopics,
  roadmap,
  onGenerateOrRegenerate,
  onSaveSteps,
  onCreateGoal,
}: {
  category: Category;
  level: RoadmapLevel;
  language: AiLanguage | undefined;
  subtopics: string[];
  roadmap: LearningRoadmap | undefined;
  onGenerateOrRegenerate: () => Promise<void>;
  onSaveSteps: (steps: RoadmapStep[]) => void;
  onCreateGoal: (step: RoadmapStep, index: number, linkedPlaylists: { id: string; title: string }[]) => Promise<void>;
}) {
  const { user } = useAuth();
  const [mode, setMode] = React.useState<"view" | "customize">("view");
  const [generating, setGenerating] = React.useState(false);

  const [promptOpen, setPromptOpen] = React.useState(false);
  const [promptText, setPromptText] = React.useState<string | null>(null);
  const [promptLoading, setPromptLoading] = React.useState(false);

  const hasSteps = !!roadmap && roadmap.steps.length > 0;

  async function handleGenerate() {
    setGenerating(true);
    try {
      await onGenerateOrRegenerate();
    } finally {
      setGenerating(false);
    }
  }

  async function openPrompt() {
    setPromptOpen(true);
    if (promptText) return;
    if (!user) return;
    setPromptLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/ai/roadmap/prompt", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ categoryName: category.name, level, subtopics, language }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Unable to build the prompt.");
      setPromptText(payload.prompt as string);
    } catch (error: any) {
      toast.error(error?.message || "Unable to build the prompt.");
      setPromptOpen(false);
    } finally {
      setPromptLoading(false);
    }
  }

  async function copyPrompt() {
    if (!promptText) return;
    try {
      await navigator.clipboard.writeText(promptText);
      toast.success("Prompt copied.");
    } catch {
      toast.error("Couldn't copy automatically — select and copy the text manually.");
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {mode === "view" ? <Sparkles className="h-4 w-4 text-accent" /> : <PencilLine className="h-4 w-4 text-accent" />}
          {mode === "view" ? "Suggested roadmap" : "Customize roadmap"}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setMode((m) => (m === "view" ? "customize" : "view"))}>
            {mode === "view" ? (
              <><PencilLine className="mr-1 h-3.5 w-3.5" /> Customize</>
            ) : (
              <><Eye className="mr-1 h-3.5 w-3.5" /> View</>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void handleGenerate()} disabled={generating}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> {generating ? "Generating…" : hasSteps ? "Regenerate" : "Generate"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => (promptOpen ? setPromptOpen(false) : void openPrompt())}>
            <Copy className="mr-1 h-3.5 w-3.5" /> {promptOpen ? "Hide prompt" : "Copy prompt"}
          </Button>
        </div>
      </div>

      {promptOpen && (
        <PromptBuilderPanel
          promptText={promptText}
          loading={promptLoading}
          onCopy={() => void copyPrompt()}
          onClose={() => setPromptOpen(false)}
        />
      )}

      {mode === "view" ? (
        <RoadmapView roadmap={roadmap} onCreateGoal={onCreateGoal} />
      ) : (
        <RoadmapEditor
          category={category}
          level={level}
          roadmap={roadmap}
          onSaveSteps={onSaveSteps}
          onCreateGoal={onCreateGoal}
        />
      )}
    </div>
  );
}
