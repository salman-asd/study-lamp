import type { Goal } from "@/types";
import { buildPlanItem, type PlanFieldChange, type PlanItem } from "@/lib/sync/plan";
import { decideField, type FieldDecision } from "@/lib/sync/threeWay";
import { signPlanToken } from "@/lib/server/planToken";
import { isValidIsoDate } from "@/lib/isoDate";
// READ-ONLY imports: pure helpers and types only. This file must never import anything that can write.
import { buildTaskNotes, parseTaskMarker, notesFingerprint, taskToGoalFields, type GoogleTaskLike } from "@/lib/server/tasksGoalMapping";
import { isCreatingFresh, type GoalSyncMapping, type SyncBase, type TasksMapping } from "@/lib/server/googleSyncMapping";

/** Thrown when the list has more tasks than the page cap, so a comparison would be incomplete. */
export class TasksListTruncatedError extends Error {
  constructor() {
    super("The Study Lamp task list has too many tasks to compare safely.");
    this.name = "TasksListTruncatedError";
  }
}

export type LiveTask = GoogleTaskLike & { id: string };

/** Everything the Tasks planner may touch: three reads. No write method exists here. */
export interface TasksPlanReader {
  listGoals(): Promise<Goal[]>;
  listMappings(): Promise<Map<string, GoalSyncMapping>>;
  /** LIVE tasks from the stored Study Lamp list (all pages; completed, hidden and deleted included). */
  listLiveTasks(): Promise<{ tasks: LiveTask[]; truncated: boolean }>;
}

export interface ConvergedTask {
  goalId: string;
  taskId: string;
  remoteEtag: string | null;
  base: SyncBase;
  notesHash: string;
}

export interface OrphanedTask {
  goalId: string;
  titleSnapshot: string;
  taskId: string | null;
}

export interface TasksPlanResult {
  items: PlanItem[];
  converged: ConvergedTask[];
  orphans: OrphanedTask[];
  counts: { push: number; pull: number; conflict: number; attention: number; remoteDeleted: number; orphaned: number };
  remaining: number;
  planToken: string;
}

const MAX_PLAN_ITEMS = 500;
const MAX_ORPHANS = 50;

// ─── Matching ───────────────────────────────────────────────────────────────

export interface LiveTaskIndex {
  byId: Map<string, LiveTask>;
  byGoalMarker: Map<string, LiveTask>;
}

export function indexLiveTasks(tasks: LiveTask[]): LiveTaskIndex {
  const byId = new Map<string, LiveTask>();
  const byGoalMarker = new Map<string, LiveTask>();
  for (const task of tasks) {
    byId.set(task.id, task);
    const goalId = parseTaskMarker(task.notes);
    if (!goalId) continue;
    const existing = byGoalMarker.get(goalId);
    // Two tasks with one marker (e.g. one deleted, one re-created): a live one wins over a deleted one.
    if (!existing || (existing.deleted === true && task.deleted !== true)) byGoalMarker.set(goalId, task);
  }
  return { byId, byGoalMarker };
}

/** A mapping only counts for the list it was made for (a re-created list starts clean). */
export function activeTasksMapping(mapping: GoalSyncMapping | undefined, listId: string): TasksMapping | null {
  const tasks = mapping?.tasks;
  return tasks && tasks.listId === listId ? tasks : null;
}

/** Order: the task id stored in the mapping, then the notes marker. It NEVER matches on the goal id alone. */
export function findGoalTask(input: { goalId: string; listId: string; mapping: GoalSyncMapping | undefined; index: LiveTaskIndex }): LiveTask | null {
  const mapped = activeTasksMapping(input.mapping, input.listId);
  if (mapped?.taskId) {
    const byMapping = input.index.byId.get(mapped.taskId);
    if (byMapping) return byMapping;
  }
  return input.index.byGoalMarker.get(input.goalId) ?? null;
}

// ─── Decisions (shared by the planner and the apply step) ───────────────────

export interface TasksGoalDecision {
  title: FieldDecision;
  targetDate: FieldDecision;
  completed: FieldDecision;
  /** Notes + priority are Study Lamp -> Google only: pushed when they differ from what was last written. */
  notesPush: boolean;
  localTitle: string;
  localDate: string | null;
}

export function localGoalDate(goal: Goal): string | null {
  return typeof goal.targetDate === "string" && isValidIsoDate(goal.targetDate) ? goal.targetDate : null;
}

