import type { Goal } from "@/types";
import { buildPlanItem, type PlanFieldChange, type PlanItem } from "@/lib/sync/plan";
import { decideField, type FieldDecision } from "@/lib/sync/threeWay";
import { signPlanToken } from "@/lib/server/planToken";
import { isValidIsoDate } from "@/lib/isoDate";
// READ-ONLY imports from the Calendar module: pure helpers and types only.
// This file must never import insert/patch/delete/create functions (a test checks the source).
import { buildCalendarEventId, eventToGoalFields, type GoogleCalendarEventLike } from "@/lib/server/googleCalendar";
import type { GoalSyncMapping, SyncBase } from "@/lib/server/googleSyncMapping";

/** A Calendar event as returned by Google right now. */
export type LiveCalendarEvent = GoogleCalendarEventLike & { id: string };

/** Everything the planner is allowed to touch: three reads. No write method exists here. */
export interface CalendarPlanReader {
  listGoals(): Promise<Goal[]>;
  /** Mapping docs by goal id. */
  listMappings(): Promise<Map<string, GoalSyncMapping>>;
  /** LIVE events from Google (all pages, deleted ones included). `truncated` = the page cap was hit. */
  listLiveEvents(): Promise<{ events: LiveCalendarEvent[]; truncated: boolean }>;
}

export class CalendarListTruncatedError extends Error {
  constructor() {
    super("The Study Lamp calendar has too many events to compare safely.");
    this.name = "CalendarListTruncatedError";
  }
}

export interface BuildGoalSyncPlanInput {
  uid: string;
  calendarId: string;
  goals: Goal[];
  mappings: Map<string, GoalSyncMapping>;
  liveEvents: LiveCalendarEvent[];
  goalIds?: string[];
  scope?: "calendar" | "tasks";
}

/** Goal and Google already agree, but the stored base is missing or old. Bookkeeping only, applied in the apply step. */
export interface ConvergedGoal {
  goalId: string;
  eventId: string;
  remoteEtag: string | null;
  base: SyncBase;
}

export interface GoalSyncPlanResult {
  items: PlanItem[];
  converged: ConvergedGoal[];
  counts: {
    push: number;
    pull: number;
    conflict: number;
    attention: number;
    remoteDeleted: number;
  };
  remaining: number;
  planToken: string;
}

const MAX_PLAN_ITEMS = 500;

function isValidGoalDate(value: string | null | undefined): value is string {
  return typeof value === "string" && isValidIsoDate(value);
}

// ─── Matching ───────────────────────────────────────────────────────────────

export interface LiveEventIndex {
  byId: Map<string, LiveCalendarEvent>;
  byGoalMarker: Map<string, LiveCalendarEvent>;
}

export function indexLiveEvents(uid: string, events: LiveCalendarEvent[]): LiveEventIndex {
  const byId = new Map<string, LiveCalendarEvent>();
  const byGoalMarker = new Map<string, LiveCalendarEvent>();

  for (const event of events) {
    byId.set(event.id, event);
    const goalId = event.extendedProperties?.private?.studylampGoalId;
    if (!goalId) continue;
    const existing = byGoalMarker.get(goalId);
    // Two events with one marker: prefer our deterministic id, then a live one over a cancelled one.
    const isCanonical = event.id === buildCalendarEventId(uid, goalId);
    const existingCanonical = existing ? existing.id === buildCalendarEventId(uid, goalId) : false;
    if (!existing || (isCanonical && !existingCanonical) || (!existingCanonical && existing.status === "cancelled" && event.status !== "cancelled")) {
      byGoalMarker.set(goalId, event);
    }
  }
  return { byId, byGoalMarker };
}

/**
 * Finds the live event for a goal. Order: the event id stored in the mapping (for this calendar), then the
 * deterministic id for (uid, goalId), then the private marker. It NEVER matches on the goal id alone.
 */
