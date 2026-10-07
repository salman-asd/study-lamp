/**
 * Browser-side cache of "is Calendar (or Tasks) sync on for this user?", "which Google connection is it on for?" and
 * "when did we last check automatically?".
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

// ─── Tasks flag and cached connection id (audit M2, M3) ─────────────────────

export type SyncService = "calendar" | "tasks";

const tasksEnabledKey = (uid: string) => `studylamp:gtasks:enabled:${uid}`;
const connectionKey = (uid: string, service: SyncService) => `studylamp:${service === "tasks" ? "gtasks" : "gcal"}:connection:${uid}`;

export function readTasksFlag(uid: string, storage: FlagStorage | null = defaultStorage()): boolean | null {
  try {
    const value = storage?.getItem(tasksEnabledKey(uid));
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeTasksFlag(uid: string, enabled: boolean, storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(tasksEnabledKey(uid), enabled ? "1" : "0");
  } catch {
    // Storage is only a cache.
  }
}

/**
 * The id of the Google connection the sync is on for. With several connections the server cannot guess, so the pages
 * send this id along with every read-only check. It is only a hint: the server still checks that the connection belongs
 * to the signed-in user, and an empty or malformed value is treated as "unknown".
 */
export function readSyncConnectionId(uid: string, service: SyncService, storage: FlagStorage | null = defaultStorage()): string | null {
  try {
    const value = storage?.getItem(connectionKey(uid, service));
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** `null` forgets the cached id (the connection was removed, or the server said it no longer exists). */
export function writeSyncConnectionId(uid: string, service: SyncService, connectionId: string | null, storage: FlagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(connectionKey(uid, service), connectionId ?? "");
  } catch {
    // Storage is only a cache.
  }
}

/**
 * What to cache after the settings page loads (or changes) the connection list: whether the sync is on for any usable
 * connection, and WHICH connection when exactly one has it on. With two or more on, no id is cached and the goals page
 * shows the "keep it on for just one" banner instead of guessing (audit M2).
 */
export function syncCacheFromConnections(
  connections: ReadonlyArray<{ id: string; status: string; calendarEnabled: boolean; tasksEnabled: boolean }>,
  service: SyncService,
): { enabled: boolean; connectionId: string | null } {
  const on = connections.filter((connection) => connection.status === "active" && (service === "tasks" ? connection.tasksEnabled : connection.calendarEnabled));
  return { enabled: on.length > 0, connectionId: on.length === 1 ? on[0].id : null };
}

/** Writes the flag and connection id for both services from one connection list. */
export function cacheSyncStateFromConnections(
  uid: string,
  connections: Parameters<typeof syncCacheFromConnections>[0],
  storage: FlagStorage | null = defaultStorage(),
): void {
  const calendar = syncCacheFromConnections(connections, "calendar");
  writeCalendarFlag(uid, calendar.enabled, storage);
  writeSyncConnectionId(uid, "calendar", calendar.connectionId, storage);
  const tasks = syncCacheFromConnections(connections, "tasks");
  writeTasksFlag(uid, tasks.enabled, storage);
  writeSyncConnectionId(uid, "tasks", tasks.connectionId, storage);
}
