import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import {
  hashSyncBase,
  mappingRemovalAction,
  parseGoalSyncMapping,
  type CalendarMapping,
  type MappingBlock,
  type GoalSyncMapping,
  type TasksMapping,
  isCreatingFresh,
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

/**
 * The stored shape of a mapping doc. Pure apart from the server timestamp sentinel, and exported so
 * goalSyncStore can write a goal change and its mapping in ONE transaction/batch.
 */
export function buildCalendarMappingDoc(input: SaveCalendarMappingInput) {
  const { calendar } = input;
  return {
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
  };
}

export function mappingDocRef(uid: string, goalId: string) {
  return googleSyncRef(uid).doc(goalId);
}

/** Writes the whole `calendar` block (and the title snapshot) for one goal. Own mapping doc only. */
export async function saveCalendarMapping(uid: string, goalId: string, input: SaveCalendarMappingInput): Promise<void> {
  await googleSyncRef(uid).doc(goalId).set(buildCalendarMappingDoc(input), { merge: true });
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

// ─── Tasks block (W4) ───────────────────────────────────────────────────────
// Same doc, next to `calendar`. set(..., { merge: true }) merges nested maps, so writing `tasks` never touches `calendar`.

export interface SaveTasksMappingInput {
  titleSnapshot: string;
  tasks: Omit<TasksMapping, "hash" | "lastSyncAt" | "lastErrorCode" | "status" | "creatingAt"> & { status?: TasksMapping["status"] };
}

export function buildTasksMappingDoc(input: SaveTasksMappingInput) {
  const { tasks } = input;
  return {
    titleSnapshot: input.titleSnapshot.slice(0, 500),
    tasks: {
      connectionId: tasks.connectionId,
      listId: tasks.listId,
      taskId: tasks.taskId,
      remoteEtag: tasks.remoteEtag,
      base: tasks.base,
      notesHash: tasks.notesHash,
      hash: tasks.base ? hashSyncBase(tasks.base) : null,
      status: tasks.status ?? "synced",
      creatingAt: null,
      lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      lastErrorCode: null,
    },
  };
}

/** Writes the whole `tasks` block for one goal. Own mapping doc only; never Google, never a goal. */
export async function saveTasksMapping(uid: string, goalId: string, input: SaveTasksMappingInput): Promise<void> {
  await googleSyncRef(uid).doc(goalId).set(buildTasksMappingDoc(input), { merge: true });
}

/** Records a failure code on an EXISTING tasks mapping. A failed row is no longer "busy". Never creates a mapping. */
export async function recordTasksMappingError(uid: string, goalId: string, code: string): Promise<void> {
  const ref = googleSyncRef(uid).doc(goalId);
  const snap = await ref.get();
  if (!snap.exists || !snap.data()?.tasks) return;
  await ref.update({ "tasks.status": "failed", "tasks.lastErrorCode": code.slice(0, 60) });
}

/**
 * Two-phase create, phase 1 (inside the apply step only): in ONE transaction, claim the goal by writing a
 * "creating" row with a timestamp. A row younger than 2 minutes means another sync is mid-insert -> "busy".
 * A stale "creating" row is claimed again; the planner already adopts a task found by its notes marker.
 */
export async function beginTasksCreate(
  uid: string,
  goalId: string,
  input: { connectionId: string; listId: string; titleSnapshot: string },
  now = Date.now(),
): Promise<"claimed" | "busy"> {
  const ref = googleSyncRef(uid).doc(goalId);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? parseGoalSyncMapping(goalId, snap.data())?.tasks : null;
    if (current?.status === "creating" && isCreatingFresh(current.creatingAt, now)) return "busy" as const;
    tx.set(ref, {
      titleSnapshot: input.titleSnapshot.slice(0, 500),
      tasks: {
        connectionId: input.connectionId,
        listId: input.listId,
        taskId: null,
        remoteEtag: null,
        base: null,
        notesHash: null,
        hash: null,
        status: "creating",
        creatingAt: new Date(now).toISOString(),
        lastSyncAt: null,
        lastErrorCode: null,
      },
    }, { merge: true });
    return "claimed" as const;
  });
}

/**
 * Removes ONE service's block from a goal's mapping doc (W5), in a transaction. The other service's block stays
 * (audit M1); the doc itself is deleted only when nothing else lives in it. Own mapping doc only.
 */
export async function removeMappingBlock(uid: string, goalId: string, block: MappingBlock): Promise<void> {
  const ref = googleSyncRef(uid).doc(goalId);
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const action = mappingRemovalAction(snap.exists ? (snap.data() as { calendar?: unknown; tasks?: unknown }) : null, block);
    if (action === "delete_doc") tx.delete(ref);
    else if (action === "delete_block") tx.update(ref, { [block]: admin.firestore.FieldValue.delete() });
  });
}
