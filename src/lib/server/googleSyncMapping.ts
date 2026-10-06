import crypto from "crypto";

/** Pure types and parsing for the goal <-> Google mapping docs (users/{uid}/googleSync/{goalId}). No Firestore import, so tests can use it. */

export type CalendarMappingStatus = "synced" | "failed" | "remote_deleted";

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
      const status = c.status === "failed" || c.status === "remote_deleted" ? c.status : "synced";
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
