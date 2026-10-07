import crypto from "crypto";
import { isValidIsoDate } from "@/lib/isoDate";
import type { GoogleSyncCounts } from "@/types";

/** Pure types and parsing for the goal <-> Google mapping docs (users/{uid}/googleSync/{goalId}). No Firestore import, so tests can use it. */

/**
 * "unlinked": the user chose to stop syncing this goal after its event was deleted in Google. The planner
 * skips it while Google has no live event for it (restoring the event in Google resumes planning).
 */
export type CalendarMappingStatus = "synced" | "failed" | "remote_deleted" | "unlinked";

export interface SyncBase {
  title: string | null;
  targetDate: string | null;
  completed: boolean;
}

export interface CalendarMapping {
  connectionId: string;
  calendarId: string;
  eventId: string;
  remoteEtag: string | null;
  /** What both sides held when they were last known to agree. The "base" of the three-way comparison. */
  base: SyncBase | null;
  hash: string | null;
  status: CalendarMappingStatus;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
}

/**
 * Tasks mapping. "creating" is the first half of the two-phase create: the row exists BEFORE tasks.insert is called,
 * so a crash between insert and save can be recovered by finding the task through its notes marker.
 */
export type TasksMappingStatus = "creating" | "synced" | "failed" | "remote_deleted" | "unlinked";

export interface TasksMapping {
  connectionId: string;
  listId: string;
  /** Null while status is "creating" and the insert has not returned yet. */
  taskId: string | null;
  remoteEtag: string | null;
  base: SyncBase | null;
  /** Fingerprint of the notes + priority last written to Google (they travel Study Lamp -> Google only). */
  notesHash: string | null;
  hash: string | null;
  status: TasksMappingStatus;
  creatingAt: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
}

/** A "creating" row younger than this is treated as another sync still in flight ("busy"). */
export const TASKS_CREATING_STALE_MS = 2 * 60_000;

export function isCreatingFresh(creatingAt: string | null | undefined, now: number, staleMs = TASKS_CREATING_STALE_MS): boolean {
  if (!creatingAt) return false;
  const at = Date.parse(creatingAt);
  return Number.isFinite(at) && now - at < staleMs;
}

export interface GoalSyncMapping {
  goalId: string;
  titleSnapshot: string;
  calendar: CalendarMapping | null;
  /** Optional so Calendar-only code and tests keep compiling. */
  tasks?: TasksMapping | null;
}

export function hashSyncBase(base: SyncBase): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ t: base.title, d: base.targetDate, c: base.completed }))
    .digest("hex");
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function parseBase(value: unknown): SyncBase | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return { title: str(raw.title), targetDate: str(raw.targetDate), completed: raw.completed === true };
}

/** Defensive read of a stored mapping doc. Returns null for anything that is not a usable mapping. */
export function parseGoalSyncMapping(goalId: string, data: unknown): GoalSyncMapping | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const cal = raw.calendar;
  let calendar: CalendarMapping | null = null;

  if (cal && typeof cal === "object") {
    const c = cal as Record<string, unknown>;
    const connectionId = str(c.connectionId);
    const calendarId = str(c.calendarId);
    const eventId = str(c.eventId);
    if (connectionId && calendarId && eventId) {
      const status: CalendarMappingStatus =
        c.status === "failed" || c.status === "remote_deleted" || c.status === "unlinked" ? c.status : "synced";
      calendar = {
        connectionId,
        calendarId,
        eventId,
        remoteEtag: str(c.remoteEtag),
        base: parseBase(c.base),
        hash: str(c.hash),
        status,
        lastSyncAt: isoOf(c.lastSyncAt),
        lastErrorCode: str(c.lastErrorCode),
      };
    }
  }

  return { goalId, titleSnapshot: str(raw.titleSnapshot) ?? "", calendar, tasks: parseTasksMapping(raw.tasks) };
}

function parseTasksMapping(value: unknown): TasksMapping | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  const connectionId = str(t.connectionId);
  const listId = str(t.listId);
  if (!connectionId || !listId) return null;
  const status: TasksMappingStatus =
    t.status === "creating" || t.status === "failed" || t.status === "remote_deleted" || t.status === "unlinked" ? t.status : "synced";
  return {
    connectionId,
    listId,
    taskId: str(t.taskId),
    remoteEtag: str(t.remoteEtag),
    base: parseBase(t.base),
    notesHash: str(t.notesHash),
    hash: str(t.hash),
    status,
    creatingAt: isoOf(t.creatingAt),
    lastSyncAt: isoOf(t.lastSyncAt),
    lastErrorCode: str(t.lastErrorCode),
  };
}

