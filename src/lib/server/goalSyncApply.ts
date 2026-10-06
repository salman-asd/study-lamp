import type { PlanItem } from "@/lib/sync/plan";
import { isValidIsoDate } from "@/lib/isoDate";
import { applyConfirmed, type ApplyDecision, type WriterOutcome } from "@/lib/server/applyGate";
import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";
import { markTokenUsed } from "@/lib/server/googleUsedTokens";
import {
  buildCalendarEvent,
  buildCalendarEventId,
  GoogleCalendarApiError,
  type CalendarWriteClient,
  type GoogleCalendarEventLike,
} from "@/lib/server/googleCalendar";
import {
  buildGoalSyncPlan,
  decideGoalFields,
  findGoalEvent,
  indexLiveEvents,
  activeCalendarMapping,
  CalendarListTruncatedError,
  type CalendarPlanReader,
  type LiveCalendarEvent,
} from "@/lib/server/goalSyncPlan";
import type { GoalSyncMapping, SyncBase } from "@/lib/server/googleSyncMapping";
import { eventToGoalFields } from "@/lib/server/googleCalendar";
import type { Goal } from "@/types";

export type SyncResolution = "use_study_lamp" | "use_google" | "skip";

export interface GoalSyncApplyInput {
  token: string;
  accepted: Iterable<string>;
  resolutions?: Record<string, SyncResolution>;
  confirmedDestructive?: Iterable<string>;
  freshPlan: PlanItem[];
  expectedUser?: string;
  expectedScope?: PlanScope;
  writers?: Record<string, (item: PlanItem) => Promise<WriterOutcome> | WriterOutcome>;
  /** Claims the token's one-time id. Injectable so tests can use a fake store (Z3 item 6). */
  claimToken?: (uid: string, jti: string, exp: number) => Promise<boolean>;
}

/** Verifies the token and runs the confirmation gate. The gate is the only path to a writer. */
export async function applyGoalSyncPlan({
  token,
  accepted,
  resolutions,
  confirmedDestructive,
  freshPlan,
  expectedUser,
  expectedScope,
  writers = {},
  claimToken = markTokenUsed,
}: GoalSyncApplyInput) {
  const verification = verifyPlanToken(token, expectedUser, expectedScope);

  // One-time token (Z3 item 6): claim the jti BEFORE any writer can run. A replay
  // returns 409 from the route because this throws.
  const claimed = await claimToken(verification.uid, verification.jti, verification.exp);
  if (!claimed) throw new PlanAlreadyAppliedError();

  return applyConfirmed({
    token: verification,
    accepted: new Set(accepted),
    resolutions,
    confirmedDestructive: new Set(confirmedDestructive ?? []),
    freshPlan,
    writers,
    expectedUser,
    expectedScope,
  });
}

export function isValidPlanTokenItem(value: unknown): value is PlanTokenItem {
  if (!value || typeof value !== "object") return false;
  const item = value as { itemId?: unknown; fingerprint?: unknown };
  return typeof item.itemId === "string" && typeof item.fingerprint === "string";
}

/** Thrown when a plan token has already been spent (Z3 item 6). Routes map this to 409. */
export class PlanAlreadyAppliedError extends Error {
  constructor() {
    super("This plan was already applied.");
    this.name = "PlanAlreadyAppliedError";
  }
}

// ─── Calendar apply ─────────────────────────────────────────────────────────

export type GoalPullResult = "ok" | "changed" | "missing";

/** Writes the Calendar apply step is allowed to make. Each is injected so tests can record them. */
export interface CalendarApplyDeps extends CalendarPlanReader {
  uid: string;
  connectionId: string;
  calendarId: string;
  client: Pick<CalendarWriteClient, "insertEvent" | "patchEvent" | "getEvent">;
  /** Writes ONLY our own mapping doc. */
  saveMapping(goalId: string, input: { titleSnapshot: string; eventId: string; remoteEtag: string | null; base: SyncBase }): Promise<void>;
  recordError(goalId: string, code: string): Promise<void>;
  /** Claims the plan token's one-time id. Injectable so tests use a fake store (Z3 item 6). */
  claimToken?: (uid: string, jti: string, exp: number) => Promise<boolean>;
  /**
   * Updates the goal in one transaction, only if title and targetDate still equal `expected`
   * (what apply just read). Returns "changed" without writing otherwise.
   */
  pullGoalFields(
    goalId: string,
    expected: { title: string; targetDate: string | null },
    updates: { title?: string; targetDate?: string },
  ): Promise<GoalPullResult>;
}

export interface ApplyCalendarSyncInput {
  planToken: string;
  accepted: string[];
  resolutions?: Record<string, SyncResolution>;
  confirmedDestructive?: string[];
  /** Cap for the converged bookkeeping writes. */
  maxBookkeeping?: number;
}

