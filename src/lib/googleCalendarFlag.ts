/**
 * Browser-side cache of "is Calendar sync on for this user?" and "when did we last check automatically?".
 * It only decides whether the app bothers to ask the server for a READ-ONLY plan; it never authorises a write
 * (every write still needs a signed plan token and an explicit confirmation).
 * localStorage can be missing or blocked, so every access is guarded and the app works without it.
 */

export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;

function defaultStorage(): FlagStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const enabledKey = (uid: string) => `studylamp:gcal:enabled:${uid}`;
const checkedKey = (uid: string) => `studylamp:gcal:lastAutoCheck:${uid}`;

export function readCalendarFlag(uid: string, storage: FlagStorage | null = defaultStorage()): boolean | null {
  try {
    const value = storage?.getItem(enabledKey(uid));
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeCalendarFlag(uid: string, enabled: boolean, storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(enabledKey(uid), enabled ? "1" : "0");
  } catch {
    // Storage is only a cache.
  }
}

export function readLastAutoCheck(uid: string, storage: FlagStorage | null = defaultStorage()): number {
  try {
    const value = Number(storage?.getItem(checkedKey(uid)) ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeLastAutoCheck(uid: string, at: number, storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(checkedKey(uid), String(at));
  } catch {
    // Storage is only a cache.
  }
}

/** At most one automatic read-only check per interval. A clock that went backwards counts as "due". */
export function isAutoCheckDue(lastCheckAt: number, now: number, intervalMs = AUTO_CHECK_INTERVAL_MS): boolean {
  if (!lastCheckAt) return true;
  if (now < lastCheckAt) return true;
  return now - lastCheckAt >= intervalMs;
}

/** Items the user can act on (attention items are shown in the dialog but are not "changes ready"). */
export function countActionableItems(items: Array<{ kind: string }>): number {
  return items.filter((item) => item.kind !== "attention").length;
}
