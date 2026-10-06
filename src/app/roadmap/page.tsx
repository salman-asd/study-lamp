"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { TourChip } from "@/components/tour/TourChip";
import { AiLanguagePicker } from "@/components/ai/AiLanguagePicker";
import { useAiLanguage } from "@/hooks/useAiLanguage";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createCategory, listCategories } from "@/lib/firestore/categoriesTags";
import { listLearningRoadmaps, updateLearningRoadmap, createLearningRoadmap } from "@/lib/firestore/roadmaps";
import { addGoal } from "@/lib/firestore/goals";
import { offerCalendarReview } from "@/lib/calendarGoalHook";
import { useRouter } from "next/navigation";
import { normalizeUserInterests, setUserInterestLevel, setUserInterestSubtopics } from "@/lib/userInterests";
import { renumberSteps } from "@/lib/roadmapUtils";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { parseOnboardingRoadmapOffer, defaultGoalTargetDateForStep } from "@/lib/roadmapGoalUtils";
import type { Category, LearningRoadmap, RoadmapLevel, RoadmapStep, UserInterest } from "@/types";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { FocusEditor } from "./components/FocusEditor";
import { RoadmapPanel } from "./components/RoadmapPanel";
import { OnboardingOfferCard } from "./components/OnboardingOfferCard";
import { ClarifyInterestOptions } from "./components/ClarifyInterestOptions";

export default function RoadmapPage() {
  return (
    <RequireAuth>
      <RoadmapContent />
    </RequireAuth>
  );
}

