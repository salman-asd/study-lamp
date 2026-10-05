import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { encryptApiKey, decryptApiKey } from "@/lib/server/aiEncryption";
import { getOrCreateStudyLampCalendar, type GoogleCalendarEventLike } from "@/lib/server/googleCalendar";
import { refreshWorkspaceAccessToken, revokeGoogleToken } from "@/lib/server/googleOAuth";
import { type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";
import type { GoogleCalendarConnection, GoogleConnectionSummary, GoogleSyncCounts, GoogleSyncStatus } from "@/types";

const DEFAULT_COUNTS: GoogleSyncCounts = {
  synced: 0,
  failed: 0,
  remoteDeleted: 0,
  noDate: 0,
  orphaned: 0,
};

const accessTokenCache = new Map<string, { token: string; exp: number }>();
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

function toSummary(id: string, data: FirebaseFirestore.DocumentData): GoogleConnectionSummary {
  const grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes.filter((scope): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks") : [];
  const calendarEnabled = Boolean(data.calendar?.enabled ?? data.enabled ?? false);
  const tasksEnabled = Boolean(data.tasks?.enabled ?? false);
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
  return snap.docs.map((doc) => toSummary(doc.id, doc.data()));
}

export async function getGoogleConnectionSummary(uid: string, id: string): Promise<GoogleConnectionSummary | null> {
  const snap = await googleConnectionsRef(uid).doc(id).get();
  if (!snap.exists) return null;
  return toSummary(snap.id, snap.data()!);
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
      grantedScopes: Array.from(new Set([...(Array.isArray(previous.grantedScopes) ? previous.grantedScopes : []), ...doc.grantedScopes])),
      updatedAt: now,
    }, { merge: true });
    invalidateAccessToken(uid, ref.id);
    const snap = await ref.get();
    return toSummary(snap.id, snap.data()!);
  }

  const ref = googleConnectionsRef(uid).doc();
  await ref.set(doc);
  invalidateAccessToken(uid, ref.id);
  const snap = await ref.get();
  return toSummary(snap.id, snap.data()!);
}

export async function deleteGoogleConnection(uid: string, connectionId: string): Promise<boolean> {
  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  invalidateAccessToken(uid, connectionId);
  const refreshToken = decryptApiKey(snap.data()!.encryptedRefreshToken);
  await revokeGoogleToken(refreshToken).catch(() => undefined);
  await ref.delete();
  return true;
}

export function invalidateAccessToken(uid: string, connectionId: string): void {
  accessTokenCache.delete(cacheKey(uid, connectionId));
  lastUsedWriteAt.delete(cacheKey(uid, connectionId));
}

