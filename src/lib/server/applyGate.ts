import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";
import type { PlanItem } from "@/lib/sync/plan";

export type ApplyDecisionStatus = "applied" | "stale" | "skipped" | "failed";

export interface ApplyDecision {
  itemId: string;
  status: ApplyDecisionStatus;
  code?: string;
}

export interface ApplyConfirmedInput {
  token: string | { uid: string; scope: PlanScope; items: PlanTokenItem[]; exp: number };
  accepted: Iterable<string>;
  resolutions?: Record<string, "use_study_lamp" | "use_google" | "skip">;
  confirmedDestructive?: Iterable<string>;
  freshPlan: PlanItem[];
  writers: Record<string, (item: PlanItem) => Promise<void> | void>;
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

  for (const item of freshPlan) {
    const itemId = item.itemId;
    if (!tokenItems.has(itemId)) {
      continue;
    }

    if (!acceptedSet.has(itemId)) {
      results.push({ itemId, status: "skipped", code: "not_accepted" });
      continue;
    }

    const expectedFingerprint = tokenItems.get(itemId);
    if (expectedFingerprint !== item.fingerprint) {
      results.push({ itemId, status: "stale", code: "fingerprint_mismatch" });
      continue;
    }

    const resolution = resolutions[itemId];
    if (item.kind === "conflict" && (!resolution || resolution === "skip")) {
      results.push({ itemId, status: "skipped", code: "missing_resolution" });
      continue;
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
      await writer(freshById.get(itemId) ?? item);
      results.push({ itemId, status: "applied" });
    } catch {
      results.push({ itemId, status: "failed", code: "writer_error" });
    }
  }

  return results;
}
