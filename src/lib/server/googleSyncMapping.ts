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

export interface GoalSyncMapping {
  goalId: string;
  titleSnapshot: string;
  calendar: CalendarMapping | null;
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

  return { goalId, titleSnapshot: str(raw.titleSnapshot) ?? "", calendar };
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