export class GoogleConnectionError extends Error {
  code: "not_found" | "invalid" | "network" | "scope_missing";
  constructor(code: GoogleConnectionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export async function withGoogleAccessToken<T>(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
  operation: (accessToken: string) => Promise<T>,
  tokenProvider: () => Promise<string> = () => getAccessTokenForConnection(uid, connectionId, requiredFeature),
): Promise<T> {
  const accessToken = await tokenProvider();
  try {
    return await operation(accessToken);
  } catch (error) {
    if (error instanceof GoogleConnectionError) throw error;
    throw error;
  } finally {
    invalidateAccessToken(uid, connectionId);
  }
}

export async function getAccessTokenForConnection(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
): Promise<string> {
  const key = cacheKey(uid, connectionId);
  const cached = accessTokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;

  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");

  const data = snap.data()!;
  const grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes.filter((scope): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks") : [];
  if (!grantedScopes.includes(requiredFeature)) {
    throw new GoogleConnectionError("scope_missing", `This Google connection does not have ${requiredFeature} access enabled.`);
  }

  const refreshToken = decryptApiKey(data.encryptedRefreshToken);
  try {
    const response = await refreshWorkspaceAccessToken(refreshToken);
    const exp = Date.now() + Math.max(0, response.expiresIn) * 1000;
    accessTokenCache.set(key, { token: response.accessToken, exp });

    const lastWrittenAt = lastUsedWriteAt.get(key) ?? 0;
    const now = Date.now();
    if (now - lastWrittenAt >= LAST_USED_WRITE_INTERVAL_MS) {
      try {
        await ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
        lastUsedWriteAt.set(key, now);
      } catch {
        // Ignore metadata failures; the access token still works.
      }
    }

    return response.accessToken;
  } catch (error: any) {
    if (error?.googleAuthInvalid) {
      invalidateAccessToken(uid, connectionId);
      await ref.update({ status: "invalid", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      throw new GoogleConnectionError("invalid", "This Google connection needs to be reconnected.");
    }
    throw new GoogleConnectionError("network", "Couldn't reach Google. Please try again shortly.");
  }
}

export async function getGoogleCalendarConnection(uid: string, id = "calendar"): Promise<GoogleCalendarConnection | null> {
  const snap = await googleConnectionsRef(uid).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    id: snap.id,
    enabled: Boolean(data.calendar?.enabled ?? data.enabled ?? false),
    calendarId: data.calendarId ?? null,
    calendarName: data.calendarName ?? null,
    lastSyncAt: toIso(data.lastSyncAt ?? null),
    counts: {
      synced: Number(data.counts?.synced ?? 0),
      failed: Number(data.counts?.failed ?? 0),
      remoteDeleted: Number(data.counts?.remoteDeleted ?? 0),
      noDate: Number(data.counts?.noDate ?? 0),
      orphaned: Number(data.counts?.orphaned ?? 0),
    },
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

export async function setGoogleCalendarEnabled(uid: string, enabled: boolean, id = "calendar"): Promise<GoogleCalendarConnection> {
  const ref = googleConnectionsRef(uid).doc(id);
  const snap = await ref.get();
  if (!snap.exists && enabled) {
    throw new GoogleConnectionError("not_found", "This Google connection is not configured yet.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const previous = snap.exists ? snap.data()! : null;

  if (enabled) {
    const accessToken = await getAccessTokenForConnection(uid, id, "calendar");
    const calendar = await getOrCreateStudyLampCalendar(accessToken, "Study Lamp goals");
    const next = {
      calendar: { enabled: true },
      enabled: true,
      calendarId: calendar.id,
      calendarName: calendar.summary || "Study Lamp goals",
      updatedAt: now as any,
      counts: previous?.counts ?? DEFAULT_COUNTS,
      createdAt: previous?.createdAt ?? now,
    };

    await ref.set(next, { merge: true });
    const saved = await ref.get();
    const data = saved.data()!;
    return {
      id: saved.id,
      enabled: Boolean(data.calendar?.enabled ?? data.enabled ?? false),
      calendarId: data.calendarId ?? null,
      calendarName: data.calendarName ?? null,
      lastSyncAt: toIso(data.lastSyncAt ?? null),
      counts: {
        synced: Number(data.counts?.synced ?? 0),
        failed: Number(data.counts?.failed ?? 0),
        remoteDeleted: Number(data.counts?.remoteDeleted ?? 0),
        noDate: Number(data.counts?.noDate ?? 0),
        orphaned: Number(data.counts?.orphaned ?? 0),
      },
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  }

  const next = {
    calendar: { enabled: false },
    enabled: false,
    updatedAt: now as any,
    counts: previous?.counts ?? DEFAULT_COUNTS,
    createdAt: previous?.createdAt ?? now,
  };

  await ref.set(next, { merge: true });
  const saved = await ref.get();
  const data = saved.data()!;
  return {
    id: saved.id,
    enabled: Boolean(data.calendar?.enabled ?? data.enabled ?? false),
    calendarId: data.calendarId ?? null,
    calendarName: data.calendarName ?? null,
    lastSyncAt: toIso(data.lastSyncAt ?? null),
    counts: {
      synced: Number(data.counts?.synced ?? 0),
      failed: Number(data.counts?.failed ?? 0),
      remoteDeleted: Number(data.counts?.remoteDeleted ?? 0),
      noDate: Number(data.counts?.noDate ?? 0),
      orphaned: Number(data.counts?.orphaned ?? 0),
    },
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

export async function getGoogleSyncStatus(uid: string): Promise<GoogleSyncStatus> {
  const connection = await getGoogleCalendarConnection(uid, "calendar");
  return {
    enabled: Boolean(connection?.enabled),
    calendarName: connection?.calendarName ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    counts: connection?.counts ?? DEFAULT_COUNTS,
  };
}
