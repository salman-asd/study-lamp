import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";
import type { PlanItem, SyncResolution } from "@/lib/sync/plan";

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
  /** Keyed by itemId, or `${itemId}:${field}` for one field of a conflict item. */
  resolutions?: Record<string, SyncResolution>;
  confirmedDestructive?: Iterable<string>;
  freshPlan: PlanItem[];
  writers: Record<string, (item: PlanItem) => Promise<WriterOutcome> | WriterOutcome>;
  expectedUser?: string;
  expectedScope?: PlanScope;
}

function isDecidedField(field: PlanItem["fields"][number]): boolean {
  return field.direction === "study_lamp" || field.direction === "google";
}

function isSideChoice(choice: SyncResolution | undefined): boolean {
  return choice === "use_study_lamp" || choice === "use_google";
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

    // Z3 item 3: resolutions are per FIELD for conflict items ({itemId}:{field} -> choice); a per-item
    // key is the fallback. A field the user left on "skip" is NOT an error: the writer leaves that
    // field alone on both sides (the conflict simply shows up again next time) and applies the rest.
    // The item is refused only when nothing at all can be applied.
    if (item.kind === "conflict") {
      const conflictingFields = item.fields.filter((field) => !isDecidedField(field));
      const decidedCount = item.fields.length - conflictingFields.length;
      const choiceFor = (fieldName: string) => resolutions[`${itemId}:${fieldName}`] ?? resolutions[itemId];
      const resolvedCount = conflictingFields.filter((field) => isSideChoice(choiceFor(field.name))).length;
      const nothingToApply = conflictingFields.length > 0
        ? resolvedCount === 0 && decidedCount === 0
        : !isSideChoice(resolutions[itemId]);
      if (nothingToApply) {
        results.push({ itemId, status: "skipped", code: "missing_resolution" });
        continue;
      }
    }

    // A deletion needs its own confirmation. That is true for an item flagged destructive AND for an
    // item where the user picked "delete_goal" (remote_deleted is only destructive for that choice).
    const isDestructive = item.risk === "destructive" || resolutions[itemId] === "delete_goal";
    if (isDestructive && !confirmedDestructiveSet.has(itemId)) {
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
      // The writer's own error is deliberately not copied into the result (Rule 4/5); writers that
      // need the error logged do so themselves before rethrowing.
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
