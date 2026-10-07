"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { applyGoogleTasksSync, getGoogleTasksStatus, GoogleApiError, isAmbiguousConnectionError, planGoogleTasksSync, type GoogleTasksPlanResponse } from "@/lib/googleClient";
import { readSyncConnectionId, readTasksFlag, writeSyncConnectionId, writeTasksFlag } from "@/lib/googleCalendarFlag";
import { countActionableItems } from "@/lib/googleCalendarFlag";
import { describeApplyOutcome, describeResultCode, summarizeApplyResults } from "@/lib/syncMessages";
import type { ConfirmApplyPayload } from "@/components/sync/ConfirmChangesDialog";

export interface TasksSyncOutcome {
  tone: "success" | "warning" | "error";
  message: string;
  details: string[];
}

export interface UseTasksSyncOptions {
  /** Settings page: the connection this card belongs to. Omit on the goals page (the cached one is used). */
  connectionId?: string;
  onApplied?: () => void;
  /**
   * Goals page: learn whether Tasks sync is on (cached flag first, one cheap status call when unknown) so goal changes
   * can be checked. Off by default; the settings card already knows.
   */
  detectEnabled?: boolean;
}

export interface TasksSyncController {
  /** Tasks sync is on for this user (goals page only; the settings card ignores it). */
  enabled: boolean;
  plan: GoogleTasksPlanResponse | null;
  checking: boolean;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  bannerCount: number;
  lastOutcome: TasksSyncOutcome | null;
  /** Several Google connections have Tasks sync on and the user must keep it on for just one (audit M2). */
  connectionProblem: boolean;
  /** Read-only. Nothing is written. */
  check: (options?: { openDialog?: boolean; announceEmpty?: boolean }) => Promise<void>;
  /**
   * After a goal was added/edited/completed: a read-only look at that one goal, with a "N changes ready" toast (audit M3).
   * Does nothing when Tasks sync is off. Never writes.
   */
  checkGoal: (goalId: string) => Promise<void>;
  /** Carries the TASKS plan token of the dialog the user just confirmed. */
  apply: (payload: ConfirmApplyPayload) => Promise<void>;
}

/** Client controller for Tasks sync. Every call is a read-only plan, or an apply that carries a confirmed token. */
export function useTasksSync(options: UseTasksSyncOptions = {}): TasksSyncController {
  const { user } = useAuth();
  const { connectionId, detectEnabled = false } = options;
  const uid = user?.uid ?? null;
  const [enabled, setEnabled] = useState(false);
  const [plan, setPlan] = useState<GoogleTasksPlanResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<TasksSyncOutcome | null>(null);
  const [connectionProblem, setConnectionProblem] = useState(false);
  const planRef = useRef<GoogleTasksPlanResponse | null>(null);
  planRef.current = plan;
  const enabledRef = useRef(false);
  const onAppliedRef = useRef(options.onApplied);
  onAppliedRef.current = options.onApplied;

  const currentConnectionId = useCallback((): string | undefined => {
    if (connectionId) return connectionId;
    return uid ? readSyncConnectionId(uid, "tasks") ?? undefined : undefined;
  }, [connectionId, uid]);

  const noteCheckError = useCallback((error: unknown) => {
    if (isAmbiguousConnectionError(error)) {
      setConnectionProblem(true);
      return;
    }
    if (!connectionId && uid && error instanceof GoogleApiError && error.status === 404) writeSyncConnectionId(uid, "tasks", null);
  }, [connectionId, uid]);

  // Goals page: learn whether Tasks sync is on. Cached flag first; one cheap status call (no Google call) when unknown.
  useEffect(() => {
    if (!user || !detectEnabled) return;
    let cancelled = false;
    (async () => {
      let flag = readTasksFlag(user.uid);
      if (flag === null) {
        try {
          const status = await getGoogleTasksStatus(await user.getIdToken(), currentConnectionId());
          flag = status.enabled;
          writeTasksFlag(user.uid, flag);
          if (flag && status.connectionId) writeSyncConnectionId(user.uid, "tasks", status.connectionId);
        } catch (error) {
          if (isAmbiguousConnectionError(error)) setConnectionProblem(true);
          flag = false;
        }
      }
      if (cancelled) return;
      enabledRef.current = flag;
      setEnabled(flag);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, detectEnabled]);

  const check = useCallback<TasksSyncController["check"]>(async ({ openDialog = false, announceEmpty = false } = {}) => {
    if (!user) return;
    setChecking(true);
    try {
      const result = await planGoogleTasksSync(await user.getIdToken(), undefined, currentConnectionId());
      setConnectionProblem(false);
      setPlan(result);
      if (result && openDialog && result.items.length > 0) setDialogOpen(true);
      if (announceEmpty && (!result || result.items.length === 0)) toast.success("Study Lamp and Google Tasks are in step. Nothing to change.");
    } catch (error) {
      noteCheckError(error);
      toast.error(error instanceof Error && error.message ? error.message : "Couldn't check Google Tasks.");
    } finally {
      setChecking(false);
    }
  }, [user, currentConnectionId, noteCheckError]);

  const checkGoal = useCallback(async (goalId: string) => {
    if (!user || !enabledRef.current) return;
    try {
      const result = await planGoogleTasksSync(await user.getIdToken(), [goalId], currentConnectionId());
      setConnectionProblem(false);
      if (!result) return;
      const ready = countActionableItems(result.items);
      if (ready === 0) return;
      setPlan(result);
      toast(`Google Tasks: ${ready} change${ready === 1 ? "" : "s"} ready to review`, {
        action: { label: "Review", onClick: () => setDialogOpen(true) },
        duration: 10_000,
      });
    } catch (error) {
      // The goal was saved either way. "Several connections" shows as a banner; other problems are in Settings.
      noteCheckError(error);
    }
  }, [user, currentConnectionId, noteCheckError]);

  const apply = useCallback(async (payload: ConfirmApplyPayload) => {
    const current = planRef.current;
    if (!user || !current) throw new Error("There is nothing to apply. Check again.");
    const resolvedConnectionId = currentConnectionId();
    // A thrown error (expired token, already applied, Google unreachable) is shown inside the dialog.
    const response = await applyGoogleTasksSync(await user.getIdToken(), { planToken: current.planToken, ...payload, ...(resolvedConnectionId ? { connectionId: resolvedConnectionId } : {}) });
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
  }, [user, currentConnectionId, check]);

  return {
    enabled,
    plan,
    checking,
    dialogOpen,
    setDialogOpen,
    bannerCount: plan ? countActionableItems(plan.items) : 0,
    lastOutcome,
    connectionProblem,
    check,
    checkGoal,
    apply,
  };
}