function RoadmapContent() {
  const { user } = useAuth();
  const router = useRouter();
  const { language, languageForRequest, setLanguage, languageReady } = useAiLanguage();
  const searchParams = useSearchParams();
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [interests, setInterests] = React.useState<UserInterest[]>([]);
  const [personalRoadmaps, setPersonalRoadmaps] = React.useState<Record<string, LearningRoadmap[]>>({});
  const [loading, setLoading] = React.useState(true);

  // Which category cards have their (potentially long) roadmap panel
  // expanded. Collapsed by default once there's more than one interest,
  // so the page doesn't force scrolling past roadmaps you're not looking
  // at right now.
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  const cardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [nextCategories, profileSnap, nextRoadmaps] = await Promise.all([
        listCategories(user.uid),
        getDoc(doc(db, "users", user.uid)),
        listLearningRoadmaps(user.uid),
      ]);
      const profileInterests = normalizeUserInterests(((profileSnap.data() as any)?.interests ?? []) as UserInterest[]);
      setCategories(nextCategories);
      setInterests(profileInterests);
      const byCategory: Record<string, LearningRoadmap[]> = {};
      for (const roadmap of nextRoadmaps) {
        byCategory[roadmap.categoryId] = [...(byCategory[roadmap.categoryId] || []), roadmap];
      }
      setPersonalRoadmaps(byCategory);
    } catch (error: any) {
      toast.error(error?.message || "Failed to load your roadmap data.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  const interestCards = categories.filter((category) => interests.some((interest) => interest.categoryId === category.id));

  // ── Onboarding hand-off (Phase C1) ──
  // Onboarding sends us here with the interest the user just picked. We show
  // an explicit offer rather than generating silently, and the offer is
  // dismissible — landing on the page later (without the param) never
  // re-triggers it.
  const onboardingOffer = React.useMemo(
    () => parseOnboardingRoadmapOffer(searchParams.get("generate")),
    [searchParams]
  );
  const [offerDismissed, setOfferDismissed] = React.useState(false);
  // Tracks which offer we've already auto-revealed, so a re-render (or a
  // user collapsing the card again) doesn't keep forcing it back open.
  const [offerRevealedFor, setOfferRevealedFor] = React.useState<string | null>(null);
  const [offerGenerating, setOfferGenerating] = React.useState(false);

  React.useEffect(() => {
    if (loading || offerDismissed || !onboardingOffer) return;
    if (offerRevealedFor === onboardingOffer.categoryId) return;
    // Reveal the offered category's panel so the roadmap the user is about to
    // say yes to appears in place, instead of behind a collapsed card.
    if (interestCards.some((card) => card.id === onboardingOffer.categoryId)) {
      setOfferRevealedFor(onboardingOffer.categoryId);
      setExpandedIds((prev) => new Set(prev).add(onboardingOffer.categoryId));
    }
  }, [loading, offerDismissed, onboardingOffer, offerRevealedFor, interestCards]);

  async function acceptOnboardingOffer() {
    if (!onboardingOffer) return;
    setOfferGenerating(true);
    try {
      await generateOrRegenerate(onboardingOffer.categoryId, onboardingOffer.level, undefined);
      setOfferDismissed(true);
    } finally {
      setOfferGenerating(false);
    }
  }

  /**
   * Phase C1: interests changed in Settings AFTER a roadmap was generated.
   * Regenerating silently would throw away a roadmap the user may have
   * hand-edited, so instead we surface a prompt with an explicit action.
   */
  const staleRoadmapInterests = React.useMemo(() => {
    const roadmapCategoryIds = new Set(Object.keys(personalRoadmaps).filter((id) => (personalRoadmaps[id] ?? []).some((r) => r.steps.length > 0)));
    const interestIds = new Set(interests.map((interest) => interest.categoryId));
    // Interests that have a generated roadmap are "covered". Roadmaps whose
    // category is no longer an interest are "stale" and worth mentioning.
    const orphaned = [...roadmapCategoryIds].filter((id) => !interestIds.has(id));
    return orphaned
      .map((id) => categories.find((category) => category.id === id))
      .filter((category): category is Category => !!category);
  }, [personalRoadmaps, interests, categories]);

  // Auto-expand the only interest so a first-time / single-topic user
  // isn't stuck clicking to reveal the one thing on the page.
  const soleInterestId = interestCards.length === 1 ? interestCards[0]?.id : null;
  React.useEffect(() => {
    if (soleInterestId) {
      setExpandedIds(new Set([soleInterestId]));
    }
  }, [soleInterestId]);

  function toggleExpanded(categoryId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }

  function jumpTo(categoryId: string) {
    setExpandedIds((prev) => new Set(prev).add(categoryId));
    requestAnimationFrame(() => {
      cardRefs.current[categoryId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Every category+level has exactly ONE roadmap doc per user. This
  // single function handles both "Generate" (roadmap is undefined) and
  // "Regenerate" (roadmap already exists) — the API route upserts either
  // way, so the caller never has to think about which case it is.
  async function generateOrRegenerate(categoryId: string, level: RoadmapLevel, roadmap: LearningRoadmap | undefined) {
    if (!user || !languageReady) return;
    const category = categories.find((item) => item.id === categoryId);
    const matchedInterest = interests.find((item) => item.categoryId === categoryId);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/ai/roadmap/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId,
          categoryName: category?.name || "Learning topic",
          level,
          subtopics: matchedInterest?.subtopics ?? [],
          roadmapId: roadmap?.id,
          language: languageForRequest,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to generate this roadmap.");
      await load();
      toast.success(roadmap ? "Roadmap regenerated." : `${level[0].toUpperCase()}${level.slice(1)} roadmap generated.`);
    } catch (error: any) {
      toast.error(error?.message || "Unable to generate the roadmap.");
    }
  }

  // Switching level is just a preference change — no roadmap is created
  // or removed as a side effect. Basic and intermediate (and advanced)
  // are always separate documents; this only changes which one shows.
  async function setActiveLevel(categoryId: string, level: RoadmapLevel) {
    if (!user) return;
    try {
      const profileSnap = await getDoc(doc(db, "users", user.uid));
      const existing = normalizeUserInterests(((profileSnap.data() as any)?.interests ?? []) as UserInterest[]);
      const next = setUserInterestLevel(existing, categoryId, level);
      await updateDoc(doc(db, "users", user.uid), { interests: next });
      await load();
    } catch (error: any) {
      toast.error(error?.message || "Unable to switch level.");
    }
  }

  /**
   * Phase C2: turns a roadmap step into a real, trackable Goal.
   *
   * Links whatever content that step already points at (the playlists the
   * user added to their library from this roadmap via "Add to my Playlists"),
   * so the goal's progress reflects real watch state instead of being a plain
   * checkbox. The target date defaults off the step's own week.
   */
  async function createGoalFromStep(step: RoadmapStep, index: number, linkedPlaylists: { id: string; title: string }[]) {
    if (!user) return;
    const goalTitle = step.title.trim() || `Step ${index + 1}`;
    try {
      const newGoalId = await addGoal(user.uid, {
        title: goalTitle,
        notes: step.description?.trim() || `From your roadmap step ${index + 1}.`,
        targetDate: defaultGoalTargetDateForStep(step),
        linkedPlaylists: linkedPlaylists.length > 0 ? linkedPlaylists : undefined,
      });
      toast.success(`Added "${goalTitle}" to your Goals.`);
      void offerCalendarReview(user, newGoalId, () => router.push("/goals?calendarReview=1"));
    } catch (error: any) {
      toast.error(error?.message || "Unable to create a goal for this step.");
    }
  }

  async function saveRoadmapSteps(categoryId: string, level: RoadmapLevel, roadmap: LearningRoadmap | undefined, steps: RoadmapStep[]) {
    if (!user) return;
    const normalized = renumberSteps(steps);

    if (roadmap) {
      setPersonalRoadmaps((prev) => {
        const list = prev[categoryId] || [];
        return {
          ...prev,
          [categoryId]: list.map((item) => (item.id === roadmap.id ? { ...item, steps: normalized } : item)),
        };
      });
      try {
        await updateLearningRoadmap(user.uid, roadmap.id, normalized);
      } catch (error: any) {
        toast.error(error?.message || "Unable to save your roadmap edit.");
        await load();
      }
      return;
    }

    if (normalized.length === 0) return;
    try {
      await createLearningRoadmap(user.uid, categoryId, level, normalized, "imported");
      await load();
      toast.success("Roadmap created.");
    } catch (error: any) {
      toast.error(error?.message || "Unable to create your roadmap.");
    }
  }

  const [clarifyOptions, setClarifyOptions] = React.useState<{ label: string; description: string }[] | null>(null);
  const [clarifyPendingName, setClarifyPendingName] = React.useState("");

  async function addInterestFromName(nextName: string) {
    if (!user || !nextName.trim()) return;
    const trimmed = nextName.trim();
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/ai/roadmap/clarify", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, kind: "topic", language: languageForRequest }),
      });
      const result = await res.json().catch(() => ({ ambiguous: false }));
      if (res.ok && result?.ambiguous && result.options?.length) {
        setClarifyOptions(result.options);
        setClarifyPendingName(trimmed);
        return;
      }
    } catch {
      // best-effort — fall through to creating the interest as typed
    }
    await createInterest(trimmed);
  }

  async function createInterest(name: string) {
    if (!user) return;
    try {
      const categoryId = await createCategory(name, user.uid);
      const nextInterests = normalizeUserInterests([
        ...interests,
        { categoryId, level: null },
      ]);
      await updateDoc(doc(db, "users", user.uid), { interests: nextInterests });
      setInterests(nextInterests);
      setClarifyOptions(null);
      setClarifyPendingName("");
      setNewInterestName("");
      await load();
      toast.success("Interest added to your roadmap.");
    } catch (error: any) {
      toast.error(error?.message || "Unable to add this interest.");
    }
  }

  async function saveFocus(categoryId: string, subtopics: string[]) {
    if (!user) return;
    try {
      const profileSnap = await getDoc(doc(db, "users", user.uid));
      const existing = normalizeUserInterests(((profileSnap.data() as any)?.interests ?? []) as UserInterest[]);
      const next = setUserInterestSubtopics(existing, categoryId, subtopics);
      await updateDoc(doc(db, "users", user.uid), { interests: next });
      await load();
      toast.success("Focus updated. Regenerate to reflect it in your roadmap.");
    } catch (error: any) {
      toast.error(error?.message || "Unable to update your focus.");
    }
  }

  const [newInterestName, setNewInterestName] = React.useState("");

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-6 py-8">
        <div className="space-y-2" data-tour="r-header">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-accent">Roadmap</p>
          <h1 className="font-display text-3xl font-semibold">Your learning path</h1>
          <p className="text-muted-foreground">Choose a level for each interest and keep a personal, editable roadmap for it.</p>
          <AiLanguagePicker label="Language for AI actions on this page" value={language} onChange={setLanguage} disabled={!languageReady || offerGenerating} />
          <TourChip tourId="roadmap" />
        </div>

        {!loading && onboardingOffer && !offerDismissed && (
          <OnboardingOfferCard
            offer={onboardingOffer}
            generating={offerGenerating}
            onAccept={() => void acceptOnboardingOffer()}
            onDismiss={() => setOfferDismissed(true)}
          />
        )}

        {!loading && staleRoadmapInterests.length > 0 && (
          <Card className="border-dashed">
            <CardContent className="space-y-2 p-4">
              <p className="text-sm font-medium">Your interests changed since you built these roadmaps</p>
              <p className="text-sm text-muted-foreground">
                You no longer list {staleRoadmapInterests.map((c) => c.name).join(", ")} as an interest, but the
                roadmaps you generated for them are still here. Nothing is deleted automatically — regenerate them
                from the cards below, or add the interest back in Settings to keep tracking them.
              </p>
            </CardContent>
          </Card>
        )}

        {loading && <p className="text-sm text-muted-foreground">Loading roadmap data…</p>}

        {!loading && interestCards.length === 0 && (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="space-y-1">
                <h2 className="font-display text-xl font-semibold">No interests yet</h2>
                <p className="text-sm text-muted-foreground">Add a topic you want to learn so Study Lamp can build a roadmap and suggestions around it.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={newInterestName}
                  onChange={(event) => setNewInterestName(event.target.value)}
                  placeholder="e.g. Product design"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addInterestFromName(newInterestName);
                  }}
                />
                <Button onClick={() => void addInterestFromName(newInterestName)} disabled={!newInterestName.trim()}>
                  Add interest
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {categories.slice(0, 10).map((category) => (
                  <Button
                    key={category.id}
                    variant="outline"
                    size="sm"
                    onClick={() => void addInterestFromName(category.name)}
                  >
                    {category.name}
                  </Button>
                ))}
              </div>
              {clarifyOptions && (
                <ClarifyInterestOptions options={clarifyOptions} pendingName={clarifyPendingName} onPick={(name) => void createInterest(name)} />
              )}
            </CardContent>
          </Card>
        )}

        {/* Quick-jump bar: only worth showing once there's more than one
            interest to jump between. Sticky so it stays reachable while
            scrolling a long page; horizontally scrollable so it doesn't
            wrap awkwardly on narrow screens. */}
        {!loading && interestCards.length > 1 && (
          <div className="sticky top-0 z-10 -mx-1 overflow-x-auto bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="flex w-max gap-2">
              {interestCards.map((category) => (
                <Button
                  key={category.id}
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => jumpTo(category.id)}
                >
                  {category.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {interestCards.map((category) => {
            const matchedInterest = interests.find((interest) => interest.categoryId === category.id);
            const level = matchedInterest?.level ?? "basic";
            const personal = personalRoadmaps[category.id] ?? [];
            const activeRoadmap = personal.find((item) => item.level === level);
            const levelsWithRoadmap = new Set(personal.filter((r) => r.steps.length > 0).map((r) => r.level));
            const isExpanded = expandedIds.has(category.id);

            return (
              <Card key={category.id} ref={(el) => { cardRefs.current[category.id] = el; }}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-xl font-semibold">{category.name}</h2>
                      <p className="text-sm text-muted-foreground">Current level: {level}</p>
                      {matchedInterest?.subtopics?.length ? (
                        <p className="text-xs text-muted-foreground">Focus: {matchedInterest.subtopics.join(", ")}</p>
                      ) : null}
                      <FocusEditor
                        categoryName={category.name}
                        currentSubtopics={matchedInterest?.subtopics ?? []}
                        language={languageForRequest}
                        onSave={(subtopics) => saveFocus(category.id, subtopics)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(["basic", "intermediate", "advanced"] as RoadmapLevel[]).map((nextLevel) => (
                        <Button
                          key={nextLevel}
                          size="sm"
                          variant={nextLevel === level ? "default" : "outline"}
                          onClick={() => void setActiveLevel(category.id, nextLevel)}
                          title={levelsWithRoadmap.has(nextLevel) ? `${nextLevel} already has a roadmap` : `No roadmap yet for ${nextLevel}`}
                        >
                          {nextLevel === level && <Check className="mr-1 h-3.5 w-3.5" />}
                          {nextLevel}
                          {levelsWithRoadmap.has(nextLevel) && (
                            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-label="Roadmap exists" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleExpanded(category.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-left hover:bg-muted/50"
                  >
                    <span className="flex items-center gap-2">
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {activeRoadmap && activeRoadmap.steps.length > 0
                        ? `Roadmap — ${activeRoadmap.steps.length} steps`
                        : "No roadmap yet for this level"}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">{isExpanded ? "Hide" : "Show"}</span>
                  </button>

                  {isExpanded && (
                    <RoadmapPanel
                      category={category}
                      level={level}
                      language={languageForRequest}
                      subtopics={matchedInterest?.subtopics ?? []}
                      roadmap={activeRoadmap}
                      onGenerateOrRegenerate={() => generateOrRegenerate(category.id, level, activeRoadmap)}
                      onSaveSteps={(steps) => saveRoadmapSteps(category.id, level, activeRoadmap, steps)}
                      onCreateGoal={createGoalFromStep}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
