import type { PlanItem } from "@/lib/sync/plan";
import { applyConfirmed } from "@/lib/server/applyGate";
import { verifyPlanToken, type PlanScope, type PlanTokenItem } from "@/lib/server/planToken";

export interface GoalSyncApplyInput {
  token: string;
  accepted: Iterable<string>;
  resolutions?: Record<string, "use_study_lamp" | "use_google" | "skip">;
  confirmedDestructive?: Iterable<string>;
  freshPlan: PlanItem[];
  expectedUser?: string;
  expectedScope?: PlanScope;
  writers?: Record<string, (item: PlanItem) => Promise<void> | void>;
}

export async function applyGoalSyncPlan({
  token,
  accepted,
  resolutions,
  confirmedDestructive,
  freshPlan,
  expectedUser,
  expectedScope,
  writers = {},
}: GoalSyncApplyInput) {
  const verification = verifyPlanToken(token, expectedUser, expectedScope);
  const acceptedSet = new Set(accepted);
  const confirmedDestructiveSet = new Set(confirmedDestructive ?? []);

  return applyConfirmed({
    token: verification,
    accepted: acceptedSet,
    resolutions,
    confirmedDestructive: confirmedDestructiveSet,
    freshPlan,
    writers,
    expectedUser,
    expectedScope,
  });
}

export function isValidPlanTokenItem(value: unknown): value is PlanTokenItem {
  return !!value && typeof value === "object" && typeof (value as any).itemId === "string" && typeof (value as any).fingerprint === "string";
}
