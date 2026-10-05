export type SyncFieldValue = string | boolean | null;
export type FieldDecision = "unchanged" | "push" | "pull" | "converged" | "conflict";

export interface DecideFieldInput {
  base?: SyncFieldValue;
  local: SyncFieldValue;
  remote: SyncFieldValue;
}

export function decideField({ base, local, remote }: DecideFieldInput): FieldDecision {
  const hasBase = typeof base !== "undefined";

  if (local === remote) {
    if (hasBase && local !== base) return "converged";
    return "unchanged";
  }

  if (!hasBase) return "conflict";
  if (local !== base && remote === base) return "push";
  if (remote !== base && local === base) return "pull";
  if (local !== base && remote !== base) return "conflict";

  return "unchanged";
}
