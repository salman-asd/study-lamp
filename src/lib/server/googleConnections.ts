import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { encryptApiKey, decryptApiKey } from "@/lib/server/aiEncryption";
import { CalendarDeletedError, createCalendarClient, ensureStudyLampCalendar } from "@/lib/server/googleCalendar";
import { refreshWorkspaceAccessToken, revokeWorkspaceToken } from "@/lib/server/googleWorkspaceAuth";
import { DriveTokenCache } from "@/lib/server/driveTokenCache";
import { runWithDriveToken } from "@/lib/server/driveRequest";
import { type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";
import { listGoalSyncMappings } from "@/lib/server/googleSyncState";
import { computeSyncCounts } from "@/lib/server/googleSyncMapping";
import type { GoogleCalendarConnection, GoogleConnectionSummary, GoogleSyncCounts, GoogleSyncStatus } from "@/types";

const DEFAULT_COUNTS: GoogleSyncCounts = {
  synced: 0,
  failed: 0,
  remoteDeleted: 0,
  unlinked: 0,
  noDate: 0,
  orphaned: 0,
};

// Reuse the same primitives as the Drive token path (Step W2 spec): a bounded
// in-memory access-token cache and the shared 401-retry wrapper.
const accessTokenCache = new DriveTokenCache(500, 60_000);
const lastUsedWriteAt = new Map<string, number>();
const LAST_USED_WRITE_INTERVAL_MS = 15 * 60_000;

function googleConnectionsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleConnections");
}

function cacheKey(uid: string, connectionId: string): string {
  return `${uid}:${connectionId}`;
}

function toIso(value: admin.firestore.Timestamp | null | undefined): string | null {
  return value ? value.toDate().toISOString() : null;
}

export function googleConnectionSummaryFrom(id: string, data: FirebaseFirestore.DocumentData): GoogleConnectionSummary {
  const grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes.filter((scope): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks") : [];
  const calendarEnabled = Boolean(data.calendar?.enabled ?? data.enabled ?? false);
  const tasksEnabled = Boolean(data.tasks?.enabled ?? false);
  // EXACT key set returned to the browser. Tokens and ciphertext
  // (encryptedRefreshToken) are deliberately never included; a test asserts
  // this key set so a future field cannot leak silently.
  return {
    id,
    googleEmail: String(data.googleEmail ?? ""),
    status: data.status === "invalid" ? "invalid" : "active",
    grantedScopes,
    calendarEnabled,
    tasksEnabled,
    createdAt: toIso(data.createdAt ?? null),
    lastUsedAt: toIso(data.lastUsedAt ?? null),
  };
}

export async function listGoogleConnections(uid: string): Promise<GoogleConnectionSummary[]> {
  const snap = await googleConnectionsRef(uid).orderBy("createdAt", "asc").get();
  return snap.docs.map((doc) => googleConnectionSummaryFrom(doc.id, doc.data()));
}

export async function getGoogleConnectionSummary(uid: string, id: string): Promise<GoogleConnectionSummary | null> {
  const snap = await googleConnectionsRef(uid).doc(id).get();
  if (!snap.exists) return null;
  return googleConnectionSummaryFrom(snap.id, snap.data()!);
}

export async function upsertGoogleConnection(
  uid: string,
  input: { googleEmail: string; refreshToken: string; grantedScopes: GoogleWorkspaceFeature[] },
): Promise<GoogleConnectionSummary> {
  const existing = await googleConnectionsRef(uid).where("googleEmail", "==", input.googleEmail).limit(1).get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    googleEmail: input.googleEmail,
    encryptedRefreshToken: encryptApiKey(input.refreshToken),
    grantedScopes: Array.from(new Set(input.grantedScopes)),
    status: "active",
    calendar: { enabled: false },
    tasks: { enabled: false },
    createdAt: now as any,
    updatedAt: now as any,
    lastUsedAt: null,
  };

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    const previous = existing.docs[0].data();
    await ref.set({
      ...doc,
      calendar: previous.calendar ?? { enabled: false },
      tasks: previous.tasks ?? { enabled: false },
      createdAt: previous.createdAt ?? now,
      lastUsedAt: previous.lastUsedAt ?? null,
      // MERGE rather than replace: an incremental "Allow Tasks access" flow
      // must never drop a Calendar grant the user already made.
      grantedScopes: Array.from(new Set([...(Array.isArray(previous.grantedScopes) ? previous.grantedScopes : []), ...doc.grantedScopes])),
      updatedAt: now,
    }, { merge: true });
    invalidateAccessToken(uid, ref.id);
    const snap = await ref.get();
    return googleConnectionSummaryFrom(snap.id, snap.data()!);
  }

  const ref = googleConnectionsRef(uid).doc();
  await ref.set(doc);
  invalidateAccessToken(uid, ref.id);
  const snap = await ref.get();
  return googleConnectionSummaryFrom(snap.id, snap.data()!);
}

