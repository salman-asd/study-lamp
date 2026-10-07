import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { buildTasksMappingDoc, mappingDocRef } from "@/lib/server/googleSyncState";
import { mappingRemovalAction, type SyncBase } from "@/lib/server/googleSyncMapping";
import type { GoalWriteResult } from "@/lib/server/goalSyncStore";

/**
 * Goal writes made by the Tasks APPLY step. ADMIN SDK ONLY (Rule 3). The Admin SDK bypasses firestore.rules, so the
 * caller validates everything that came from Google BEFORE it reaches these functions. Each function writes the goal
 * change and its mapping together (one transaction). Only the apply step's writers call it, and only through the gate.
 */

export interface TaskGoalExpectation {
  title: string;
  targetDate: string | null;
  completed: boolean;
}

export interface TaskGoalUpdates {
  title?: string;
  /** null clears the date (the due date was removed in Google). */
  targetDate?: string | null;
  completed?: boolean;
}

export interface TasksMappingWrite {
  connectionId: string;
  listId: string;
  taskId: string | null;
  remoteEtag: string | null;
  titleSnapshot: string;
  base: SyncBase | null;
  notesHash: string | null;
}

function goalRef(uid: string, goalId: string) {
  return adminDb.collection("users").doc(uid).collection("goals").doc(goalId);
}

function matches(current: FirebaseFirestore.DocumentData, expected: TaskGoalExpectation): boolean {
  const title = typeof current.title === "string" ? current.title : "";
  const date = typeof current.targetDate === "string" ? current.targetDate : null;
  return title === expected.title && date === expected.targetDate && Boolean(current.completed) === expected.completed;
}

/** Updates ONLY the given fields, and only if title, date and completion still equal what the apply step just read. */
export async function pullTaskGoalFieldsAtomic(
  uid: string,
  goalId: string,
  expected: TaskGoalExpectation,
  updates: TaskGoalUpdates,
  mapping: TasksMappingWrite,
): Promise<GoalWriteResult> {
  const ref = goalRef(uid, goalId);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "missing" as const;
    if (!matches(snap.data() ?? {}, expected)) return "changed" as const;

    const write: Record<string, unknown> = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (updates.title !== undefined) write.title = updates.title;
    if (updates.targetDate !== undefined) write.targetDate = updates.targetDate;
    if (updates.completed !== undefined) {
      write.completed = updates.completed;
      write.completedAt = updates.completed ? admin.firestore.FieldValue.serverTimestamp() : null;
    }
    tx.update(ref, write);
    tx.set(mappingDocRef(uid, goalId), buildTasksMappingDoc({
      titleSnapshot: mapping.titleSnapshot,
      tasks: { connectionId: mapping.connectionId, listId: mapping.listId, taskId: mapping.taskId, remoteEtag: mapping.remoteEtag, base: mapping.base, notesHash: mapping.notesHash },
    }), { merge: true });
    return "ok" as const;
  });
}

/**
 * Deletes a goal (the user's explicit, separately confirmed "Delete the goal here"), only if unchanged. The Tasks
 * block of the mapping goes with it; a Calendar block, if any, is left for the Calendar sync to report as an orphan.
 */
export async function deleteGoalWithTasksMapping(uid: string, goalId: string, expected: TaskGoalExpectation): Promise<GoalWriteResult> {
  const ref = goalRef(uid, goalId);
  const mapRef = mappingDocRef(uid, goalId);
  return adminDb.runTransaction(async (tx) => {
    const [snap, mapSnap] = await Promise.all([tx.get(ref), tx.get(mapRef)]);
    if (!snap.exists) return "missing" as const;
    if (!matches(snap.data() ?? {}, expected)) return "changed" as const;

    tx.delete(ref);
    if (mapSnap.exists) {
      if (mappingRemovalAction(mapSnap.data(), "tasks") === "delete_block") tx.update(mapRef, { tasks: admin.firestore.FieldValue.delete() });
      else tx.delete(mapRef);
    }
    return "ok" as const;
  });
}
