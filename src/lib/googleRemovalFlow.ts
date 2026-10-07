/**
 * Client-side orchestration of the explicit removal (W5): preview -> confirm -> apply, in rounds when there are more
 * than one plan holds. Pure (the two API calls are injected), so it is unit-tested without a browser or a server.
 * Nothing here runs without the caller having asked the user first.
 */

export type RemovalTarget = "calendar" | "tasks";
export type RemovalScope = "orphans" | "all";

export interface RemovalPreviewResult {
  planToken: string;
  count: number;
  orphans: number;
  remaining: number;
  items: Array<{ itemId: string; goalId: string; title: string; orphan: boolean }>;
}

export interface RemovalApplyResult {
  ok: boolean;
  applied: number;
  skipped: number;
  failed: number;
}

export interface RemovalApi {
  preview(input: { target: RemovalTarget; scope: RemovalScope; connectionId: string }): Promise<RemovalPreviewResult>;
  apply(input: { planToken: string; confirmCount: number; target: RemovalTarget; scope: RemovalScope; connectionId: string }): Promise<RemovalApplyResult>;
}

export const REMOVAL_MAX_ROUNDS = 10;

export class RemovalIncompleteError extends Error {
  readonly removed: number;
  constructor(message: string, removed: number) {
    super(message);
    this.name = "RemovalIncompleteError";
    this.removed = removed;
  }
}

/**
 * Removes everything Study Lamp created for one target of one connection. The caller has ALREADY shown the user the
 * expected total and got their confirmation. Each round re-previews and confirms with the fresh count of that round.
 * Throws RemovalIncompleteError when an item could not be removed, so a disconnect that depends on it does not go on.
 */
export async function removeAllForTarget(api: RemovalApi, target: RemovalTarget, connectionId: string): Promise<number> {
  let removed = 0;
  for (let round = 0; round < REMOVAL_MAX_ROUNDS; round += 1) {
    const plan = await api.preview({ target, scope: "all", connectionId });
    if (plan.count === 0) return removed;
    const result = await api.apply({ planToken: plan.planToken, confirmCount: plan.count, target, scope: "all", connectionId });
    removed += result.applied;
    if (result.failed > 0 || result.skipped > 0) {
      throw new RemovalIncompleteError(
        `Only ${removed} item${removed === 1 ? "" : "s"} could be removed from ${target === "calendar" ? "Calendar" : "Tasks"}. Nothing else was changed, and the account was not disconnected.`,
        removed,
      );
    }
    if (plan.remaining === 0) return removed;
  }
  throw new RemovalIncompleteError("There were too many items to remove in one go. Run it again.", removed);
}

export function describeRemovalCount(target: RemovalTarget, count: number): string {
  const noun = target === "calendar" ? (count === 1 ? "event" : "events") : count === 1 ? "task" : "tasks";
  return `${count} ${noun}`;
}

/**
 * Disconnect with the OPTIONAL removal (W5). Without the option nothing in Google is touched. With it, every removal
 * finishes (and was confirmed by the user) BEFORE `disconnect` runs; if one fails, `disconnect` is never called, so the
 * stored token is kept and the user can retry. Returns how many items were removed.
 */
export async function removeThenDisconnect(input: {
  alsoRemove: boolean;
  counts: Record<RemovalTarget, number>;
  connectionId: string;
  api: RemovalApi;
  disconnect: () => Promise<void>;
}): Promise<number> {
  let removed = 0;
  if (input.alsoRemove) {
    for (const target of ["calendar", "tasks"] as const) {
      if (input.counts[target] > 0) removed += await removeAllForTarget(input.api, target, input.connectionId);
    }
  }
  await input.disconnect();
  return removed;
}