export interface ApplyCalendarSyncResult {
  results: ApplyDecision[];
  bookkeeping: number;
}

function goalSnapshot(goal: Goal): { title: string; targetDate: string | null } {
  return { title: goal.title ?? "", targetDate: goal.targetDate ?? null };
}

function newerEtag(event: GoogleCalendarEventLike | undefined, fallback: string | null): string | null {
  return event?.etag ?? fallback;
}

/**
 * Re-reads CURRENT goals, mappings and LIVE Google events, recomputes the plan, and lets the gate decide
 * which items may be written (token, per-item fingerprint, accepted, destructive confirmation).
 * All content written to Google is built here from stored goal data, never from the request.
 */
export async function applyCalendarSync(deps: CalendarApplyDeps, input: ApplyCalendarSyncInput): Promise<ApplyCalendarSyncResult> {
  const [goals, mappings, live] = await Promise.all([deps.listGoals(), deps.listMappings(), deps.listLiveEvents()]);
  if (live.truncated) throw new CalendarListTruncatedError();

  const plan = buildGoalSyncPlan({ uid: deps.uid, calendarId: deps.calendarId, goals, mappings, liveEvents: live.events });
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const index = indexLiveEvents(deps.uid, live.events);
  const resolutions = input.resolutions ?? {};

  const writers: Record<string, (item: PlanItem) => Promise<WriterOutcome>> = {};
  for (const item of plan.items) {
    writers[item.itemId] = async (planned) => {
      const goalId = planned.goalId ?? null;
      const goal = goalId ? goalById.get(goalId) : undefined;
      if (!goalId || !goal) return { skipped: "goal_missing" };

      try {
        return await writeItem(deps, { item: planned, goal, mapping: mappings.get(goalId), index, resolution: resolutions[planned.itemId] });
      } catch (error) {
        // Best effort: note the failure on an existing mapping, then let the gate report "failed".
        await deps.recordError(goalId, error instanceof GoogleCalendarApiError ? error.kind : "apply_error").catch(() => undefined);
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
    expectedScope: "calendar",
    writers,
    claimToken: deps.claimToken,
  });

  // The single non-confirmed write: for goals where Study Lamp and Google already agree, remember that
  // agreement as the new base. It touches only our own mapping doc, never Google and never a goal.
  let bookkeeping = 0;
  for (const entry of plan.converged.slice(0, input.maxBookkeeping ?? 100)) {
    const goal = goalById.get(entry.goalId);
    if (!goal) continue;
    try {
      await deps.saveMapping(entry.goalId, { titleSnapshot: goal.title ?? "", eventId: entry.eventId, remoteEtag: entry.remoteEtag, base: entry.base });
      bookkeeping += 1;
    } catch {
      // Bookkeeping is optional; the next apply retries it.
    }
  }

  return { results, bookkeeping };
}

interface WriteContext {
  item: PlanItem;
  goal: Goal;
  mapping: GoalSyncMapping | undefined;
  index: ReturnType<typeof indexLiveEvents>;
  resolution: SyncResolution | undefined;
}

async function writeItem(deps: CalendarApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  switch (ctx.item.kind) {
    case "push_create":
      return writeCreate(deps, ctx, false);
    case "push_update":
    case "pull_update":
    case "conflict":
      return writeUpdate(deps, ctx);
    case "remote_deleted":
      // Only "recreate" exists until step Z4 adds unlink / delete-goal.
      return ctx.resolution === "use_study_lamp" ? writeCreate(deps, ctx, true) : { skipped: "unsupported_resolution" };
    default:
      return { skipped: "unsupported_kind" };
  }
}

function goalForEvent(deps: CalendarApplyDeps, goal: Goal, title: string, targetDate: string) {
  return { id: goal.id, uid: deps.uid, title, targetDate, completed: Boolean(goal.completed) };
}

function baseOf(goal: Goal, title: string, targetDate: string): SyncBase {
  return { title, targetDate, completed: Boolean(goal.completed) };
}

/** push_create (and "recreate" for a deleted event). Inserts with the deterministic id; a 409 is adopted, not duplicated. */
async function writeCreate(deps: CalendarApplyDeps, ctx: WriteContext, restoreCancelled: boolean): Promise<WriterOutcome> {
  const { goal } = ctx;
  const title = goal.title ?? "";
  const targetDate = goal.targetDate ?? "";
  if (!isValidIsoDate(targetDate)) return { skipped: "goal_has_no_date" };

  const eventGoal = goalForEvent(deps, goal, title, targetDate);
  const eventId = buildCalendarEventId(deps.uid, goal.id);
  const payload = buildCalendarEvent(eventGoal);
  let saved: GoogleCalendarEventLike;

  try {
    saved = await deps.client.insertEvent(deps.calendarId, { id: eventId, ...payload });
  } catch (error) {
    if (!(error instanceof GoogleCalendarApiError) || error.kind !== "exists") throw error;

    // The id is taken: either an earlier insert actually succeeded, or the event was deleted (cancelled).
    const existing = await deps.client.getEvent(deps.calendarId, eventId);
    if (existing.status === "cancelled" && !restoreCancelled) return { skipped: "remote_cancelled" };
    try {
      // For a cancelled event this restores it by setting status "confirmed" (verify against live Google).
      saved = await deps.client.patchEvent(deps.calendarId, eventId, payload, { ifMatch: existing.etag ?? null });
    } catch (patchError) {
      if (patchError instanceof GoogleCalendarApiError && patchError.kind === "changed_remotely") return { skipped: "changed_remotely" };
      throw patchError;
    }
  }

  await deps.saveMapping(goal.id, { titleSnapshot: title, eventId, remoteEtag: newerEtag(saved, null), base: baseOf(goal, title, targetDate) });
}

/** push_update / pull_update / conflict: both sides end up equal, field by field, from the CURRENT live state. */
async function writeUpdate(deps: CalendarApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  const { goal, mapping, index, resolution } = ctx;
  const localTitle = goal.title ?? "";
  const localDate = goal.targetDate ?? "";
  if (!isValidIsoDate(localDate)) return { skipped: "goal_has_no_date" };

  const event: LiveCalendarEvent | null = findGoalEvent({ uid: deps.uid, goalId: goal.id, calendarId: deps.calendarId, mapping, index });
  if (!event || event.status === "cancelled") return { skipped: "remote_missing" };
  const remote = eventToGoalFields(event);
  if (!remote.targetDate) return { skipped: "remote_has_no_date" };

  const base = activeCalendarMapping(mapping, deps.calendarId)?.base ?? null;
  const decisions = decideGoalFields({ base, local: { title: localTitle, targetDate: localDate }, remote: { title: remote.title, targetDate: remote.targetDate } });

  const pick = (decision: string, local: string, remoteValue: string): string | null => {
    if (decision === "pull") return remoteValue;
    if (decision === "push") return local;
    if (decision === "conflict") return resolution === "use_google" ? remoteValue : resolution === "use_study_lamp" ? local : null;
    return local === remoteValue ? local : null;
  };
  const finalTitle = pick(decisions.title, localTitle, remote.title);
  const finalDate = pick(decisions.targetDate, localDate, remote.targetDate);
  if (finalTitle === null || finalDate === null) return { skipped: "missing_resolution" };

  const goalUpdates: { title?: string; targetDate?: string } = {};
  if (finalTitle !== localTitle) goalUpdates.title = finalTitle;
  if (finalDate !== localDate) goalUpdates.targetDate = finalDate;
  const needsGoal = Object.keys(goalUpdates).length > 0;
  const needsGoogle = finalTitle !== remote.title || finalDate !== remote.targetDate;

  // Values pulled from Google are validated here because the Admin SDK bypasses the Firestore rules.
  if (goalUpdates.title !== undefined && (goalUpdates.title.trim() === "" || goalUpdates.title.length > 500)) return { skipped: "invalid_remote_value" };
  if (goalUpdates.targetDate !== undefined && !isValidIsoDate(goalUpdates.targetDate)) return { skipped: "invalid_remote_value" };

  if (needsGoal) {
    const outcome = await deps.pullGoalFields(goal.id, goalSnapshot(goal), goalUpdates);
    if (outcome === "missing") return { skipped: "goal_missing" };
    if (outcome === "changed") return { skipped: "goal_changed" };
  }

  let etag: string | null = event.etag ?? null;
  if (needsGoogle) {
    try {
      // If-Match = the etag the user saw (it equals the live one, or the fingerprint check would have failed).
      const patched = await deps.client.patchEvent(
        deps.calendarId,
        event.id,
        buildCalendarEvent(goalForEvent(deps, goal, finalTitle, finalDate)),
        { ifMatch: event.etag ?? null },
      );
      etag = newerEtag(patched, etag);
    } catch (error) {
      if (error instanceof GoogleCalendarApiError && error.kind === "changed_remotely") return { skipped: "changed_remotely" };
      if (error instanceof GoogleCalendarApiError && error.kind === "remote_missing") return { skipped: "remote_missing" };
      throw error;
    }
  }

  await deps.saveMapping(goal.id, { titleSnapshot: finalTitle, eventId: event.id, remoteEtag: etag, base: baseOf(goal, finalTitle, finalDate) });
}
