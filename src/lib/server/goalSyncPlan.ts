import type { Goal } from "@/types";
import { buildPlanItem, type PlanFieldChange, type PlanItem } from "@/lib/sync/plan";
import { decideField, type FieldDecision } from "@/lib/sync/threeWay";
import { signPlanToken } from "@/lib/server/planToken";
import { isValidIsoDate } from "@/lib/isoDate";
// READ-ONLY imports from the Calendar module: pure helpers and types only.
// This file must never import anything that can write (a test checks the source text).
import {
  buildCalendarEventId,
  eventToGoalFields,
  titleAsGoogleHolds,
  type EventGoalFieldsOk,
  type GoogleCalendarEventLike,
} from "@/lib/server/googleCalendar";
import type { GoalSyncMapping, SyncBase } from "@/lib/server/googleSyncMapping";

/** A Calendar event as returned by Google right now. */
export type LiveCalendarEvent = GoogleCalendarEventLike & { id: string };

/** Everything the planner is allowed to touch: four reads. No write method exists here. */
export interface CalendarPlanReader {
  listGoals(): Promise<Goal[]>;
  /** Mapping docs by goal id. */
  listMappings(): Promise<Map<string, GoalSyncMapping>>;
  /** LIVE events from Google (all pages, deleted ones included). `truncated` = the page cap was hit. */
  listLiveEvents(): Promise<{ events: LiveCalendarEvent[]; truncated: boolean }>;
  /** Google event ids the user chose to ignore ("Don't ask about this event again"). */
  listIgnoredRemoteIds(): Promise<Set<string>>;
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
  /** Plan only these goals. A partial plan never proposes imports and never reports orphans. */
  goalIds?: string[];
  ignoredRemoteIds?: Set<string>;
  scope?: "calendar" | "tasks";
}

/** Goal and Google already agree, but the stored base is missing or old. Bookkeeping only, applied in the apply step. */
export interface ConvergedGoal {
  goalId: string;
  eventId: string;
  remoteEtag: string | null;
  base: SyncBase;
}

/** A mapping whose goal no longer exists. Reported only: nothing is ever deleted for it here. */
export interface OrphanedMapping {
  goalId: string;
  titleSnapshot: string;
  eventId: string;
}

export interface GoalSyncPlanResult {
  items: PlanItem[];
  converged: ConvergedGoal[];
  orphans: OrphanedMapping[];
  counts: {
    push: number;
    pull: number;
    conflict: number;
    attention: number;
    remoteDeleted: number;
    orphaned: number;
  };
  remaining: number;
  planToken: string;
}

const MAX_PLAN_ITEMS = 500;
const MAX_ORPHANS = 50;

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

// ─── Field decisions (shared by the planner and the apply step) ─────────────

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
  const baseTitle = input.base && input.base.title !== null ? titleAsGoogleHolds(input.base.title, input.base.completed) : undefined;
  const baseDate = input.base && input.base.targetDate !== null ? input.base.targetDate : undefined;
  return {
    title: decideField({ base: baseTitle, local: input.local.title, remote: input.remote.title }),
    targetDate: decideField({ base: baseDate, local: input.local.targetDate, remote: input.remote.targetDate }),
  };
}

export type CompletionDecision = "push" | "unchanged";

/**
 * Completion goes Study Lamp -> Google ONLY (decision D4). It is pushed when it differs from Google AND Study Lamp
 * is the side that changed it since the last agreement. A ✓ added or removed in Google is never pulled, so
 * removing the prefix in Google never re-opens a goal.
 */
export function decideCompletion(input: { base: SyncBase | null; local: boolean; remote: boolean }): CompletionDecision {
  if (input.local === input.remote) return "unchanged";
  if (!input.base) return "push";
  return input.local !== input.base.completed ? "push" : "unchanged";
}

export interface GoalDecision extends FieldDecisions {
  completed: CompletionDecision;
  /** The goal's title as Google would hold it (cut at the summary cap, completion prefix included). */
  localTitle: string;
}

export function decideGoal(input: {
  goal: Goal;
  localDate: string;
  remote: Pick<EventGoalFieldsOk, "title" | "targetDate" | "completed">;
  base: SyncBase | null;
}): GoalDecision {
  const completed = Boolean(input.goal.completed);
  const localTitle = titleAsGoogleHolds(input.goal.title ?? "", completed);
  const fields = decideGoalFields({
    base: input.base,
    local: { title: localTitle, targetDate: input.localDate },
    remote: { title: input.remote.title, targetDate: input.remote.targetDate },
  });
  return {
    ...fields,
    completed: decideCompletion({ base: input.base, local: completed, remote: input.remote.completed }),
    localTitle,
  };
}

function localSnapshot(goal: Goal): string {
  return JSON.stringify([goal.title ?? "", goal.targetDate ?? null, Boolean(goal.completed)]);
}

function remoteVersion(calendarId: string, etag: string | null | undefined, fallback: string): string {
  return `${calendarId}:${etag || fallback}`;
}