export async function deleteGoogleConnection(uid: string, connectionId: string): Promise<boolean> {
  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  invalidateAccessToken(uid, connectionId);
  const refreshToken = decryptApiKey(snap.data()!.encryptedRefreshToken);
  await revokeWorkspaceToken(refreshToken).catch(() => undefined);
  await ref.delete();
  return true;
}

export function invalidateAccessToken(uid: string, connectionId: string): void {
  const key = cacheKey(uid, connectionId);
  accessTokenCache.invalidate(key);
  lastUsedWriteAt.delete(key);
}

export class GoogleConnectionError extends Error {
  code: "not_found" | "invalid" | "network" | "scope_missing" | "calendar_deleted";
  constructor(code: GoogleConnectionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Runs `operation` with a fresh access token for the connection. Delegates to
 *  the shared runWithDriveToken wrapper, which retries the operation once after
 *  a Google 401 (refreshing the token in between) and invalidates the cache.
 *  The optional `tokenProvider` is injectable for tests. */
export async function withGoogleAccessToken<T>(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
  operation: (accessToken: string) => Promise<T>,
  tokenProvider: () => Promise<string> = () => getAccessTokenForConnection(uid, connectionId, requiredFeature),
): Promise<T> {
  return runWithDriveToken(
    tokenProvider,
    () => invalidateAccessToken(uid, connectionId),
    operation,
  );
}

export interface GoogleAccessTokenDependencies {
  refreshAccessToken: typeof refreshWorkspaceAccessToken;
}

/** Pure scope check used by both the token path and its tests. */
export function grantedFeaturesOf(data: FirebaseFirestore.DocumentData): GoogleWorkspaceFeature[] {
  return Array.isArray(data.grantedScopes)
    ? data.grantedScopes.filter((scope: unknown): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks")
    : [];
}

/** Pure core of the token path: refuses a connection missing `requiredFeature`
 *  (scope_missing), refreshes through the injected `refresh`, and classifies
 *  failures as invalid (revoked/expired refresh token) or network. Extracted so
 *  it can be unit-tested with an injected refresh function and no Firestore. */
export async function resolveGoogleAccessToken(
  data: FirebaseFirestore.DocumentData,
  requiredFeature: GoogleWorkspaceFeature,
  refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  if (!grantedFeaturesOf(data).includes(requiredFeature)) {
    throw new GoogleConnectionError("scope_missing", `This Google connection does not have ${requiredFeature} access enabled.`);
  }

  const refreshToken = decryptApiKey(data.encryptedRefreshToken);
  try {
    const { accessToken, expiresIn } = await refresh(refreshToken);
    return { token: accessToken, expiresAt: now + Math.max(0, expiresIn) * 1000 };
  } catch (error: any) {
    if (error?.googleAuthInvalid || error?.driveAuthInvalid) {
      throw new GoogleConnectionError("invalid", "This Google connection needs to be reconnected.");
    }
    throw new GoogleConnectionError("network", "Couldn't reach Google. Please try again shortly.");
  }
}

/** Returns a cached Workspace access token, refreshing it through the injected
 *  `refreshAccessToken` (defaults to the real Google call). Refuses a
 *  connection that is missing the required feature with a scope_missing error,
 *  marks the connection invalid on invalid_grant, and writes lastUsedAt at most
 *  once every 15 minutes. */
export async function getAccessTokenForConnection(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
  dependencies: Partial<GoogleAccessTokenDependencies> = {},
): Promise<string> {
  const key = cacheKey(uid, connectionId);
  return accessTokenCache.get(key, async () => {
    const ref = googleConnectionsRef(uid).doc(connectionId);
    const snap = await ref.get();
    if (!snap.exists) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");

    const data = snap.data()!;
    const now = Date.now();
    const refresh = dependencies.refreshAccessToken ?? refreshWorkspaceAccessToken;

    let resolved: { token: string; expiresAt: number };
    try {
      resolved = await resolveGoogleAccessToken(data, requiredFeature, refresh, now);
    } catch (error) {
      if (error instanceof GoogleConnectionError && error.code === "invalid") {
        invalidateAccessToken(uid, connectionId);
        await ref.update({ status: "invalid", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      throw error;
    }

    const storedLastUsedAt = typeof data.lastUsedAt?.toMillis === "function" ? data.lastUsedAt.toMillis() : 0;
    const lastWrittenAt = Math.max(storedLastUsedAt, lastUsedWriteAt.get(key) ?? 0);
    if (now - lastWrittenAt >= LAST_USED_WRITE_INTERVAL_MS) {
      try {
        await ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
        lastUsedWriteAt.set(key, now);
      } catch {
        // Usage metadata must never prevent using a valid token.
      }
    }

    return resolved;
  });
}

/** Connection ids are Firestore doc ids: non-empty, no slashes, bounded. Anything else is rejected before a lookup. */
export function isPlausibleConnectionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("/");
}

export interface CalendarSettingsView {
  enabled: boolean;
  calendarId: string | null;
  calendarName: string | null;
  lastCheckAt: string | null;
}

/** Reads the `calendar` block of a connection doc. Pure. */
export function calendarSettingsFrom(data: FirebaseFirestore.DocumentData): CalendarSettingsView {
  const calendar = data.calendar && typeof data.calendar === "object" ? data.calendar : {};
  return {
    enabled: calendar.enabled === true,
    calendarId: typeof calendar.calendarId === "string" && calendar.calendarId ? calendar.calendarId : null,
    calendarName: typeof calendar.calendarName === "string" && calendar.calendarName ? calendar.calendarName : null,
    lastCheckAt: toIso(calendar.lastCheckAt ?? null),
  };
}

function hasUsableToken(data: FirebaseFirestore.DocumentData | undefined): data is FirebaseFirestore.DocumentData {
  return !!data && typeof data.encryptedRefreshToken === "string" && data.encryptedRefreshToken.length > 0;
}

function calendarConnectionFrom(id: string, data: FirebaseFirestore.DocumentData): GoogleCalendarConnection {
  const settings = calendarSettingsFrom(data);
  return {
    id,
    enabled: settings.enabled,
    calendarId: settings.calendarId,
    calendarName: settings.calendarName,
    lastSyncAt: settings.lastCheckAt,
    counts: { ...DEFAULT_COUNTS },
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/** Reads one connection (by its REAL doc id) as a Calendar view. Null if it does not exist or is not a real connection. */
export async function getGoogleCalendarConnection(uid: string, connectionId: string): Promise<GoogleCalendarConnection | null> {
  if (!isPlausibleConnectionId(connectionId)) return null;
  const snap = await googleConnectionsRef(uid).doc(connectionId).get();
  const data = snap.data();
  if (!snap.exists || !hasUsableToken(data)) return null;
  return calendarConnectionFrom(snap.id, data);
}

/**
 * Picks the connection a Calendar route should use. An explicit id must belong to this user and have the calendar
 * permission. Without one, the user must have exactly one connection with the calendar permission.
 */
export async function resolveCalendarConnectionId(uid: string, requestedId?: string | null): Promise<string> {
  if (requestedId) {
    if (!isPlausibleConnectionId(requestedId)) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    const snap = await googleConnectionsRef(uid).doc(requestedId).get();
    if (!snap.exists || !hasUsableToken(snap.data())) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    if (!grantedFeaturesOf(snap.data()!).includes("calendar")) throw new GoogleConnectionError("scope_missing", "This Google connection does not have calendar access enabled.");
    return snap.id;
  }

  const snap = await googleConnectionsRef(uid).get();
  const candidates = snap.docs.filter((doc) => hasUsableToken(doc.data()) && grantedFeaturesOf(doc.data()).includes("calendar"));
  if (candidates.length === 0) throw new GoogleConnectionError("not_found", "No Google connection with calendar access was found.");
  if (candidates.length > 1) throw new GoogleConnectionError("not_found", "Choose which Google connection to use.");
  return candidates[0].id;
}

/**
 * Turns Calendar sync on or off for one connection. Enabling verifies the stored calendar (calendars.get) or creates
 * "Study Lamp goals" (calendars.insert); it writes no events. Disabling only flips the flag.
 * A calendar that was deleted in Google is NOT silently re-created: the stored id is cleared, sync stays off, and
 * the caller gets "calendar_deleted"; the user must enable again explicitly.
 */
export async function setGoogleCalendarEnabled(uid: string, connectionId: string, enabled: boolean): Promise<GoogleCalendarConnection> {
  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists || !hasUsableToken(snap.data())) {
    throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  if (!enabled) {
    await ref.update({ "calendar.enabled": false, updatedAt: now });
  } else {
    if (!grantedFeaturesOf(snap.data()!).includes("calendar")) {
      throw new GoogleConnectionError("scope_missing", "This Google connection does not have calendar access enabled.");
    }

    const accessToken = await getAccessTokenForConnection(uid, connectionId, "calendar");
    const client = createCalendarClient(accessToken);
    const stored = calendarSettingsFrom(snap.data()!);

    try {
      const calendar = await ensureStudyLampCalendar(client, stored.calendarId, "Study Lamp goals");
      await ref.update({
        "calendar.enabled": true,
        "calendar.calendarId": calendar.id,
        "calendar.calendarName": calendar.summary,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof CalendarDeletedError) {
        await ref.update({ "calendar.enabled": false, "calendar.calendarId": null, "calendar.calendarName": null, updatedAt: now });
        throw new GoogleConnectionError("calendar_deleted", "The Study Lamp calendar was deleted in Google.");
      }
      throw error;
    }
  }

  const saved = await ref.get();
  return calendarConnectionFrom(saved.id, saved.data()!);
}

/** Records that a Calendar check/apply ran. Only called from the apply step, never from a preview. */
export async function touchCalendarLastCheck(uid: string, connectionId: string): Promise<void> {
  await googleConnectionsRef(uid).doc(connectionId).update({ "calendar.lastCheckAt": admin.firestore.FieldValue.serverTimestamp() });
}

export async function getGoogleSyncStatus(uid: string, requestedConnectionId?: string | null): Promise<GoogleSyncStatus> {
  let connection: GoogleCalendarConnection | null = null;
  try {
    connection = await getGoogleCalendarConnection(uid, await resolveCalendarConnectionId(uid, requestedConnectionId));
  } catch (error) {
    if (!(error instanceof GoogleConnectionError)) throw error;
  }
  // Counts come from our own mapping and goal docs only: no Google call, no write.
  let counts: GoogleSyncCounts = { ...DEFAULT_COUNTS };
  if (connection?.enabled && connection.calendarId) {
    const [mappings, goalSnap] = await Promise.all([
      listGoalSyncMappings(uid),
      adminDb.collection("users").doc(uid).collection("goals").select("targetDate").get(),
    ]);
    counts = computeSyncCounts({
      mappings,
      goals: goalSnap.docs.map((doc) => ({ id: doc.id, targetDate: typeof doc.data().targetDate === "string" ? doc.data().targetDate : null })),
      calendarId: connection.calendarId,
    });
  }
  return {
    enabled: Boolean(connection?.enabled),
    connectionId: connection?.id ?? null,
    calendarName: connection?.calendarName ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    counts,
  };
}
