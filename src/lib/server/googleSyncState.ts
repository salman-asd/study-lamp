import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  hashSyncBase,
  parseGoalSyncMapping,
  type CalendarMapping,
  type GoalSyncMapping,
} from "@/lib/server/googleSyncMapping";

/**
 * Goal <-> Google mapping storage: ONE doc per goal at users/{uid}/googleSync/{goalId}
 * (matches the `googleSync/{mappingId}` rule in firestore.rules: server-only).
 *
 * { titleSnapshot, calendar: { connectionId, calendarId, eventId, remoteEtag,
 *   base: {title, targetDate, completed}, hash, status, lastSyncAt, lastErrorCode } }
 *
 * Reads are free to use anywhere. Writes belong ONLY to the apply step (or the
 * documented "converged" bookkeeping there). A preview must never call them.
 */

function googleSyncRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleSync");
}

export async function listGoalSyncMappings(uid: string): Promise<Map<string, GoalSyncMapping>> {
  const snap = await googleSyncRef(uid).get();
  const result = new Map<string, GoalSyncMapping>();
  for (const doc of snap.docs) {
    const mapping = parseGoalSyncMapping(doc.id, doc.data());
    if (mapping) result.set(doc.id, mapping);
  }
  return result;
}

export interface SaveCalendarMappingInput {
  titleSnapshot: string;
  calendar: Omit<CalendarMapping, "hash" | "lastSyncAt" | "lastErrorCode" | "status"> & { status?: CalendarMapping["status"] };
}

/** Writes the whole `calendar` block (and the title snapshot) for one goal. Own mapping doc only. */
export async function saveCalendarMapping(uid: string, goalId: string, input: SaveCalendarMappingInput): Promise<void> {
  const { calendar } = input;
  await googleSyncRef(uid).doc(goalId).set({
    titleSnapshot: input.titleSnapshot.slice(0, 500),
    calendar: {
      connectionId: calendar.connectionId,
      calendarId: calendar.calendarId,
      eventId: calendar.eventId,
      remoteEtag: calendar.remoteEtag,
      base: calendar.base,
      hash: calendar.base ? hashSyncBase(calendar.base) : null,
      status: calendar.status ?? "synced",
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastErrorCode: null,
    },
  }, { merge: true });
}

/** Records a failure code on an EXISTING mapping. Never creates a mapping. */
export async function recordCalendarMappingError(uid: string, goalId: string, code: string): Promise<void> {
  const ref = googleSyncRef(uid).doc(goalId);
  const snap = await ref.get();
  if (!snap.exists || !snap.data()?.calendar) return;
  await ref.update({ "calendar.status": "failed", "calendar.lastErrorCode": code.slice(0, 60) });
}

export async function removeGoalSyncMapping(uid: string, goalId: string): Promise<void> {
  await googleSyncRef(uid).doc(goalId).delete();
}
