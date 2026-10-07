import { applyConfirmed, type ApplyDecision } from "@/lib/server/applyGate";
import { buildHistoryEntry, PlanAlreadyAppliedError } from "@/lib/server/goalSyncApply";
import { GoogleCalendarApiError, type CalendarWriteClient } from "@/lib/server/googleCalendar";
import { GoogleTasksApiError, type TasksWriteClient } from "@/lib/server/googleTasks";
import type { GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import type { GoalSyncMapping, MappingBlock } from "@/lib/server/googleSyncMapping";
import { signPlanToken, verifyPlanToken } from "@/lib/server/planToken";
import { buildPlanItem, type PlanItem } from "@/lib/sync/plan";

/**
 * Explicit removal of what Study Lamp created in Google (W5). Pure logic with injected dependencies: no Firestore,
 * no Google import beyond error classes, so every branch is testable with fakes.
 *
 * Safety rules (Global Rules 13, 14, 15, 16):
 *  - Candidates come ONLY from this user's mapping docs, for ONE connection and ONE stored calendar / task list.
 *    Nothing else in Google is ever listed or deleted.
 *  - The preview reads our own docs only. It performs zero writes and makes no Google call.
 *  - Apply = verify token -> count check -> one-time claim -> recompute -> gate -> delete. Removal is never automatic.
 */

export type RemovalTarget = "calendar" | "tasks";
export type RemovalScope = "orphans" | "all";

/** Items per plan. Larger sets are done in rounds ("remaining" tells the caller). Keeps the signed token small. */
export const REMOVAL_MAX_ITEMS = 200;
/** Remote deletes are paced in chunks of this size (a pause between chunks, on top of the client's own backoff). */
export const REMOVAL_CHUNK_SIZE = 25;
const CHUNK_PAUSE_MS = 1_000;

export interface RemovalCandidate {
  goalId: string;
  remoteId: string;
  titleSnapshot: string;
  /** The goal no longer exists. */
  orphan: boolean;
  /** Stored sync status, part of the fingerprint. */
  status: string;
  remoteEtag: string | null;
}

export interface RemovalSelection {
  target: RemovalTarget;
  scope: RemovalScope;
  connectionId: string;
  /** The stored Study Lamp calendar id / task list id of that connection. Mappings for any other container are ignored. */
  containerId: string;
}

export function isRemovalTarget(value: unknown): value is RemovalTarget {
  return value === "calendar" || value === "tasks";
}

export function isRemovalScope(value: unknown): value is RemovalScope {
  return value === "orphans" || value === "all";
}

/** Which mapping docs hold a removable remote item for this selection. Pure. */
export function collectRemovalCandidates(input: {
  mappings: Map<string, GoalSyncMapping>;
  goalIds: ReadonlySet<string>;
  selection: RemovalSelection;
}): RemovalCandidate[] {
  const { mappings, goalIds, selection } = input;
  const result: RemovalCandidate[] = [];

  for (const [goalId, mapping] of mappings) {
    const orphan = !goalIds.has(goalId);
    if (selection.scope === "orphans" && !orphan) continue;

    if (selection.target === "calendar") {
      const block = mapping.calendar;
      if (!block || block.connectionId !== selection.connectionId || block.calendarId !== selection.containerId || !block.eventId) continue;
      result.push({ goalId, remoteId: block.eventId, titleSnapshot: mapping.titleSnapshot, orphan, status: block.status, remoteEtag: block.remoteEtag });
    } else {
      const block = mapping.tasks;
      // A "creating" row with no task id has nothing in Google that we know of: there is nothing to delete.
      if (!block || block.connectionId !== selection.connectionId || block.listId !== selection.containerId || !block.taskId) continue;
      result.push({ goalId, remoteId: block.taskId, titleSnapshot: mapping.titleSnapshot, orphan, status: block.status, remoteEtag: block.remoteEtag });
    }
  }

  return result.sort((a, b) => (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0));
}

function removalLabel(target: RemovalTarget): string {
  return target === "calendar" ? "Calendar event" : "Task";
}

/** One plan item per remote item. Destructive by nature: the apply step needs the count confirmation. */
export function buildRemovalItems(candidates: RemovalCandidate[], selection: RemovalSelection): PlanItem[] {
  return candidates.map((candidate) =>
    buildPlanItem({
      kind: "remove",
      target: `${selection.target}-remove:${selection.connectionId}:${selection.containerId}`,
      goalId: candidate.goalId,
      remoteId: candidate.remoteId,
      title: candidate.titleSnapshot || "(untitled goal)",
      // Direction "study_lamp": the write is made BY Study Lamp, and the history line reads "Study Lamp → Google".
      fields: [{ name: removalLabel(selection.target), before: "in Google", after: "removed", direction: "study_lamp" }],
      risk: "destructive",
      localValue: `${candidate.orphan ? "orphan" : "goal"}|${candidate.status}`,
      remoteVersion: candidate.remoteEtag,
    }),
  );
}

export interface RemovalPlan {
  planToken: string;
  /** Total number of removals in this plan (never more than REMOVAL_MAX_ITEMS). */
  count: number;
  orphans: number;
  /** Candidates beyond REMOVAL_MAX_ITEMS that a later round will handle. */
  remaining: number;
  /** A short sample for display (the plan token covers every item). */
  items: Array<{ itemId: string; goalId: string; title: string; orphan: boolean }>;
}

export interface RemovalReader {
  listMappings(): Promise<Map<string, GoalSyncMapping>>;
  listGoalIds(): Promise<string[]>;
}

async function currentItems(reader: RemovalReader, selection: RemovalSelection) {
  const [mappings, goalIds] = await Promise.all([reader.listMappings(), reader.listGoalIds()]);
  const all = collectRemovalCandidates({ mappings, goalIds: new Set(goalIds), selection });
  const chosen = all.slice(0, REMOVAL_MAX_ITEMS);
  return { candidates: chosen, items: buildRemovalItems(chosen, selection), remaining: all.length - chosen.length };
}

/** PREVIEW. Reads mapping docs and goal ids only: zero writes, no Google call. */
export async function planRemoval(reader: RemovalReader, input: { uid: string } & RemovalSelection, nowMs = Date.now()): Promise<RemovalPlan> {
  const { candidates, items, remaining } = await currentItems(reader, input);
  if (items.length === 0) return { planToken: "", count: 0, orphans: 0, remaining: 0, items: [] };
  const planToken = signPlanToken({ uid: input.uid, scope: "remove", items: items.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint })) }, nowMs);
  return {
    planToken,
    count: items.length,
    orphans: candidates.filter((candidate) => candidate.orphan).length,
    remaining,
    items: items.slice(0, 50).map((item, index) => ({ itemId: item.itemId, goalId: item.goalId ?? "", title: item.title, orphan: candidates[index].orphan })),
  };
}