/** Three-way decision per field. A missing base (no mapping) passes `undefined`, so any difference is a conflict. */
export function decideTasksGoal(input: {
  goal: Goal;
  remote: { title: string; targetDate: string | null; completed: boolean };
  mapping: TasksMapping | null;
  /** The task's current notes. Used ONLY to decide whether our notes need writing, never copied into the goal. */
  remoteNotes: string | null | undefined;
}): TasksGoalDecision {
  const { goal, remote, mapping } = input;
  const base = mapping?.base ?? null;
  const localTitle = (goal.title ?? "").trim();
  const localDate = localGoalDate(goal);
  const completed = Boolean(goal.completed);
  return {
    title: decideField({ base: base && base.title !== null ? base.title : undefined, local: localTitle, remote: remote.title }),
    targetDate: decideField({ base: base ? base.targetDate : undefined, local: localDate, remote: remote.targetDate }),
    completed: decideField({ base: base ? base.completed : undefined, local: completed, remote: remote.completed }),
    // With a mapping: push when our notes changed since the last write. Without one (task found by marker): push only if Google differs.
    notesPush: mapping && mapping.notesHash !== null ? mapping.notesHash !== notesFingerprint(goal) : (input.remoteNotes ?? "") !== buildTaskNotes(goal),
    localTitle,
    localDate,
  };
}

function hasField(decision: TasksGoalDecision): boolean {
  return [decision.title, decision.targetDate, decision.completed].some((d) => d === "push" || d === "pull" || d === "conflict") || decision.notesPush;
}

function fieldChanges(goal: Goal, remote: { title: string; targetDate: string | null; completed: boolean }, d: TasksGoalDecision): PlanFieldChange[] {
  const fields: PlanFieldChange[] = [];
  const add = (name: string, decision: FieldDecision, local: string | boolean | null, remoteValue: string | boolean | null) => {
    // `before` is the value on the side that would change; `after` is what it would become.
    if (decision === "pull") fields.push({ name, before: local, after: remoteValue, direction: "google" });
    else if (decision === "push") fields.push({ name, before: remoteValue, after: local, direction: "study_lamp" });
    // A conflict has NO direction: the user picks a side per field. Both values travel with it.
    else if (decision === "conflict") fields.push({ name, before: local, after: remoteValue, local, remote: remoteValue });
  };
  add("title", d.title, d.localTitle, remote.title);
  add("targetDate", d.targetDate, d.localDate, remote.targetDate);
  add("completed", d.completed, Boolean(goal.completed), remote.completed);
  if (d.notesPush) fields.push({ name: "notes", before: "Google's notes", after: "Study Lamp's notes and priority", direction: "study_lamp" });
  return fields;
}

function localSnapshot(goal: Goal): string {
  return JSON.stringify([(goal.title ?? "").trim(), goal.targetDate ?? null, Boolean(goal.completed), notesFingerprint(goal)]);
}

function remoteVersion(listId: string, etag: string | null | undefined, fallback: string): string {
  return `${listId}:${etag || fallback}`;
}

// ─── Planner (pure) ─────────────────────────────────────────────────────────

export interface BuildTasksPlanInput {
  uid: string;
  listId: string;
  goals: Goal[];
  mappings: Map<string, GoalSyncMapping>;
  liveTasks: LiveTask[];
  /** Plan only these goals. A partial plan never reports orphans. */
  goalIds?: string[];
  now?: number;
}

