import type { PlanItem, SyncResolution } from "@/lib/sync/plan";
import { isValidIsoDate } from "@/lib/isoDate";
import type { ApplyDecision, WriterOutcome } from "@/lib/server/applyGate";
import { applyGoalSyncPlan, buildHistoryEntry } from "@/lib/server/goalSyncApply";
import { GOAL_TITLE_MAX } from "@/lib/server/googleCalendar";
import { GoogleTasksApiError, type TasksWriteClient } from "@/lib/server/googleTasks";
import type { GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import type { GoalSyncMapping, SyncBase, TasksMappingStatus } from "@/lib/server/googleSyncMapping";
import { buildTask, buildTaskNotes, completionPatch, dueFromDate, notesFingerprint, taskToGoalFields, type TaskPayload } from "@/lib/server/tasksGoalMapping";
import {
  activeTasksMapping,
  buildTasksSyncPlan,
  decideTasksGoal,
  findGoalTask,
  indexLiveTasks,
  localGoalDate,
  TasksListTruncatedError,
  type LiveTaskIndex,
  type TasksPlanReader,
} from "@/lib/server/tasksSyncPlan";
import type { TaskGoalExpectation, TaskGoalUpdates } from "@/lib/server/tasksSyncStore";
import type { Goal } from "@/types";

export type TasksPullResult = "ok" | "changed" | "missing";

export interface TasksMappingSave {
  titleSnapshot: string;
  taskId: string | null;
  remoteEtag: string | null;
  base: SyncBase | null;
  notesHash: string | null;
  status?: TasksMappingStatus;
}

/** Writes the Tasks apply step may make. Each is injected so tests can record them. */
export interface TasksApplyDeps extends TasksPlanReader {
  uid: string;
  connectionId: string;
  listId: string;
  client: Pick<TasksWriteClient, "insertTask" | "patchTask">;
  now?: () => number;
  /** Two-phase create, phase 1: one transaction writes a "creating" row, or says "busy". */
  beginCreate(goalId: string, titleSnapshot: string): Promise<"claimed" | "busy">;
  /** Writes ONLY our own mapping doc. */
  saveMapping(goalId: string, input: TasksMappingSave): Promise<void>;
  recordError(goalId: string, code: string): Promise<void>;
  /** Updates the goal AND its mapping in one transaction, only if the goal still equals `expected`. */
  pullGoalFields(goalId: string, expected: TaskGoalExpectation, updates: TaskGoalUpdates, mapping: TasksMappingSave): Promise<TasksPullResult>;
  /** Only ever called for an explicit, separately confirmed "delete_goal". */
  deleteGoal(goalId: string, expected: TaskGoalExpectation): Promise<TasksPullResult>;
  claimToken?: (uid: string, jti: string, exp: number) => Promise<boolean>;
  log?(entry: GoogleSyncLogEntry): Promise<void>;
}

export interface ApplyTasksSyncInput {
  planToken: string;
  accepted: string[];
  resolutions?: Record<string, SyncResolution>;
  confirmedDestructive?: string[];
  maxBookkeeping?: number;
}

export interface ApplyTasksSyncResult {
  results: ApplyDecision[];
  bookkeeping: number;
}

type Field = "title" | "targetDate" | "completed";
type Choice = "use_study_lamp" | "use_google" | undefined;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Values pulled from Google are validated here because the Admin SDK bypasses the Firestore rules. */
export function validateTaskGoalPull(updates: TaskGoalUpdates): "invalid_remote_value" | null {
  if (updates.title !== undefined && (updates.title.trim() === "" || updates.title.length > GOAL_TITLE_MAX)) return "invalid_remote_value";
  if (updates.targetDate !== undefined && updates.targetDate !== null && !isValidIsoDate(updates.targetDate)) return "invalid_remote_value";
  return null;
}

export interface TasksUpdateOutcome {
  goalUpdates: TaskGoalUpdates;
  /** What the Google task must change; empty when Google needs no write. */
  taskUpdates: TaskPayload;
  newBase: SyncBase;
  newNotesHash: string | null;
  /** Conflicting fields the user left on "skip": untouched on both sides. */
  unresolved: Field[];
}

/**
 * Turns the three-way decisions plus the user's per-field choices into concrete writes. Pure: the planner and the
 * writer both call decideTasksGoal, so their views cannot drift.
 */
export function resolveTasksUpdate(input: {
  goal: Goal;
  remote: { title: string; targetDate: string | null; completed: boolean };
  mapping: GoalSyncMapping["tasks"] | null;
  remoteNotes: string | null | undefined;
  choose: (field: Field) => Choice;
}): TasksUpdateOutcome {
  const { goal, remote } = input;
  const mapping = input.mapping ?? null;
  const base = mapping?.base ?? null;
  const decision = decideTasksGoal({ goal, remote, mapping, remoteNotes: input.remoteNotes });
  const localCompleted = Boolean(goal.completed);

  const goalUpdates: TaskGoalUpdates = {};
  const taskUpdates: TaskPayload = {};
  const unresolved: Field[] = [];

  /** Returns which side's value wins for a field, or null when the user left a conflict on skip. */
  const side = (field: Field, d: string): "local" | "google" | "agree" | null => {
    if (d === "pull") return "google";
    if (d === "push") return "local";
    if (d === "conflict") {
      const choice = input.choose(field);
      if (choice === "use_google") return "google";
      if (choice === "use_study_lamp") return "local";
      unresolved.push(field);
      return null;
    }
    return "agree";
  };

  const titleSide = side("title", decision.title);
  const dateSide = side("targetDate", decision.targetDate);
  const doneSide = side("completed", decision.completed);

  if (titleSide === "google" && remote.title !== decision.localTitle) goalUpdates.title = remote.title;
  if (titleSide === "local") taskUpdates.title = decision.localTitle;

  if (dateSide === "google" && remote.targetDate !== decision.localDate) goalUpdates.targetDate = remote.targetDate;
  if (dateSide === "local") taskUpdates.due = dueFromDate(decision.localDate);

  if (doneSide === "google" && remote.completed !== localCompleted) goalUpdates.completed = remote.completed;
  if (doneSide === "local") Object.assign(taskUpdates, completionPatch(localCompleted));

  // Notes and priority: Study Lamp -> Google only, whenever they changed since the last write.
  let newNotesHash = mapping?.notesHash ?? null;
  if (decision.notesPush) {
    taskUpdates.notes = buildTaskNotes(goal);
    newNotesHash = notesFingerprint(goal);
  }

  const pick = <T,>(chosen: "local" | "google" | "agree" | null, local: T, google: T, fallback: T): T =>
    chosen === "google" ? google : chosen === null ? fallback : local;

  const newBase: SyncBase = {
    title: pick(titleSide, decision.localTitle, remote.title, base?.title ?? null),
    targetDate: pick(dateSide, decision.localDate, remote.targetDate, base?.targetDate ?? null),
    completed: pick(doneSide, localCompleted, remote.completed, base?.completed ?? localCompleted),
  };
  return { goalUpdates, taskUpdates, newBase, newNotesHash, unresolved };
}

function goalExpectation(goal: Goal): TaskGoalExpectation {
  return { title: goal.title ?? "", targetDate: goal.targetDate ?? null, completed: Boolean(goal.completed) };
}

// ─── Apply ──────────────────────────────────────────────────────────────────

/**
 * Re-reads CURRENT goals, mappings and LIVE tasks, recomputes the plan, and lets the shared gate decide which items
 * may be written (signed token, one-time id, per-item fingerprint, accepted, destructive confirmation).
 * Everything sent to Google is built here from stored goal data, never from the request.
 */
export async function applyTasksSync(deps: TasksApplyDeps, input: ApplyTasksSyncInput): Promise<ApplyTasksSyncResult> {
  const [goals, mappings, live] = await Promise.all([deps.listGoals(), deps.listMappings(), deps.listLiveTasks()]);
  if (live.truncated) throw new TasksListTruncatedError();

  const plan = buildTasksSyncPlan({ uid: deps.uid, listId: deps.listId, goals, mappings, liveTasks: live.tasks, now: deps.now?.() });
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const index = indexLiveTasks(live.tasks);
  const resolutions = input.resolutions ?? {};

  const writers: Record<string, (item: PlanItem) => Promise<WriterOutcome>> = {};
  for (const item of plan.items) {
    writers[item.itemId] = async (planned) => {
      const goalId = planned.goalId ?? null;
      const goal = goalId ? goalById.get(goalId) : undefined;
      try {
        return await writeItem(deps, { item: planned, goal, mapping: goalId ? mappings.get(goalId) : undefined, index, resolutions });
      } catch (error) {
        // Best effort: note the failure on an existing mapping (this also ends a "busy" state), then let the gate report "failed".
        if (goalId) await deps.recordError(goalId, error instanceof GoogleTasksApiError ? error.kind : "apply_error").catch(() => undefined);
        throw error;
      }
    };
  }

  const results = await applyGoalSyncPlan({
    token: input.planToken,
    accepted: input.accepted,
    resolutions,
    confirmedDestructive: input.confirmedDestructive,
    freshPlan: plan.items,
    expectedUser: deps.uid,
    expectedScope: "tasks",
    writers,
    claimToken: deps.claimToken,
  });

  if (deps.log) {
    const byId = new Map(plan.items.map((item) => [item.itemId, item]));
    for (const decision of results) {
      if (decision.code === "not_accepted") continue;
      const item = byId.get(decision.itemId);
      if (!item) continue;
      try {
        await deps.log(buildHistoryEntry(item, item.goalId ? goalById.get(item.goalId) : undefined, decision.status, new Date(), "tasks"));
      } catch {
        // History is bookkeeping about something that already happened; it must not change the outcome.
      }
    }
  }

  // The single non-confirmed write: remember an agreement as the new base. Own mapping doc only.
  let bookkeeping = 0;
  for (const entry of plan.converged.slice(0, input.maxBookkeeping ?? 100)) {
    const goal = goalById.get(entry.goalId);
    if (!goal) continue;
    try {
      await deps.saveMapping(entry.goalId, { titleSnapshot: goal.title ?? "", taskId: entry.taskId, remoteEtag: entry.remoteEtag, base: entry.base, notesHash: entry.notesHash, status: "synced" });
      bookkeeping += 1;
    } catch {
      // Optional; the next apply retries it.
    }
  }
  return { results, bookkeeping };
}

// ─── Writers ────────────────────────────────────────────────────────────────

interface WriteContext {
  item: PlanItem;
  goal: Goal | undefined;
  mapping: GoalSyncMapping | undefined;
  index: LiveTaskIndex;
  resolutions: Record<string, SyncResolution>;
}
type WithGoal = WriteContext & { goal: Goal };

async function writeItem(deps: TasksApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  if (!ctx.goal) return { skipped: "goal_missing" };
  const withGoal = ctx as WithGoal;
  switch (ctx.item.kind) {
    case "push_create": return writeCreate(deps, withGoal);
    case "push_update":
    case "pull_update":
    case "conflict": return writeUpdate(deps, withGoal);
    case "remote_deleted": return writeRemoteDeleted(deps, withGoal);
    case "attention": return { skipped: "needs_attention" };
    default: return { skipped: "unsupported_kind" };
  }
}

function fieldChoice(ctx: WriteContext, field: Field): Choice {
  const choice = ctx.resolutions[`${ctx.item.itemId}:${field}`] ?? ctx.resolutions[ctx.item.itemId];
  return choice === "use_google" || choice === "use_study_lamp" ? choice : undefined;
}

/** push_create and "recreate": claim (phase 1), insert, save the task id (phase 2). */
async function writeCreate(deps: TasksApplyDeps, ctx: WithGoal): Promise<WriterOutcome> {
  const { goal } = ctx;
  const title = (goal.title ?? "").trim();
  if (!title) return { skipped: "goal_has_no_title" };

  if ((await deps.beginCreate(goal.id, title)) === "busy") return { skipped: "busy" };

  const saved = await deps.client.insertTask(deps.listId, buildTask(goal));
  if (!saved.id) throw new GoogleTasksApiError(502, "unknown", "no_task_id");
  await deps.saveMapping(goal.id, {
    titleSnapshot: title,
    taskId: saved.id,
    remoteEtag: saved.etag ?? null,
    base: { title, targetDate: localGoalDate(goal), completed: Boolean(goal.completed) },
    notesHash: notesFingerprint(goal),
    status: "synced",
  });
}

/**
 * push_update / pull_update / conflict. Per field: pulled fields go to the goal, pushed fields go to Google, a
 * conflicting field follows the user's choice, a field left on "skip" is untouched on both sides.
 * Order: Google first (If-Match = the etag the user saw), then goal + mapping in one transaction.
 */
async function writeUpdate(deps: TasksApplyDeps, ctx: WithGoal): Promise<WriterOutcome> {
  const { goal, mapping, index } = ctx;
  const task = findGoalTask({ goalId: goal.id, listId: deps.listId, mapping, index });
  if (!task || task.deleted === true) return { skipped: "remote_missing" };
  const remote = taskToGoalFields(task);
  if (remote.attention) return { skipped: "remote_unsupported" };

  const active = activeTasksMapping(mapping, deps.listId);
  const outcome = resolveTasksUpdate({ goal, remote, mapping: active, remoteNotes: task.notes, choose: (field) => fieldChoice(ctx, field) });
  const hasGoalUpdates = Object.keys(outcome.goalUpdates).length > 0;
  const hasTaskUpdates = Object.keys(outcome.taskUpdates).length > 0;

  if (!hasGoalUpdates && !hasTaskUpdates && outcome.unresolved.length > 0) return { skipped: "missing_resolution" };
  const invalid = validateTaskGoalPull(outcome.goalUpdates);
  if (invalid) return { skipped: invalid };

  let etag: string | null = task.etag ?? null;
  if (hasTaskUpdates) {
    try {
      const patched = await deps.client.patchTask(deps.listId, task.id, outcome.taskUpdates, { ifMatch: task.etag ?? null });
      etag = patched.etag ?? etag;
    } catch (error) {
      if (error instanceof GoogleTasksApiError && error.kind === "changed_remotely") return { skipped: "changed_remotely" };
      if (error instanceof GoogleTasksApiError && error.kind === "remote_missing") return { skipped: "remote_missing" };
      throw error;
    }
  }

  const save: TasksMappingSave = { titleSnapshot: outcome.newBase.title ?? goal.title ?? "", taskId: task.id, remoteEtag: etag, base: outcome.newBase, notesHash: outcome.newNotesHash, status: "synced" };
  if (hasGoalUpdates) {
    const result = await deps.pullGoalFields(goal.id, goalExpectation(goal), outcome.goalUpdates, save);
    if (result === "missing") return { skipped: "goal_missing" };
    if (result === "changed") return { skipped: "goal_changed" };
    return;
  }
  await deps.saveMapping(goal.id, save);
}

/** remote_deleted: unlink (default, our mapping only), recreate, or delete_goal (own confirmation, enforced by the gate). */
async function writeRemoteDeleted(deps: TasksApplyDeps, ctx: WithGoal): Promise<WriterOutcome> {
  const { goal, item } = ctx;
  const choice = ctx.resolutions[item.itemId];

  if (choice === "unlink") {
    await deps.saveMapping(goal.id, { titleSnapshot: goal.title ?? "", taskId: item.remoteId ?? null, remoteEtag: null, base: null, notesHash: null, status: "unlinked" });
    return;
  }
  if (choice === "recreate") return writeCreate(deps, ctx);
  if (choice === "delete_goal") {
    const result = await deps.deleteGoal(goal.id, goalExpectation(goal));
    if (result === "missing") return { skipped: "goal_missing" };
    if (result === "changed") return { skipped: "goal_changed" };
    return;
  }
  return { skipped: "no_resolution" };
}