/** The user's count did not match the fresh state. Carries the fresh count for the 409 response. */
export class RemovalCountMismatchError extends Error {
  readonly count: number;
  constructor(count: number) {
    super("The number of items to remove changed.");
    this.name = "RemovalCountMismatchError";
    this.count = count;
  }
}

export type RemoteDeleteOutcome = "deleted" | "already_gone";

export interface RemovalApplyDeps extends RemovalReader {
  uid: string;
  selection: RemovalSelection;
  /** Deletes ONE remote item. 404/410 must resolve as "already_gone"; any other failure throws. */
  deleteRemote(remoteId: string): Promise<RemoteDeleteOutcome>;
  /** Removes only this service's block of the mapping doc (the other service's block stays). */
  removeMapping(goalId: string, block: MappingBlock): Promise<void>;
  log?(entry: GoogleSyncLogEntry): Promise<void>;
  claimToken(uid: string, jti: string, exp: number): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}

export interface RemovalApplyResult {
  results: ApplyDecision[];
}

/**
 * APPLY. (a) verify the token, (b) check the confirmed count against the CURRENT state, (c) claim the one-time token,
 * (d) recompute the plan, (e) let the gate compare fingerprints, then delete. The request never names a remote id:
 * every id comes from our own mapping docs.
 */
export async function applyRemoval(deps: RemovalApplyDeps, input: { planToken: string; confirmCount: number }): Promise<RemovalApplyResult> {
  const verified = verifyPlanToken(input.planToken, deps.uid, "remove");

  const { candidates, items } = await currentItems(deps, deps.selection);
  if (!Number.isInteger(input.confirmCount) || input.confirmCount !== items.length || verified.items.length !== items.length) {
    throw new RemovalCountMismatchError(items.length);
  }

  const claimed = await deps.claimToken(verified.uid, verified.jti, verified.exp);
  if (!claimed) throw new PlanAlreadyAppliedError();

  const block: MappingBlock = deps.selection.target;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const candidateByItem = new Map(items.map((item, index) => [item.itemId, candidates[index]]));
  let deletedSoFar = 0;

  const writers: Record<string, (item: PlanItem) => Promise<void>> = {};
  for (const item of items) {
    writers[item.itemId] = async (fresh) => {
      const candidate = candidateByItem.get(fresh.itemId);
      if (!candidate) throw new Error("removal candidate missing");
      if (deletedSoFar > 0 && deletedSoFar % REMOVAL_CHUNK_SIZE === 0) await sleep(CHUNK_PAUSE_MS);
      deletedSoFar += 1;
      // The remote delete comes first. If it throws, the mapping stays, so the item shows up again next time.
      await deps.deleteRemote(candidate.remoteId);
      await deps.removeMapping(candidate.goalId, block);
    };
  }

  const results = await applyConfirmed({
    token: verified,
    accepted: items.map((item) => item.itemId),
    // The exact-count confirmation above is this action's extra confirmation (Global Rule 14).
    confirmedDestructive: items.map((item) => item.itemId),
    freshPlan: items,
    writers,
    expectedUser: deps.uid,
    expectedScope: "remove",
  });

  if (deps.log) {
    const itemById = new Map(items.map((item) => [item.itemId, item]));
    const now = deps.now?.() ?? new Date();
    for (const decision of results) {
      const item = itemById.get(decision.itemId);
      if (!item) continue;
      try {
        await deps.log(buildHistoryEntry(item, undefined, decision.status, now, deps.selection.target));
      } catch {
        // History is bookkeeping about something that already happened; it must not change the outcome.
      }
    }
  }

  return { results };
}

// ─── Remote delete helpers (404/410 = already gone) ─────────────────────────

export async function deleteCalendarEventIdempotent(client: Pick<CalendarWriteClient, "deleteEvent">, calendarId: string, eventId: string): Promise<RemoteDeleteOutcome> {
  try {
    await client.deleteEvent(calendarId, eventId);
    return "deleted";
  } catch (error) {
    if (error instanceof GoogleCalendarApiError && error.kind === "remote_missing") return "already_gone";
    throw error;
  }
}

export async function deleteTaskIdempotent(client: Pick<TasksWriteClient, "deleteTask">, listId: string, taskId: string): Promise<RemoteDeleteOutcome> {
  try {
    await client.deleteTask(listId, taskId);
    return "deleted";
  } catch (error) {
    if (error instanceof GoogleTasksApiError && error.kind === "remote_missing") return "already_gone";
    throw error;
  }
}