/** Counts for the Tasks card: mapping and goal docs only (no Google call). `noDate` is always 0: goals without a date still get a task. */
export function computeTasksSyncCounts(input: { mappings: Map<string, GoalSyncMapping>; goalIds: Set<string>; listId: string | null }): GoogleSyncCounts {
  const counts: GoogleSyncCounts = { synced: 0, failed: 0, remoteDeleted: 0, unlinked: 0, noDate: 0, orphaned: 0 };
  for (const [goalId, mapping] of input.mappings) {
    const tasks = mapping.tasks;
    if (!tasks || !input.listId || tasks.listId !== input.listId) continue;
    if (!input.goalIds.has(goalId)) counts.orphaned += 1;
    else if (tasks.status === "failed") counts.failed += 1;
    else if (tasks.status === "unlinked") counts.unlinked += 1;
    else if (tasks.status === "remote_deleted") counts.remoteDeleted += 1;
    else if (tasks.status === "synced") counts.synced += 1;
  }
  return counts;
}

/**
 * Counts for the settings card, from mapping docs and goal docs only (no Google call).
 *  - synced / failed / unlinked / remoteDeleted: mappings made for THIS calendar, by their stored status
 *  - orphaned: such a mapping whose goal no longer exists
 *  - noDate: goals without a usable date that have no mapping, so there is nothing to put on a calendar
 * remoteDeleted is only ever non-zero if a mapping was explicitly marked; live deletions are found by the
 * plan ("Check for changes"), not by this function.
 */
export function computeSyncCounts(input: {
  mappings: Map<string, GoalSyncMapping>;
  goals: Array<{ id: string; targetDate?: string | null }>;
  calendarId: string | null;
}): GoogleSyncCounts {
  const counts: GoogleSyncCounts = { synced: 0, failed: 0, remoteDeleted: 0, unlinked: 0, noDate: 0, orphaned: 0 };
  const goalIds = new Set(input.goals.map((goal) => goal.id));

  for (const [goalId, mapping] of input.mappings) {
    const calendar = mapping.calendar;
    if (!calendar || !input.calendarId || calendar.calendarId !== input.calendarId) continue;
    if (!goalIds.has(goalId)) {
      counts.orphaned += 1;
      continue;
    }
    if (calendar.status === "failed") counts.failed += 1;
    else if (calendar.status === "unlinked") counts.unlinked += 1;
    else if (calendar.status === "remote_deleted") counts.remoteDeleted += 1;
    else counts.synced += 1;
  }

  for (const goal of input.goals) {
    const mapped = input.mappings.get(goal.id)?.calendar;
    const hasUsableDate = typeof goal.targetDate === "string" && isValidIsoDate(goal.targetDate);
    if (!hasUsableDate && !mapped) counts.noDate += 1;
  }

  return counts;
}

export type MappingBlock = "calendar" | "tasks";

/**
 * What deleting ONE service's link from a goal's mapping doc must do (audit M1). The doc holds a `calendar` and a
 * `tasks` block side by side, so removing the goal's Calendar link must not drop its Tasks link (and the other way
 * round). "delete_doc": nothing else lives in the doc. "delete_block": the other service's block stays.
 */
export function mappingRemovalAction(data: { calendar?: unknown; tasks?: unknown } | null | undefined, block: MappingBlock): "none" | "delete_doc" | "delete_block" {
  if (!data) return "none";
  const other: MappingBlock = block === "calendar" ? "tasks" : "calendar";
  return data[other] ? "delete_block" : "delete_doc";
}

export const MAX_LISTED_ORPHANS = 50;

/**
 * Mappings whose goal no longer exists, for ONE service and ONE calendar / task list (W5). Reported only, newest
 * information first is not needed: the order is by goal id so the list is stable. At most `limit` entries.
 */
export function listOrphanMappings(input: {
  mappings: Map<string, GoalSyncMapping>;
  goalIds: ReadonlySet<string>;
  block: MappingBlock;
  containerId: string | null;
  limit?: number;
}): Array<{ goalId: string; titleSnapshot: string }> {
  if (!input.containerId) return [];
  const result: Array<{ goalId: string; titleSnapshot: string }> = [];
  for (const [goalId, mapping] of input.mappings) {
    if (input.goalIds.has(goalId)) continue;
    const container = input.block === "calendar" ? mapping.calendar?.calendarId : mapping.tasks?.listId;
    if (container !== input.containerId) continue;
    result.push({ goalId, titleSnapshot: mapping.titleSnapshot });
  }
  result.sort((a, b) => (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0));
  return result.slice(0, input.limit ?? MAX_LISTED_ORPHANS);
}
