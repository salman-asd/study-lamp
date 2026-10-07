"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { applyGoogleTasksSync, planGoogleTasksSync, type GoogleTasksPlanResponse } from "@/lib/googleClient";
import { countActionableItems } from "@/lib/googleCalendarFlag";
import { describeApplyOutcome, describeResultCode, summarizeApplyResults } from "@/lib/syncMessages";
import type { ConfirmApplyPayload } from "@/components/sync/ConfirmChangesDialog";

export interface TasksSyncOutcome {
  tone: "success" | "warning" | "error";
  message: string;
  details: string[];
}

export interface TasksSyncController {
  plan: GoogleTasksPlanResponse | null;
  checking: boolean;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  bannerCount: number;
  lastOutcome: TasksSyncOutcome | null;
  /** Read-only. Nothing is written. */
  check: (options?: { openDialog?: boolean; announceEmpty?: boolean }) => Promise<void>;
  /** Carries the TASKS plan token of the dialog the user just confirmed. */
  apply: (payload: ConfirmApplyPayload) => Promise<void>;
}

/** Client controller for Tasks sync. Every call is a read-only plan, or an apply that carries a confirmed token. */
export function useTasksSync(options: { connectionId: string; onApplied?: () => void }): TasksSyncController {
  const { user } = useAuth();
  const { connectionId } = options;
  const [plan, setPlan] = useState<GoogleTasksPlanResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<TasksSyncOutcome | null>(null);
  const planRef = useRef<GoogleTasksPlanResponse | null>(null);
  planRef.current = plan;
  const onAppliedRef = useRef(options.onApplied);
  onAppliedRef.current = options.onApplied;

  const check = useCallback<TasksSyncController["check"]>(async ({ openDialog = false, announceEmpty = false } = {}) => {
    if (!user) return;
    setChecking(true);
    try {
      const result = await planGoogleTasksSync(await user.getIdToken(), undefined, connectionId);
      setPlan(result);
      if (result && openDialog && result.items.length > 0) setDialogOpen(true);
      if (announceEmpty && (!result || result.items.length === 0)) toast.success("Study Lamp and Google Tasks are in step. Nothing to change.");
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Couldn't check Google Tasks.");
    } finally {
      setChecking(false);
    }
  }, [user, connectionId]);

  const apply = useCallback(async (payload: ConfirmApplyPayload) => {
    const current = planRef.current;
    if (!user || !current) throw new Error("There is nothing to apply. Check again.");
    // A thrown error (expired token, already applied, Google unreachable) is shown inside the dialog.
    const response = await applyGoogleTasksSync(await user.getIdToken(), { planToken: current.planToken, ...payload, connectionId });
    const tally = summarizeApplyResults(response.results);
    const outcome = describeApplyOutcome(tally);
    const details = response.results
      .filter((result) => result.status !== "applied" && result.code !== "not_accepted")
      .map((result) => describeResultCode(result.code, "tasks"))
      .filter((text, index, all) => text && all.indexOf(text) === index);
    setLastOutcome({ ...outcome, details });
    if (outcome.tone === "success") toast.success(outcome.message);
    else if (outcome.tone === "warning") toast.warning(outcome.message);
    else toast.error(outcome.message);
    if (tally.applied > 0) onAppliedRef.current?.();
    setPlan(null);
    void check();
  }, [user, connectionId, check]);

  return { plan, checking, dialogOpen, setDialogOpen, bannerCount: plan ? countActionableItems(plan.items) : 0, lastOutcome, check, apply };
}
