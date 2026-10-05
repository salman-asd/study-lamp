import type { Goal } from "@/types";
import { buildPlanItem, type PlanItem } from "@/lib/sync/plan";
import { decideField } from "@/lib/sync/threeWay";
import { signPlanToken } from "@/lib/server/planToken";

export interface GoalRemoteEvent {
  remoteId: string;
  title: string;
  targetDate?: string | null;
  base?: {
    title?: string | null;
    targetDate?: string | null;
  };
  status?: "active" | "cancelled" | "deleted" | "failed";
  etag?: string | null;
}

export interface BuildGoalSyncPlanInput {
  uid: string;
  goals: Goal[];
  remoteEvents?: GoalRemoteEvent[];
  goalIds?: string[];
  scope?: "calendar" | "tasks";
}

export interface GoalSyncPlanResult {
  items: PlanItem[];
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
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function fieldChangesForDecision({
  name,
  base,
  local,
  remote,
  direction,
}: {
  name: string;
  base: string | null;
  local: string | null;
  remote: string | null;
  direction: "study_lamp" | "google";
}): { name: string; before: string | null; after: string | null; direction: "study_lamp" | "google" } | null {
  const before = base;
  const after = direction === "google" ? remote : local;
  if (before === after) return null;
  return { name, before, after, direction };
}

export function buildGoalSyncPlan({ uid, goals, remoteEvents = [], goalIds, scope = "calendar" }: BuildGoalSyncPlanInput): GoalSyncPlanResult {
  const filteredGoals = typeof goalIds === "undefined" || goalIds.length === 0
    ? goals
    : goals.filter((goal) => goalIds.includes(goal.id));

  const remoteById = new Map<string, GoalRemoteEvent>();
  for (const remote of remoteEvents) {
    remoteById.set(remote.remoteId, remote);
    remoteById.set(`goal:${remote.remoteId}`, remote);
  }

  const items: PlanItem[] = [];
  const counts = { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0 };

  for (const goal of filteredGoals) {
    const remoteId = goal.id;
    const remote = remoteById.get(remoteId) ?? remoteById.get(`goal:${remoteId}`);
    const localTitle = goal.title ?? "";
    const localTargetDate = goal.targetDate ?? null;

    if (!remote) {
      if (!isValidGoalDate(localTargetDate)) continue;
      items.push(buildPlanItem({
        kind: "push_create",
        target: `goal:${goal.id}`,
        goalId: goal.id,
        title: localTitle,
        fields: [
          { name: "title", before: null, after: localTitle, direction: "study_lamp" },
          { name: "targetDate", before: null, after: localTargetDate, direction: "study_lamp" },
        ],
        localValue: localTitle,
        remoteVersion: "new",
      }));
      counts.push += 1;
      continue;
    }

    if (remote.status === "deleted" || remote.status === "cancelled") {
      items.push(buildPlanItem({
        kind: "remote_deleted",
        target: `goal:${goal.id}`,
        goalId: goal.id,
        remoteId: remote.remoteId,
        title: goal.title || remote.title,
        fields: [
          { name: "title", before: remote.title ?? null, after: goal.title ?? null, direction: "study_lamp" },
          { name: "targetDate", before: remote.targetDate ?? null, after: localTargetDate, direction: "study_lamp" },
        ],
        risk: "destructive",
        localValue: localTitle,
        remoteVersion: remote.etag ?? "deleted",
      }));
      counts.remoteDeleted += 1;
      continue;
    }

    if (!isValidGoalDate(localTargetDate)) {
      items.push(buildPlanItem({
        kind: "attention",
        target: `goal:${goal.id}`,
        goalId: goal.id,
        remoteId: remote.remoteId,
        title: goal.title || remote.title,
        fields: [{ name: "targetDate", before: remote.targetDate ?? null, after: null, direction: "google" }],
        risk: "normal",
        localValue: localTitle,
        remoteVersion: remote.etag ?? "no_date",
      }));
      counts.attention += 1;
      continue;
    }

    const titleBase = remote.base?.title ?? remote.title ?? null;
    const dateBase = remote.base?.targetDate ?? remote.targetDate ?? null;
    const titleDecision = decideField({ base: titleBase, local: localTitle, remote: remote.title ?? localTitle });
    const dateDecision = decideField({ base: dateBase, local: localTargetDate, remote: remote.targetDate ?? localTargetDate });

    const fieldChanges = [
      fieldChangesForDecision({ name: "title", base: titleBase, local: localTitle, remote: remote.title ?? localTitle, direction: titleDecision === "pull" ? "google" : "study_lamp" }),
      fieldChangesForDecision({ name: "targetDate", base: dateBase, local: localTargetDate, remote: remote.targetDate ?? localTargetDate, direction: dateDecision === "pull" ? "google" : "study_lamp" }),
    ].filter((field): field is NonNullable<typeof field> => field !== null);

    if (fieldChanges.length === 0) continue;

    const hasConflict = titleDecision === "conflict" || dateDecision === "conflict";
    const hasPull = titleDecision === "pull" || dateDecision === "pull";
    const kind: PlanItem["kind"] = hasConflict ? "conflict" : hasPull ? "pull_update" : "push_update";

    const item = buildPlanItem({
      kind,
      target: `goal:${goal.id}`,
      goalId: goal.id,
      remoteId: remote.remoteId,
      title: localTitle || remote.title,
      fields: fieldChanges,
      risk: kind === "conflict" ? "normal" : "normal",
      localValue: localTitle,
      remoteVersion: remote.etag ?? "remote-default",
    });

    if (kind === "conflict") counts.conflict += 1;
    else if (kind === "pull_update") counts.pull += 1;
    else counts.push += 1;

    items.push(item);
  }

  const sliced = items.slice(0, MAX_PLAN_ITEMS);
  const tokenItems = sliced.map((item) => ({ itemId: item.itemId, fingerprint: item.fingerprint }));
  const planToken = signPlanToken({ uid, scope, items: tokenItems });

  return {
    items: sliced,
    counts,
    remaining: Math.max(0, items.length - MAX_PLAN_ITEMS),
    planToken,
  };
}