function fieldChanges(goal: Goal, localDate: string, remote: EventGoalFieldsOk, decision: GoalDecision): PlanFieldChange[] {
  const fields: PlanFieldChange[] = [];
  const localTitle = goal.title ?? "";
  const completed = Boolean(goal.completed);

  const addField = (name: "title" | "targetDate", fieldDecision: FieldDecision, local: string, remoteValue: string) => {
    // `before` is the value on the side that would change; `after` is what it would become.
    if (fieldDecision === "pull") fields.push({ name, before: local, after: remoteValue, direction: "google" });
    else if (fieldDecision === "push") fields.push({ name, before: remoteValue, after: local, direction: "study_lamp" });
    // A conflict has NO direction: the user picks a side per field. Both values travel with it.
    else if (fieldDecision === "conflict") fields.push({ name, before: local, after: remoteValue, local, remote: remoteValue });
  };

  addField("title", decision.title, localTitle, remote.title);
  addField("targetDate", decision.targetDate, localDate, remote.targetDate);
  if (decision.completed === "push") fields.push({ name: "completed", before: remote.completed, after: completed, direction: "study_lamp" });
  return fields;
}

// ─── Planner (pure) ─────────────────────────────────────────────────────────

export function buildGoalSyncPlan({
  uid,
  calendarId,
  goals,
  mappings,
  liveEvents,
  goalIds,
  ignoredRemoteIds = new Set<string>(),
  scope = "calendar",
}: BuildGoalSyncPlanInput): GoalSyncPlanResult {
  const isPartial = typeof goalIds !== "undefined" && goalIds.length > 0;
  const filteredGoals = isPartial ? goals.filter((goal) => goalIds!.includes(goal.id)) : goals;

  const index = indexLiveEvents(uid, liveEvents);
  const goalItems: PlanItem[] = [];
  const eventItems: PlanItem[] = [];
  const converged: ConvergedGoal[] = [];
  const counts = { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0, orphaned: 0 };

  // Every event that belongs to ANY goal is claimed, even on a partial plan, so an event is never offered as an import.
  const claimedEventIds = new Set<string>();
  for (const goal of goals) {
    const event = findGoalEvent({ uid, goalId: goal.id, calendarId, mapping: mappings.get(goal.id), index });
    if (event) claimedEventIds.add(event.id);
  }

  for (const goal of filteredGoals) {
    const mapping = mappings.get(goal.id);
    const activeMapping = activeCalendarMapping(mapping, calendarId);
    const event = findGoalEvent({ uid, goalId: goal.id, calendarId, mapping, index });
    const localTitle = goal.title ?? "";
    const localTargetDate = goal.targetDate ?? null;
    const completed = Boolean(goal.completed);
    const localValue = localSnapshot(goal);
    const target = `goal:${goal.id}`;
    const eventIsGone = !event || event.status === "cancelled";

    // The user chose to stop syncing this goal. Skip it while Google has no live event for it.
    if (activeMapping?.status === "unlinked" && eventIsGone) continue;

    if (!event) {
      if (activeMapping) {
        // We synced this goal before and Google no longer has the event at all.
        goalItems.push(buildPlanItem({
          kind: "remote_deleted",
          target,
          goalId: goal.id,
          remoteId: activeMapping.eventId,
          title: localTitle,
          fields: [
            { name: "title", before: null, after: localTitle, direction: "study_lamp" },
            { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
          ],
          localValue,
          remoteVersion: remoteVersion(calendarId, null, "gone"),
        }));
        counts.remoteDeleted += 1;
        continue;
      }
      if (!isValidGoalDate(localTargetDate)) continue;
      goalItems.push(buildPlanItem({
        kind: "push_create",
        target,
        goalId: goal.id,
        remoteId: buildCalendarEventId(uid, goal.id),
        title: localTitle,
        fields: [
          { name: "title", before: null, after: localTitle, direction: "study_lamp" },
          { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
          ...(completed ? [{ name: "completed", before: null, after: true, direction: "study_lamp" as const }] : []),
        ],
        localValue,
        remoteVersion: remoteVersion(calendarId, null, "new"),
      }));
      counts.push += 1;
      continue;
    }

    const remote = eventToGoalFields(event);

    if (event.status === "cancelled") {
      goalItems.push(buildPlanItem({
        kind: "remote_deleted",
        target,
        goalId: goal.id,
        remoteId: event.id,
        title: localTitle || remote.title,
        fields: [
          { name: "title", before: remote.title || null, after: localTitle, direction: "study_lamp" },
          { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
        ],
        localValue,
        remoteVersion: remoteVersion(calendarId, event.etag, "deleted"),
      }));
      counts.remoteDeleted += 1;
      continue;
    }

    // An event we can't read as goal fields (timed, multi-day, no/invalid date, blank title) is reported, never guessed.
    if (remote.attention) {
      goalItems.push(buildPlanItem({
        kind: "attention",
        target,
        goalId: goal.id,
        remoteId: event.id,
        title: localTitle || remote.title || "(untitled)",
        fields: [],
        reason: remote.attention,
        localValue,
        remoteVersion: remoteVersion(calendarId, event.etag, remote.attention),
      }));
      counts.attention += 1;
      continue;
    }

    if (!isValidGoalDate(localTargetDate)) {
      goalItems.push(buildPlanItem({
        kind: "attention",
        target,
        goalId: goal.id,
        remoteId: event.id,
        title: localTitle || remote.title,
        fields: [],
        reason: "goal_has_no_date",
        localValue,
        remoteVersion: remoteVersion(calendarId, event.etag, "goal_no_date"),
      }));
      counts.attention += 1;
      continue;
    }

    const base = activeMapping?.base ?? null;
    const decision = decideGoal({ goal, localDate: localTargetDate, remote, base });
    const fields = fieldChanges(goal, localTargetDate, remote, decision);

    if (fields.length === 0) {
      // Nothing to propose. If the stored base is behind, remember the agreement (bookkeeping only).
      const stored = activeMapping?.base;
      const storedTitle = stored && stored.title !== null ? titleAsGoogleHolds(stored.title, stored.completed) : null;
      const behind = !stored
        || storedTitle !== decision.localTitle
        || stored.targetDate !== localTargetDate
        || stored.completed !== completed;
      if (behind) {
        converged.push({
          goalId: goal.id,
          eventId: event.id,
          remoteEtag: event.etag ?? null,
          base: { title: localTitle, targetDate: localTargetDate, completed },
        });
      }
      continue;
    }

    const hasConflict = decision.title === "conflict" || decision.targetDate === "conflict";
    const hasPull = decision.title === "pull" || decision.targetDate === "pull";
    const kind: PlanItem["kind"] = hasConflict ? "conflict" : hasPull ? "pull_update" : "push_update";

    goalItems.push(buildPlanItem({
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

  const orphans: OrphanedMapping[] = [];

  // Whole-calendar checks only on a full plan: events nobody claims, and mappings whose goal is gone.
  if (!isPartial) {
    const unclaimed = liveEvents
      .filter((event) => !claimedEventIds.has(event.id) && !ignoredRemoteIds.has(event.id))
      .sort((a, b) => (a.start?.date ?? "").localeCompare(b.start?.date ?? "") || a.id.localeCompare(b.id));

    for (const event of unclaimed) {
      // Cancelled events are history. Events Study Lamp wrote for a goal that no longer exists are left alone.
      if (event.status === "cancelled") continue;
      if (event.extendedProperties?.private?.studylampGoalId) continue;

      const parsed = eventToGoalFields(event);
      const target = `calendar-event:${event.id}`;
      const version = remoteVersion(calendarId, event.etag, "event");

      if (parsed.attention) {
        eventItems.push(buildPlanItem({
          kind: "attention",
          target,
          goalId: null,
          remoteId: event.id,
          title: parsed.title || event.summary?.trim() || "(untitled event)",
          fields: [],
          reason: parsed.attention,
          remoteVersion: version,
        }));
        counts.attention += 1;
        continue;
      }

      eventItems.push(buildPlanItem({
        kind: "pull_create",
        target,
        goalId: null,
        remoteId: event.id,
        title: parsed.title,
        fields: [
          { name: "title", before: null, after: parsed.title, direction: "google" },
          { name: "targetDate", before: null, after: parsed.targetDate, direction: "google" },
        ],
        remoteVersion: version,
      }));
      counts.pull += 1;
    }

    const goalIdSet = new Set(goals.map((goal) => goal.id));
    for (const [goalId, mapping] of mappings) {
      const active = activeCalendarMapping(mapping, calendarId);
      if (!active || goalIdSet.has(goalId)) continue;
      counts.orphaned += 1;
      if (orphans.length < MAX_ORPHANS) orphans.push({ goalId, titleSnapshot: mapping.titleSnapshot, eventId: active.eventId });
    }
  }

  const all = [...goalItems, ...eventItems];
  const sliced = all.slice(0, MAX_PLAN_ITEMS);
  const planToken = signPlanToken({ uid, scope, items: sliced.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint })) });

  return {
    items: sliced,
    converged,
    orphans,
    counts,
    remaining: Math.max(0, all.length - MAX_PLAN_ITEMS),
    planToken,
  };
}

// ─── Preview use-case (zero writes) ─────────────────────────────────────────

export interface PlanCalendarSyncInput {
  uid: string;
  calendarId: string;
  goalIds?: string[];
}

/** Reads goals, mappings, the ignore list and LIVE events, then plans. Takes a read-only reader, so it cannot write. */
export async function planCalendarSync(reader: CalendarPlanReader, input: PlanCalendarSyncInput): Promise<GoalSyncPlanResult> {
  const [goals, mappings, live, ignored] = await Promise.all([
    reader.listGoals(),
    reader.listMappings(),
    reader.listLiveEvents(),
    reader.listIgnoredRemoteIds(),
  ]);
  if (live.truncated) throw new CalendarListTruncatedError();
  return buildGoalSyncPlan({
    uid: input.uid,
    calendarId: input.calendarId,
    goals,
    mappings,
    liveEvents: live.events,
    goalIds: input.goalIds,
    ignoredRemoteIds: ignored,
    scope: "calendar",
  });
}
