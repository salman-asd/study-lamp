import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { encryptApiKey, decryptApiKey } from "@/lib/server/aiEncryption";
import { refreshAccessToken, revokeToken } from "@/lib/server/googleDrive";
import type { DriveConnection, DriveConnectionSummary } from "@/types";

// Server-only. Mirrors src/lib/server/aiConnections.ts exactly: writes go to
// users/{uid}/driveConnections/{id} via the Admin SDK, which is the only way
// in — firestore.rules denies this subcollection to the client SDK entirely
// (see the "driveConnections" match block), so every check here is the only
// backstop, same reasoning as the AI connections module.

function connectionsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("driveConnections");
}

function toIso(value: admin.firestore.Timestamp | null | undefined): string | null {
  return value ? value.toDate().toISOString() : null;
}

function toSummary(id: string, data: FirebaseFirestore.DocumentData): DriveConnectionSummary {
  return {
    id,
    googleEmail: data.googleEmail,
    status: data.status ?? "active",
    createdAt: toIso(data.createdAt),
    lastUsedAt: toIso(data.lastUsedAt),
  };
}

export async function listDriveConnections(uid: string): Promise<DriveConnectionSummary[]> {
  const snap = await connectionsRef(uid).orderBy("createdAt", "asc").get();
  return snap.docs.map((doc) => toSummary(doc.id, doc.data()));
}

export async function getDriveConnectionSummary(uid: string, connectionId: string): Promise<DriveConnectionSummary | null> {
  const snap = await connectionsRef(uid).doc(connectionId).get();
  if (!snap.exists) return null;
  return toSummary(snap.id, snap.data()!);
}

/** Creates (or, if this Google account is already connected, replaces the
 *  refresh token on) a connection. Re-connecting the same Google account is
 *  the normal way a user fixes an "invalid" connection after revoking Study
 *  Lamp's access from their Google Account settings. */
export async function upsertDriveConnection(
  uid: string,
  input: { googleEmail: string; refreshToken: string; scope: string }
): Promise<DriveConnectionSummary> {
  const existing = await connectionsRef(uid).where("googleEmail", "==", input.googleEmail).limit(1).get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc: Omit<DriveConnection, "id"> = {
    googleEmail: input.googleEmail,
    encryptedRefreshToken: encryptApiKey(input.refreshToken),
    scope: input.scope,
    status: "active",
    createdAt: now as any,
    updatedAt: now as any,
    lastUsedAt: null,
  };

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    await ref.set({ ...doc, createdAt: existing.docs[0].data().createdAt }, { merge: true });
    const snap = await ref.get();
    return toSummary(snap.id, snap.data()!);
  }

  const ref = connectionsRef(uid).doc();
  await ref.set(doc);
  const snap = await ref.get();
  return toSummary(snap.id, snap.data()!);
}

/** Disconnects a Drive account: revokes the refresh token with Google (best
 *  effort — a failure here shouldn't block removing it from Study Lamp) and
 *  deletes the stored connection. Files already imported keep their
 *  driveFileId/driveConnectionId, so playback will start failing with a
 *  clear "reconnect this account" error rather than silently pointing at a
 *  connection that no longer exists — see the stream proxy route. */
export async function deleteDriveConnection(uid: string, connectionId: string): Promise<boolean> {
  const ref = connectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const refreshToken = decryptApiKey(snap.data()!.encryptedRefreshToken);
  await revokeToken(refreshToken);
  await ref.delete();
  return true;
}

/** Returns a fresh access token for this connection, refreshing it via
 *  Google every call (access tokens are ~1hr and we don't cache them
 *  server-side to keep this module stateless). Marks the connection
 *  "invalid" if Google rejects the refresh token (e.g. the user revoked
 *  access from their Google Account, or it expired from disuse). */
export async function getAccessTokenForConnection(uid: string, connectionId: string): Promise<string> {
  const ref = connectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) throw new DriveConnectionError("not_found", "This Google Drive connection no longer exists. Reconnect it in Settings → Google Drive.");

  const data = snap.data()!;
  if (data.status === "invalid") {
    throw new DriveConnectionError("invalid", "This Google Drive connection needs to be reconnected in Settings → Google Drive.");
  }

  const refreshToken = decryptApiKey(data.encryptedRefreshToken);
  try {
    const { accessToken } = await refreshAccessToken(refreshToken);
    await ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
    return accessToken;
  } catch (err: any) {
    if (err?.driveAuthInvalid) {
      await ref.update({ status: "invalid" });
      throw new DriveConnectionError("invalid", "This Google Drive connection needs to be reconnected in Settings → Google Drive.");
    }
    throw new DriveConnectionError("network", "Couldn't reach Google Drive. Try again in a moment.");
  }
}

export class DriveConnectionError extends Error {
  code: "not_found" | "invalid" | "network";
  constructor(code: "not_found" | "invalid" | "network", message: string) {
    super(message);
    this.code = code;
  }
}
