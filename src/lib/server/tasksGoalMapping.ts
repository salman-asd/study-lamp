import crypto from "crypto";
import { isoDatePart, isValidIsoDate } from "@/lib/isoDate";
import { GOAL_TITLE_MAX } from "@/lib/server/googleCalendar";
import type { PlanAttentionReason } from "@/lib/sync/plan";

/**
 * Pure mapping between a Study Lamp goal and a Google Task (W4). No Firestore, no fetch.
 *
 * What syncs:
 *   title, due date, completed  -> both ways (after the user confirms)
 *   notes, priority             -> Study Lamp -> Google only (written into the task notes, never read back)
 */

export const TASK_TITLE_MAX = 1024;
export const TASK_NOTES_MAX = 8192;

/** The shape of a task as Google returns it. Only the fields we use. */
export interface GoogleTaskLike {
  id?: string | null;
  etag?: string | null;
  title?: string | null;
  notes?: string | null;
  status?: string | null;
  due?: string | null;
  completed?: string | null;
  deleted?: boolean | null;
  hidden?: boolean | null;
  updated?: string | null;
}

export interface TaskGoalInput {
  id: string;
  title?: string | null;
  notes?: string | null;
  priority?: string | null;
  targetDate?: string | null;
  completed?: boolean | null;
}

/** What we send to tasks.insert / tasks.patch. `due: null` and `completed: null` CLEAR the field in Google. */
export interface TaskPayload {
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string | null;
  completed?: null;
}

const MARKER_RE = /\[studylamp:([A-Za-z0-9_-]{1,128})\]/;

/** The marker line that lets Study Lamp find its own task again (also after a crash mid-create). */
export function taskMarker(goalId: string): string {
  return `[studylamp:${goalId}]`;
}

/** Reads the goal id out of a task's notes, or null when the task is not ours. */
export function parseTaskMarker(notes: string | null | undefined): string | null {
  if (typeof notes !== "string") return null;
  return MARKER_RE.exec(notes)?.[1] ?? null;
}

/** Notes sent to Google: the goal notes, a priority line, and the marker as the LAST line. Capped, marker always kept. */
export function buildTaskNotes(goal: Pick<TaskGoalInput, "id" | "notes" | "priority">): string {
  const marker = taskMarker(goal.id);
  const priority = goal.priority ? `Priority: ${goal.priority}` : "";
  const tail = [priority, marker].filter(Boolean).join("\n");
  const body = (goal.notes ?? "").trim();
  const room = TASK_NOTES_MAX - tail.length - 2;
  const cutBody = body.slice(0, Math.max(0, room));
  return cutBody ? `${cutBody}\n\n${tail}` : tail;
}

/** Changes when the notes or priority we would send change. Stored in the mapping so notes only travel when edited. */
export function notesFingerprint(goal: Pick<TaskGoalInput, "id" | "notes" | "priority">): string {
  return crypto.createHash("sha256").update(buildTaskNotes(goal)).digest("hex").slice(0, 32);
}

/** Tasks keeps only the date of `due`; the time part is always midnight UTC. */
export function dueFromDate(targetDate: string | null | undefined): string | null {
  return typeof targetDate === "string" && isValidIsoDate(targetDate) ? `${targetDate}T00:00:00.000Z` : null;
}

/**
 * The full task for a goal (used for create). A goal with no valid date gets `due: null`.
 * A re-opened goal sends status "needsAction" AND `completed: null`, otherwise Google keeps the old completion time.
 */
export function buildTask(goal: TaskGoalInput): TaskPayload {
  const done = Boolean(goal.completed);
  return {
    title: (goal.title ?? "").trim().slice(0, TASK_TITLE_MAX),
    notes: buildTaskNotes(goal),
    status: done ? "completed" : "needsAction",
    due: dueFromDate(goal.targetDate),
    ...(done ? {} : { completed: null }),
  };
}

/** Patch body for a completion change only. */
export function completionPatch(completed: boolean): TaskPayload {
  return completed ? { status: "completed" } : { status: "needsAction", completed: null };
}

export type TaskGoalFields =
  | { attention?: undefined; title: string; targetDate: string | null; completed: boolean }
  | { attention: PlanAttentionReason; title: string; completed: boolean };

/**
 * Reads a task as goal fields, or says why it can't be. Nothing is guessed. Notes are NEVER read back.
 * A task with no due date is fine (targetDate null): the goal simply has no date.
 */
export function taskToGoalFields(task: GoogleTaskLike): TaskGoalFields {
  const title = (task.title ?? "").trim();
  const completed = task.status === "completed";
  const attention = (reason: PlanAttentionReason): TaskGoalFields => ({ attention: reason, title, completed });

  if (task.deleted === true) return attention("cancelled");
  if (!title) return attention("empty_title");
  if (title.length > GOAL_TITLE_MAX) return attention("title_too_long");

  let targetDate: string | null = null;
  if (typeof task.due === "string" && task.due) {
    targetDate = isoDatePart(task.due);
    if (!targetDate) return attention("invalid_date");
  }
  return { title, targetDate, completed };
}
