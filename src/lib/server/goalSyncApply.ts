import type { PlanItem, SyncResolution } from "@/lib/sync/plan";
import { isValidIsoDate } from "@/lib/isoDate";
import { applyConfirmed, type ApplyDecision, type WriterOutcome } from "@/lib/server/applyGate";
import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";
import { markTokenUsed } from "@/lib/server/googleUsedTokens";
import {
  buildCalendarEvent,
  buildCalendarEventId,
  eventToGoalFields,
  GoogleCalendarApiError,
  GOAL_TITLE_MAX,
  type CalendarWriteClient,
  type GoogleCalendarEventLike,
} from "@/lib/server/googleCalendar";
import {
  activeCalendarMapping,
  buildGoalSyncPlan,
  CalendarListTruncatedError,
  decideGoal,
  findGoalEvent,
  indexLiveEvents,
  type CalendarPlanReader,
  type LiveCalendarEvent,
} from "@/lib/server/goalSyncPlan";
import type { CalendarMappingStatus, GoalSyncMapping, SyncBase } from "@/lib/server/googleSyncMapping";
import type { GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import type { Goal } from "@/types";

export type { SyncResolution } from "@/lib/sync/plan";

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

  // One-time token (Z3 item 6): claim the jti BEFORE any writer can run.
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

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Values pulled from Google are validated here because the Admin SDK bypasses the Firestore rules.
 * Returns an error code, or null when the update is acceptable.
 */
export function validateGoalFieldPull(updates: { title?: string; targetDate?: string }): "invalid_remote_value" | null {
  if (updates.title !== undefined && (updates.title.trim() === "" || updates.title.length > GOAL_TITLE_MAX)) return "invalid_remote_value";
  if (updates.targetDate !== undefined && !isValidIsoDate(updates.targetDate)) return "invalid_remote_value";
  return null;
}

export type FieldChoice = "use_study_lamp" | "use_google" | undefined;

export interface GoalUpdateOutcome {
  goalUpdates: { title?: string; targetDate?: string };
  /** What the Google event must say afterwards; null when Google needs no write. */
  googleFinal: { title: string; targetDate: string } | null;
  newBase: SyncBase;
  /** Conflicting fields the user left on "skip": untouched on both sides. */
  unresolved: Array<"title" | "targetDate">;
}

/**
 * Turns the three-way decisions plus the user's per-field choices into concrete writes. Pure, so the planner's
 * view and the writer's view cannot drift: both call decideGoal.
 */
export function resolveGoalUpdate(input: {
  goal: Goal;
  localDate: string;
  remote: { title: string; targetDate: string; completed: boolean };
  base: SyncBase | null;
  choose: (field: "title" | "targetDate") => FieldChoice;
}): GoalUpdateOutcome {
  const { goal, localDate, remote, base } = input;
  const completed = Boolean(goal.completed);
  const localTitleRaw = goal.title ?? "";
  const decision = decideGoal({ goal, localDate, remote, base });

  type Picked = { value: string; source: "local" | "google" | "agree" } | null;
  const pick = (field: "title" | "targetDate", localRaw: string, remoteValue: string, localCmp: string): Picked => {
    const d = decision[field];
    if (d === "pull") return { value: remoteValue, source: "google" };
    if (d === "push") return { value: localRaw, source: "local" };
    if (d === "conflict") {
      const choice = input.choose(field);
      if (choice === "use_google") return { value: remoteValue, source: "google" };
      if (choice === "use_study_lamp") return { value: localRaw, source: "local" };
      return null;
    }
    return localCmp === remoteValue ? { value: localRaw, source: "agree" } : null;
  };

  const title = pick("title", localTitleRaw, remote.title, decision.localTitle);
  const date = pick("targetDate", localDate, remote.targetDate, localDate);

  const goalUpdates: { title?: string; targetDate?: string } = {};
  if (title?.source === "google" && title.value !== localTitleRaw) goalUpdates.title = title.value;
  if (date?.source === "google" && date.value !== localDate) goalUpdates.targetDate = date.value;

  const completedPush = decision.completed === "push";
  const needsGoogle = title?.source === "local" || date?.source === "local" || completedPush;
  const googleFinal = needsGoogle
    ? { title: title ? title.value : remote.title, targetDate: date ? date.value : remote.targetDate }
    : null;

  const unresolved: Array<"title" | "targetDate"> = [];
  if (!title) unresolved.push("title");
  if (!date) unresolved.push("targetDate");

  const newBase: SyncBase = {
    title: title ? title.value : base?.title ?? null,
    targetDate: date ? date.value : base?.targetDate ?? null,
    completed: completedPush || remote.completed === completed ? completed : base?.completed ?? completed,
  };

  return { goalUpdates, googleFinal, newBase, unresolved };
}

// ─── Calendar apply ─────────────────────────────────────────────────────────

export type GoalPullResult = "ok" | "changed" | "missing";

export interface MappingSave {
  titleSnapshot: string;
  eventId: string;
  remoteEtag: string | null;
  base: SyncBase | null;
  status?: CalendarMappingStatus;
}

/** Writes the Calendar apply step is allowed to make. Each is injected so tests can record them. */
export interface CalendarApplyDeps extends CalendarPlanReader {
  uid: string;
  connectionId: string;
  calendarId: string;
  client: Pick<CalendarWriteClient, "insertEvent" | "patchEvent" | "getEvent">;
  /** Writes ONLY our own mapping doc. */
  saveMapping(goalId: string, input: MappingSave): Promise<void>;
  recordError(goalId: string, code: string): Promise<void>;
  /** Claims the plan token's one-time id. Injectable so tests use a fake store (Z3 item 6). */
  claimToken?: (uid: string, jti: string, exp: number) => Promise<boolean>;
  /** Updates the goal AND its mapping in one transaction, only if title/targetDate still equal `expected`. */
  pullGoalFields(
    goalId: string,
    expected: { title: string; targetDate: string | null },
    updates: { title?: string; targetDate?: string },
    mapping: MappingSave,
  ): Promise<GoalPullResult>;
  /** Creates a goal and its mapping together (batch). */
  createGoalFromEvent(input: { title: string; targetDate: string; eventId: string; remoteEtag: string | null }): Promise<{ goalId: string }>;
  /** Deletes the goal and its mapping, only if unchanged. Only ever called for an explicit, separately confirmed "delete_goal". */
  deleteGoal(goalId: string, expected: { title: string; targetDate: string | null }): Promise<GoalPullResult>;
  /** Records "don't ask again" for a Google event id (our own data). */
  ignoreRemote(remoteId: string): Promise<void>;
  /** Appends a history entry. Failures never change an outcome. */
  log?(entry: GoogleSyncLogEntry): Promise<void>;
}

export interface ApplyCalendarSyncInput {
  planToken: string;
  accepted: string[];
  /** Keyed by itemId, or `${itemId}:${field}` for one field of a conflict. */
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
  const [goals, mappings, live, ignored] = await Promise.all([
    deps.listGoals(),
    deps.listMappings(),
    deps.listLiveEvents(),
    deps.listIgnoredRemoteIds(),
  ]);
  if (live.truncated) throw new CalendarListTruncatedError();

  const plan = buildGoalSyncPlan({ uid: deps.uid, calendarId: deps.calendarId, goals, mappings, liveEvents: live.events, ignoredRemoteIds: ignored });
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const index = indexLiveEvents(deps.uid, live.events);
  const resolutions = input.resolutions ?? {};

  const writers: Record<string, (item: PlanItem) => Promise<WriterOutcome>> = {};
  for (const item of plan.items) {
    writers[item.itemId] = async (planned) => {
      const goalId = planned.goalId ?? null;
      const goal = goalId ? goalById.get(goalId) : undefined;
      try {
        return await writeItem(deps, { item: planned, goal, mapping: goalId ? mappings.get(goalId) : undefined, index, resolutions });
      } catch (error) {
        // Best effort: note the failure on an existing mapping, then let the gate report "failed".
        if (goalId) await deps.recordError(goalId, error instanceof GoogleCalendarApiError ? error.kind : "apply_error").catch(() => undefined);
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

  await recordHistory(deps, plan.items, goalById, results);

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

// ─── History ────────────────────────────────────────────────────────────────

function directionOf(item: PlanItem): string {
  const sides = new Set(item.fields.map((field) => field.direction).filter(Boolean));
  if (sides.has("study_lamp") && sides.has("google")) return "both";
  if (sides.has("study_lamp")) return "study_lamp_to_google";
  if (sides.has("google")) return "google_to_study_lamp";
  if (item.kind === "conflict") return "both";
  if (item.kind === "pull_create") return "google_to_study_lamp";
  return "study_lamp";
}

/** Goal-level fields only: never tokens, never document text (Rule 4). */
export function buildHistoryEntry(item: PlanItem, goal: Goal | undefined, result: ApplyDecision["status"], now = new Date()): GoogleSyncLogEntry {
  return {
    at: now.toISOString(),
    scope: "calendar",
    direction: directionOf(item),
    itemKind: item.kind,
    ...(item.goalId ? { goalId: item.goalId } : {}),
    titleSnapshot: item.title.slice(0, 200),
    targetDateSnapshot: goal?.targetDate ?? null,
    completedSnapshot: goal ? Boolean(goal.completed) : null,
    fields: item.fields.slice(0, 20).map((field) => ({ name: field.name, before: field.before, after: field.after })),
    result,
  };
}

async function recordHistory(deps: CalendarApplyDeps, items: PlanItem[], goalById: Map<string, Goal>, results: ApplyDecision[]) {
  if (!deps.log) return;
  const byId = new Map(items.map((item) => [item.itemId, item]));
  for (const decision of results) {
    if (decision.code === "not_accepted") continue;
    const item = byId.get(decision.itemId);
    if (!item) continue;
    try {
      await deps.log(buildHistoryEntry(item, item.goalId ? goalById.get(item.goalId) : undefined, decision.status));
    } catch {
      // History is bookkeeping about something that already happened; it must not change the outcome.
    }
  }
}

// ─── Writers ────────────────────────────────────────────────────────────────

interface WriteContext {
  item: PlanItem;
  goal: Goal | undefined;
  mapping: GoalSyncMapping | undefined;
  index: ReturnType<typeof indexLiveEvents>;
  resolutions: Record<string, SyncResolution>;
}

async function writeItem(deps: CalendarApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  switch (ctx.item.kind) {
    case "pull_create":
      return writePullCreate(deps, ctx);
    case "attention":
      return writeAttention(deps, ctx);
    case "push_create":
      return ctx.goal ? writeCreate(deps, ctx as WriteContext & { goal: Goal }, false) : { skipped: "goal_missing" };
    case "push_update":
    case "pull_update":
    case "conflict":
      return ctx.goal ? writeUpdate(deps, ctx as WriteContext & { goal: Goal }) : { skipped: "goal_missing" };
    case "remote_deleted":
      return ctx.goal ? writeRemoteDeleted(deps, ctx as WriteContext & { goal: Goal }) : { skipped: "goal_missing" };
    default:
      return { skipped: "unsupported_kind" };
  }
}

function goalForEvent(deps: CalendarApplyDeps, goal: Goal, title: string, targetDate: string) {
  return { id: goal.id, uid: deps.uid, title, targetDate, completed: Boolean(goal.completed) };
}

function fieldChoice(ctx: WriteContext, field: "title" | "targetDate"): FieldChoice {
  const choice = ctx.resolutions[`${ctx.item.itemId}:${field}`] ?? ctx.resolutions[ctx.item.itemId];
  return choice === "use_google" || choice === "use_study_lamp" ? choice : undefined;
}

function mappingSave(goal: Goal, eventId: string, remoteEtag: string | null, base: SyncBase | null, status?: CalendarMappingStatus): MappingSave {
  return { titleSnapshot: base?.title ?? goal.title ?? "", eventId, remoteEtag, base, status };
}

/** push_create (and "recreate" for a deleted event). Inserts with the deterministic id; a 409 is adopted, not duplicated. */
async function writeCreate(deps: CalendarApplyDeps, ctx: WriteContext & { goal: Goal }, restoreCancelled: boolean): Promise<WriterOutcome> {
  const { goal } = ctx;
  const title = goal.title ?? "";
  const targetDate = goal.targetDate ?? "";
  if (!isValidIsoDate(targetDate)) return { skipped: "goal_has_no_date" };

  const eventId = buildCalendarEventId(deps.uid, goal.id);
  const payload = buildCalendarEvent(goalForEvent(deps, goal, title, targetDate));
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

  await deps.saveMapping(goal.id, mappingSave(goal, eventId, newerEtag(saved, null), { title, targetDate, completed: Boolean(goal.completed) }));
}

/**
 * push_update / pull_update / conflict. Per field: pulled fields go to the goal, pushed fields go to Google, a
 * conflicting field follows the user's choice, and a field left on "skip" is untouched on both sides.
 * Order: Google first (guarded by If-Match), then the goal+mapping transaction (guarded by what apply just read).
 */
async function writeUpdate(deps: CalendarApplyDeps, ctx: WriteContext & { goal: Goal }): Promise<WriterOutcome> {
  const { goal, mapping, index } = ctx;
  const localDate = goal.targetDate ?? "";
  if (!isValidIsoDate(localDate)) return { skipped: "goal_has_no_date" };

  const event: LiveCalendarEvent | null = findGoalEvent({ uid: deps.uid, goalId: goal.id, calendarId: deps.calendarId, mapping, index });
  if (!event || event.status === "cancelled") return { skipped: "remote_missing" };
  const remote = eventToGoalFields(event);
  if (remote.attention) return { skipped: "remote_unsupported" };

  const base = activeCalendarMapping(mapping, deps.calendarId)?.base ?? null;
  const outcome = resolveGoalUpdate({ goal, localDate, remote, base, choose: (field) => fieldChoice(ctx, field) });
  const hasGoalUpdates = Object.keys(outcome.goalUpdates).length > 0;

  if (!hasGoalUpdates && !outcome.googleFinal) {
    // Nothing selected could be applied: every conflicting field was left on "skip".
    if (outcome.unresolved.length > 0) return { skipped: "missing_resolution" };
  }

  const invalid = validateGoalFieldPull(outcome.goalUpdates);
  if (invalid) return { skipped: invalid };

  let etag: string | null = event.etag ?? null;
  if (outcome.googleFinal) {
    try {
      // If-Match = the etag the user saw (it equals the live one, or the fingerprint check would have failed).
      const patched = await deps.client.patchEvent(
        deps.calendarId,
        event.id,
        buildCalendarEvent(goalForEvent(deps, goal, outcome.googleFinal.title, outcome.googleFinal.targetDate)),
        { ifMatch: event.etag ?? null },
      );
      etag = newerEtag(patched, etag);
    } catch (error) {
      if (error instanceof GoogleCalendarApiError && error.kind === "changed_remotely") return { skipped: "changed_remotely" };
      if (error instanceof GoogleCalendarApiError && error.kind === "remote_missing") return { skipped: "remote_missing" };
      throw error;
    }
  }

  const save = mappingSave(goal, event.id, etag, outcome.newBase);
  if (hasGoalUpdates) {
    const result = await deps.pullGoalFields(goal.id, goalSnapshot(goal), outcome.goalUpdates, save);
    if (result === "missing") return { skipped: "goal_missing" };
    if (result === "changed") return { skipped: "goal_changed" };
    return;
  }
  await deps.saveMapping(goal.id, save);
}

/** remote_deleted: unlink (default, our mapping only), recreate, or delete_goal (needs its own confirmation, enforced by the gate). */
async function writeRemoteDeleted(deps: CalendarApplyDeps, ctx: WriteContext & { goal: Goal }): Promise<WriterOutcome> {
  const { goal, item } = ctx;
  const choice = ctx.resolutions[item.itemId];

  if (choice === "unlink") {
    const eventId = item.remoteId ?? buildCalendarEventId(deps.uid, goal.id);
    await deps.saveMapping(goal.id, { titleSnapshot: goal.title ?? "", eventId, remoteEtag: null, base: null, status: "unlinked" });
    return;
  }
  if (choice === "recreate") return writeCreate(deps, ctx, true);
  if (choice === "delete_goal") {
    const result = await deps.deleteGoal(goal.id, goalSnapshot(goal));
    if (result === "missing") return { skipped: "goal_missing" };
    if (result === "changed") return { skipped: "goal_changed" };
    return;
  }
  return { skipped: "no_resolution" };
}

/** pull_create: import an unmarked event as a new goal (the Google event itself is not changed), or ignore it. */
async function writePullCreate(deps: CalendarApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  const { item } = ctx;
  const remoteId = item.remoteId;
  if (!remoteId) return { skipped: "remote_missing" };

  if (ctx.resolutions[item.itemId] === "ignore") {
    await deps.ignoreRemote(remoteId);
    return;
  }

  const event = ctx.index.byId.get(remoteId);
  if (!event) return { skipped: "remote_missing" };
  const parsed = eventToGoalFields(event);
  if (parsed.attention) return { skipped: "remote_unsupported" };
  if (validateGoalFieldPull({ title: parsed.title, targetDate: parsed.targetDate })) return { skipped: "invalid_remote_value" };

  // Completion is Study Lamp -> Google only, so an imported goal always starts open.
  await deps.createGoalFromEvent({ title: parsed.title, targetDate: parsed.targetDate, eventId: event.id, remoteEtag: event.etag ?? null });
}

/** attention: never applied. The only action is "ignore" for an event that belongs to no goal. */
async function writeAttention(deps: CalendarApplyDeps, ctx: WriteContext): Promise<WriterOutcome> {
  const { item } = ctx;
  if (ctx.resolutions[item.itemId] === "ignore" && item.remoteId && !item.goalId) {
    await deps.ignoreRemote(item.remoteId);
    return;
  }
  return { skipped: "needs_attention" };
}