export function findGoalEvent(input: {
  uid: string;
  goalId: string;
  calendarId: string;
  mapping: GoalSyncMapping | undefined;
  index: LiveEventIndex;
}): LiveCalendarEvent | null {
  const { uid, goalId, calendarId, mapping, index } = input;
  const mapped = activeCalendarMapping(mapping, calendarId);
  if (mapped) {
    const byMapping = index.byId.get(mapped.eventId);
    if (byMapping) return byMapping;
  }
  const byDeterministicId = index.byId.get(buildCalendarEventId(uid, goalId));
  if (byDeterministicId) return byDeterministicId;
  return index.byGoalMarker.get(goalId) ?? null;
}

/** A mapping only counts for the calendar it was made for (a re-created calendar starts clean). */
export function activeCalendarMapping(mapping: GoalSyncMapping | undefined, calendarId: string) {
  const calendar = mapping?.calendar;
  return calendar && calendar.calendarId === calendarId ? calendar : null;
}

// ─── Field decisions ────────────────────────────────────────────────────────

export interface FieldDecisions {
  title: FieldDecision;
  targetDate: FieldDecision;
}

/** Three-way decision for title and date. A missing base (no mapping) is passed as `undefined`, which makes any difference a conflict. */
export function decideGoalFields(input: {
  base: SyncBase | null;
  local: { title: string; targetDate: string };
  remote: { title: string; targetDate: string };
}): FieldDecisions {
  const baseTitle = input.base && input.base.title !== null ? input.base.title : undefined;
  const baseDate = input.base && input.base.targetDate !== null ? input.base.targetDate : undefined;
  return {
    title: decideField({ base: baseTitle, local: input.local.title, remote: input.remote.title }),
    targetDate: decideField({ base: baseDate, local: input.local.targetDate, remote: input.remote.targetDate }),
  };
}

function localSnapshot(goal: Goal): string {
  return JSON.stringify([goal.title ?? "", goal.targetDate ?? null, Boolean(goal.completed)]);
}

function remoteVersion(calendarId: string, etag: string | null | undefined, fallback: string): string {
  return `${calendarId}:${etag || fallback}`;
}

// ─── Planner (pure) ─────────────────────────────────────────────────────────