export function buildTasksSyncPlan({ uid, listId, goals, mappings, liveTasks, goalIds, now = Date.now() }: BuildTasksPlanInput): TasksPlanResult {
  const isPartial = typeof goalIds !== "undefined" && goalIds.length > 0;
  const filtered = isPartial ? goals.filter((goal) => goalIds!.includes(goal.id)) : goals;
  const index = indexLiveTasks(liveTasks);
  const items: PlanItem[] = [];
  const converged: ConvergedTask[] = [];
  const counts = { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0, orphaned: 0 };

  for (const goal of filtered) {
    const mapping = mappings.get(goal.id);
    const active = activeTasksMapping(mapping, listId);
    const task = findGoalTask({ goalId: goal.id, listId, mapping, index });
    const title = (goal.title ?? "").trim();
    const completed = Boolean(goal.completed);
    const localDate = localGoalDate(goal);
    const target = `tasks-goal:${goal.id}`;
    const localValue = localSnapshot(goal);
    const gone = !task || task.deleted === true;

    // The user chose to stop syncing this goal. Skip it while Google has no live task for it.
    if (active?.status === "unlinked" && gone) continue;

    if (gone) {
      if (active && (active.taskId || task)) {
        // We synced this goal before and Google no longer has the task (or has it marked deleted).
        items.push(buildPlanItem({
          kind: "remote_deleted", target, goalId: goal.id, remoteId: task?.id ?? active.taskId, title,
          fields: [
            { name: "title", before: null, after: title, direction: "study_lamp" },
            { name: "targetDate", before: null, after: localDate, direction: "study_lamp" },
          ],
          localValue, remoteVersion: remoteVersion(listId, task?.etag, "gone"),
        }));
        counts.remoteDeleted += 1;
        continue;
      }
      // Another sync is mid-insert (two-phase create): do not propose a second create.
      if (active?.status === "creating" && isCreatingFresh(active.creatingAt, now)) continue;
      // Old, finished goals are not back-filled into Tasks as completed items.
      if (completed && !active) continue;
      if (!title || title.length > 1024) continue;
      const fields: PlanFieldChange[] = [
        { name: "title", before: null, after: title, direction: "study_lamp" },
        { name: "targetDate", before: null, after: localDate, direction: "study_lamp" },
      ];
      if (completed) fields.push({ name: "completed", before: null, after: true, direction: "study_lamp" });
      if (goal.notes?.trim() || goal.priority) fields.push({ name: "notes", before: null, after: "Study Lamp's notes and priority", direction: "study_lamp" });
      items.push(buildPlanItem({
        kind: "push_create", target, goalId: goal.id, remoteId: null, title, fields,
        localValue, remoteVersion: remoteVersion(listId, null, "new"),
      }));
      counts.push += 1;
      continue;
    }

    const remote = taskToGoalFields(task);
    if (remote.attention) {
      items.push(buildPlanItem({
        kind: "attention", target, goalId: goal.id, remoteId: task.id, title: title || remote.title || "(untitled)", fields: [],
        reason: remote.attention, localValue, remoteVersion: remoteVersion(listId, task.etag, remote.attention),
      }));
      counts.attention += 1;
      continue;
    }

    const decision = decideTasksGoal({ goal, remote, mapping: active, remoteNotes: task.notes });
    const fields = fieldChanges(goal, remote, decision);

    if (!hasField(decision)) {
      // Nothing to propose. If the stored base is behind, remember the agreement (bookkeeping only).
      const stored = active?.base;
      const behind = !stored || stored.title !== title || stored.targetDate !== localDate || stored.completed !== completed || active?.taskId !== task.id;
      if (behind) {
        converged.push({ goalId: goal.id, taskId: task.id, remoteEtag: task.etag ?? null, base: { title, targetDate: localDate, completed }, notesHash: notesFingerprint(goal) });
      }
      continue;
    }

    const hasConflict = [decision.title, decision.targetDate, decision.completed].includes("conflict");
    const hasPull = [decision.title, decision.targetDate, decision.completed].includes("pull");
    const kind: PlanItem["kind"] = hasConflict ? "conflict" : hasPull ? "pull_update" : "push_update";
    items.push(buildPlanItem({
      kind, target, goalId: goal.id, remoteId: task.id, title: title || remote.title, fields,
      localValue, remoteVersion: remoteVersion(listId, task.etag, "none"),
    }));
    if (kind === "conflict") counts.conflict += 1;
    else if (kind === "pull_update") counts.pull += 1;
    else counts.push += 1;
  }

  const orphans: OrphanedTask[] = [];
  if (!isPartial) {
    const goalIdSet = new Set(goals.map((goal) => goal.id));
    for (const [goalId, mapping] of mappings) {
      const active = activeTasksMapping(mapping, listId);
      if (!active || goalIdSet.has(goalId)) continue;
      counts.orphaned += 1;
      if (orphans.length < MAX_ORPHANS) orphans.push({ goalId, titleSnapshot: mapping.titleSnapshot, taskId: active.taskId });
    }
  }

  const sliced = items.slice(0, MAX_PLAN_ITEMS);
  const planToken = signPlanToken({ uid, scope: "tasks", items: sliced.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint })) });
  return { items: sliced, converged, orphans, counts, remaining: Math.max(0, items.length - MAX_PLAN_ITEMS), planToken };
}

/** Preview use-case (ZERO writes): reads goals, mappings and LIVE tasks, then plans. Takes a read-only reader. */
export async function planTasksSync(reader: TasksPlanReader, input: { uid: string; listId: string; goalIds?: string[] }): Promise<TasksPlanResult> {
  const [goals, mappings, live] = await Promise.all([reader.listGoals(), reader.listMappings(), reader.listLiveTasks()]);
  if (live.truncated) throw new TasksListTruncatedError();
  return buildTasksSyncPlan({ uid: input.uid, listId: input.listId, goals, mappings, liveTasks: live.tasks, goalIds: input.goalIds });
}
