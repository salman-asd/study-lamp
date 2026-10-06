import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { buildCalendarMappingDoc, mappingDocRef } from "@/lib/server/googleSyncState";
import type { SyncBase } from "@/lib/server/googleSyncMapping";

/**
 * Goal writes made by the Calendar APPLY step. ADMIN SDK ONLY (Rule 3).
 *
 * The Admin SDK bypasses firestore.rules, so everything that could come from Google is validated by the caller
 * (see validateGoalFieldPull in goalSyncApply.ts) BEFORE it reaches these functions. Each function writes the goal
 * change and its mapping doc together (one transaction or one batch), so a goal can never change without its
 * mapping "base" moving with it, and an imported goal can never exist without the mapping that links it.
 *
 * Nothing here is reachable from a preview: only goalSyncApply's writers call it, and only through the gate.
 */

export type GoalWriteResult = "ok" | "changed" | "missing";

export interface GoalExpectation {
  title: string;
  targetDate: string | null;
}

export interface MappingWrite {
  connectionId: string;
  calendarId: string;
  eventId: string;
  remoteEtag: string | null;
  titleSnapshot: string;
  base: SyncBase | null;
}

function goalsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("goals");
}

function mappingInput(mapping: MappingWrite) {
  return {
    titleSnapshot: mapping.titleSnapshot,
    calendar: {
      connectionId: mapping.connectionId,
      calendarId: mapping.calendarId,
      eventId: mapping.eventId,
      remoteEtag: mapping.remoteEtag,
      base: mapping.base,
    },
  };
}

/**
 * Updates ONLY the given fields of a goal, and only if title and targetDate still equal what the apply step
 * just read (otherwise the user edited the goal in between: nothing is written and "changed" is returned).
 * The mapping base moves in the same transaction.
 */
export async function pullGoalFieldsAtomic(
  uid: string,
  goalId: string,
  expected: GoalExpectation,
  updates: { title?: string; targetDate?: string },
  mapping: MappingWrite,
): Promise<GoalWriteResult> {
  const goalRef = goalsRef(uid).doc(goalId);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(goalRef);
    if (!snap.exists) return "missing" as const;
    const current = snap.data() ?? {};
    const currentTitle = typeof current.title === "string" ? current.title : "";
    const currentDate = typeof current.targetDate === "string" ? current.targetDate : null;
    if (currentTitle !== expected.title || currentDate !== expected.targetDate) return "changed" as const;

    tx.update(goalRef, { ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(mappingDocRef(uid, goalId), buildCalendarMappingDoc(mappingInput(mapping)), { merge: true });
    return "ok" as const;
  });
}

/** Creates a new goal from a Calendar event together with the mapping that links it (one batch). */
export async function createGoalWithMapping(
  uid: string,
  input: { title: string; targetDate: string; mapping: Omit<MappingWrite, "titleSnapshot"> },
): Promise<{ goalId: string }> {
  const goalRef = goalsRef(uid).doc();
  const batch = adminDb.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Same shape the client's addGoal writes, so every goals-page feature keeps working for imported goals.
  batch.set(goalRef, {
    title: input.title,
    notes: "",
    targetDate: input.targetDate,
    priority: null,
    linkedPlaylists: [],
    linkedVideos: [],
    completed: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(mappingDocRef(uid, goalRef.id), buildCalendarMappingDoc(mappingInput({ ...input.mapping, titleSnapshot: input.title })), { merge: true });
  await batch.commit();
  return { goalId: goalRef.id };
}

/** Deletes a goal and its mapping (the user's explicit "Delete the goal here"), only if the goal is unchanged. */
export async function deleteGoalWithMapping(uid: string, goalId: string, expected: GoalExpectation): Promise<GoalWriteResult> {
  const goalRef = goalsRef(uid).doc(goalId);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(goalRef);
    if (!snap.exists) return "missing" as const;
    const current = snap.data() ?? {};
    const currentTitle = typeof current.title === "string" ? current.title : "";
    const currentDate = typeof current.targetDate === "string" ? current.targetDate : null;
    if (currentTitle !== expected.title || currentDate !== expected.targetDate) return "changed" as const;

    tx.delete(goalRef);
    tx.delete(mappingDocRef(uid, goalId));
    return "ok" as const;
  });
}
