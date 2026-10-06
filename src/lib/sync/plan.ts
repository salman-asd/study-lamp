import crypto from "crypto";

export type PlanValue = string | boolean | null;
export type PlanItemKind =
  | "push_create"
  | "push_update"
  | "pull_update"
  | "pull_create"
  | "conflict"
  | "remote_deleted"
  | "attention"
  | "append";

export type PlanRisk = "normal" | "destructive";

export interface PlanFieldChange {
  name: string;
  before: PlanValue;
  after: PlanValue;
  direction?: "study_lamp" | "google";
  /**
   * Conflict items carry BOTH sides so the dialog can show them side by side
   * (Z3 item 2/3). A field with no `direction` is an unresolved conflict.
   */
  local?: PlanValue;
  remote?: PlanValue;
}

export interface PlanItem {
  itemId: string;
  kind: PlanItemKind;
  target: string;
  goalId?: string | null;
  remoteId?: string | null;
  title: string;
  fields: PlanFieldChange[];
  risk: PlanRisk;
  fingerprint: string;
}

export interface PlanItemInput {
  kind: PlanItemKind;
  target: string;
  title: string;
  fields: PlanFieldChange[];
  risk?: PlanRisk;
  goalId?: string | null;
  remoteId?: string | null;
  localValue?: PlanValue;
  remoteVersion?: string | null;
}

export function makePlanItemId({ target, goalId, remoteId, kind }: { target: string; kind: PlanItemKind; goalId?: string | null; remoteId?: string | null }): string {
  const identity = JSON.stringify({ target, kind, goalId: goalId ?? null, remoteId: remoteId ?? null });
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function computePlanFingerprint({
  kind,
  target,
  fields,
  goalId,
  remoteId,
  localValue,
  remoteVersion,
}: {
  kind: PlanItemKind;
  target: string;
  fields: PlanFieldChange[];
  goalId?: string | null;
  remoteId?: string | null;
  localValue?: PlanValue;
  remoteVersion?: string | null;
}): string {
  const payload = JSON.stringify({
    kind,
    target,
    goalId: goalId ?? null,
    remoteId: remoteId ?? null,
    fields: fields.map((field) => ({
      name: field.name,
      before: field.before,
      after: field.after,
      direction: field.direction ?? null,
      local: field.local ?? null,
      remote: field.remote ?? null,
    })),
    localValue: localValue ?? null,
    remoteVersion: remoteVersion ?? null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function buildPlanItem(input: PlanItemInput): PlanItem {
  const itemId = makePlanItemId({ target: input.target, goalId: input.goalId, remoteId: input.remoteId, kind: input.kind });
  const fingerprint = computePlanFingerprint({
    kind: input.kind,
    target: input.target,
    goalId: input.goalId,
    remoteId: input.remoteId,
    fields: input.fields,
    localValue: input.localValue,
    remoteVersion: input.remoteVersion,
  });

  return {
    itemId,
    kind: input.kind,
    target: input.target,
    goalId: input.goalId ?? null,
    remoteId: input.remoteId ?? null,
    title: input.title,
    fields: input.fields,
    risk: input.risk ?? "normal",
    fingerprint,
  };
}
