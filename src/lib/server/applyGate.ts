import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";
import type { PlanItem } from "@/lib/sync/plan";

export type ApplyDecisionStatus = "applied" | "stale" | "skipped" | "failed";

export interface ApplyDecision {
  itemId: string;
  status: ApplyDecisionStatus;
  code?: string;
}

/** A writer returns nothing when it wrote, or `{ skipped: code }` when it deliberately did nothing. */
export type WriterOutcome = void | { skipped: string };

export interface ApplyConfirmedInput {
  token: string | { uid: string; scope: PlanScope; items: PlanTokenItem[]; exp: number };
  accepted: Iterable<string>;
  resolutions?: Record<string, "use_study_lamp" | "use_google" | "skip">;
  confirmedDestructive?: Iterable<string>;
  freshPlan: PlanItem[];
  writers: Record<string, (item: PlanItem) => Promise<WriterOutcome> | WriterOutcome>;
  expectedUser?: string;
  expectedScope?: PlanScope;
}

export async function applyConfirmed({
  token,
  accepted,
  resolutions = {},
  confirmedDestructive = [],
  freshPlan,
  writers,
  expectedUser,
  expectedScope,
}: ApplyConfirmedInput): Promise<ApplyDecision[]> {
  const verified = typeof token === "string" ? verifyPlanToken(token, expectedUser, expectedScope) : token;
  const acceptedSet = new Set(accepted);
  const confirmedDestructiveSet = new Set(confirmedDestructive);
  const tokenItems = new Map(verified.items.map((item) => [item.itemId, item.fingerprint]));
  const freshById = new Map(freshPlan.map((item) => [item.itemId, item]));

  const results: ApplyDecision[] = [];
  const seenItemIds = new Set<string>();

  for (const item of freshPlan) {
    const itemId = item.itemId;
    if (!tokenItems.has(itemId)) {
      continue;
    }
    seenItemIds.add(itemId);

    if (!acceptedSet.has(itemId)) {
      results.push({ itemId, status: "skipped", code: "not_accepted" });
      continue;
    }

    const expectedFingerprint = tokenItems.get(itemId);
    if (expectedFingerprint !== item.fingerprint) {
      results.push({ itemId, status: "stale", code: "fingerprint_mismatch" });
      continue;
    }

    // Z3 item 3: resolutions are per FIELD for conflict items ({itemId}:{field} -> choice).
    // Every conflicting field (one with no decided direction) must be resolved; the old
    // per-item key is still accepted so callers that don't split fields keep working.
    if (item.kind === "conflict") {
      const conflictingFields = item.fields.filter((field) => field.direction !== "study_lamp" && field.direction !== "google");
      const perItemResolution = resolutions[itemId];
      let unresolved = false;
      for (const field of conflictingFields) {
        const choice = resolutions[`${itemId}:${field.name}`];
        if (choice === undefined && perItemResolution === undefined) {
          unresolved = true;
          break;
        }
        if (choice === "skip") {
          unresolved = true;
          break;
        }
      }
      if (conflictingFields.length === 0 && (!perItemResolution || perItemResolution === "skip")) {
        unresolved = true;
      }
      if (unresolved) {
        results.push({ itemId, status: "skipped", code: "missing_resolution" });
        continue;
      }
    }

    if (item.risk === "destructive" && !confirmedDestructiveSet.has(itemId)) {
      results.push({ itemId, status: "skipped", code: "destructive_not_confirmed" });
      continue;
    }

    const writer = writers[itemId];
    if (!writer) {
      results.push({ itemId, status: "skipped", code: "no_writer" });
      continue;
    }

    try {
      const outcome = await writer(freshById.get(itemId) ?? item);
      if (outcome && typeof outcome === "object" && typeof outcome.skipped === "string") {
        // Rule 8: a deliberate no-op is "skipped" with a code, never "applied".
        results.push({ itemId, status: "skipped", code: outcome.skipped });
      } else {
        results.push({ itemId, status: "applied" });
      }
    } catch {
      results.push({ itemId, status: "failed", code: "writer_error" });
    }
  }

  // Rule 8: an item the user confirmed but that is no longer in the fresh plan is
  // reported as stale (never silently dropped).
  for (const itemId of tokenItems.keys()) {
    if (!seenItemIds.has(itemId)) {
      results.push({ itemId, status: "stale", code: "item_gone" });
    }
  }

  return results;
}