export function buildGoalSyncPlan({ uid, calendarId, goals, mappings, liveEvents, goalIds, scope = "calendar" }: BuildGoalSyncPlanInput): GoalSyncPlanResult {
  const filteredGoals = typeof goalIds === "undefined" || goalIds.length === 0
    ? goals
    : goals.filter((goal) => goalIds.includes(goal.id));

  const index = indexLiveEvents(uid, liveEvents);
  const items: PlanItem[] = [];
  const converged: ConvergedGoal[] = [];
  const counts = { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0 };

  for (const goal of filteredGoals) {
    const mapping = mappings.get(goal.id);
    const activeMapping = activeCalendarMapping(mapping, calendarId);
    const event = findGoalEvent({ uid, goalId: goal.id, calendarId, mapping, index });
    const localTitle = goal.title ?? "";
    const localTargetDate = goal.targetDate ?? null;
    const localValue = localSnapshot(goal);
    const target = `goal:${goal.id}`;

    if (!event) {
      if (activeMapping) {
        // We synced this goal before and Google no longer has the event at all.
        items.push(buildPlanItem({
          kind: "remote_deleted",
          target,
          goalId: goal.id,
          remoteId: activeMapping.eventId,
          title: localTitle,
          fields: [
            { name: "title", before: null, after: localTitle, direction: "study_lamp" },
            { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
          ],
          risk: "destructive",
          localValue,
          remoteVersion: remoteVersion(calendarId, null, "gone"),
        }));
        counts.remoteDeleted += 1;
        continue;
      }
      if (!isValidGoalDate(localTargetDate)) continue;
      items.push(buildPlanItem({
        kind: "push_create",
        target,
        goalId: goal.id,
        remoteId: buildCalendarEventId(uid, goal.id),
        title: localTitle,
        fields: [
          { name: "title", before: null, after: localTitle, direction: "study_lamp" },
          { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
        ],
        localValue,
        remoteVersion: remoteVersion(calendarId, null, "new"),
      }));
      counts.push += 1;
      continue;
    }

    const remote = eventToGoalFields(event);

    if (event.status === "cancelled" || remote.cancelled) {
      items.push(buildPlanItem({
        kind: "remote_deleted",
        target,
        goalId: goal.id,
        remoteId: event.id,
        title: localTitle || remote.title,
        fields: [
          { name: "title", before: remote.title || null, after: localTitle, direction: "study_lamp" },
          { name: "targetDate", before: remote.targetDate, after: localTargetDate, direction: "study_lamp" },
        ],
        risk: "destructive",
        localValue,
        remoteVersion: remoteVersion(calendarId, event.etag, "deleted"),
      }));
      counts.remoteDeleted += 1;
      continue;
    }

    if (!isValidGoalDate(localTargetDate) || !isValidGoalDate(remote.targetDate)) {
      items.push(buildPlanItem({
        kind: "attention",
        target,
        goalId: goal.id,
        remoteId: event.id,
        title: localTitle || remote.title,
        fields: [{ name: "targetDate", before: remote.targetDate, after: localTargetDate, direction: "google" }],
        localValue,
        remoteVersion: remoteVersion(calendarId, event.etag, "no_date"),
      }));
      counts.attention += 1;
      continue;
    }

    const decisions = decideGoalFields({
      base: activeMapping?.base ?? null,
      local: { title: localTitle, targetDate: localTargetDate },
      remote: { title: remote.title, targetDate: remote.targetDate },
    });

    const fields: PlanFieldChange[] = [];
    const pairs: Array<[string, FieldDecision, string, string]> = [
      ["title", decisions.title, localTitle, remote.title],
      ["targetDate", decisions.targetDate, localTargetDate, remote.targetDate],
    ];
    for (const [name, decision, local, remoteValue] of pairs) {
      // `before` is the value on the side that would change; `after` is what it would become.
      if (decision === "pull") fields.push({ name, before: local, after: remoteValue, direction: "google" });
      else if (decision === "push" || decision === "conflict") fields.push({ name, before: remoteValue, after: local, direction: "study_lamp" });
    }

    if (fields.length === 0) {
      const base: SyncBase = { title: localTitle, targetDate: localTargetDate, completed: Boolean(goal.completed) };
      const stored = activeMapping?.base;
      if (!stored || stored.title !== base.title || stored.targetDate !== base.targetDate) {
        converged.push({ goalId: goal.id, eventId: event.id, remoteEtag: event.etag ?? null, base });
      }
      continue;
    }

    const hasConflict = decisions.title === "conflict" || decisions.targetDate === "conflict";
    const hasPull = decisions.title === "pull" || decisions.targetDate === "pull";
    const kind: PlanItem["kind"] = hasConflict ? "conflict" : hasPull ? "pull_update" : "push_update";

    items.push(buildPlanItem({
      kind,
      target,
      goalId: goal.id,
      remoteId: event.id,
      title: localTitle || remote.title,
      fields,
      localValue,
      remoteVersion: remoteVersion(calendarId, event.etag, "none"),
    }));

    if (kind === "conflict") counts.conflict += 1;
    else if (kind === "pull_update") counts.pull += 1;
    else counts.push += 1;
  }

  const sliced = items.slice(0, MAX_PLAN_ITEMS);
  const planToken = signPlanToken({ uid, scope, items: sliced.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint })) });

  return {
    items: sliced,
    converged,
    counts,
    remaining: Math.max(0, items.length - MAX_PLAN_ITEMS),
    planToken,
  };
}

// ─── Preview use-case (zero writes) ─────────────────────────────────────────

export interface PlanCalendarSyncInput {
  uid: string;
  calendarId: string;
  goalIds?: string[];
}

/** Reads goals, mappings and LIVE events, then plans. Takes a read-only reader, so it cannot write. */
export async function planCalendarSync(reader: CalendarPlanReader, input: PlanCalendarSyncInput): Promise<GoalSyncPlanResult> {
  const [goals, mappings, live] = await Promise.all([reader.listGoals(), reader.listMappings(), reader.listLiveEvents()]);
  if (live.truncated) throw new CalendarListTruncatedError();
  return buildGoalSyncPlan({
    uid: input.uid,
    calendarId: input.calendarId,
    goals,
    mappings,
    liveEvents: live.events,
    goalIds: input.goalIds,
    scope: "calendar",
  });
}
