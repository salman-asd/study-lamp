import admin from "firebase-admin";
import type { GoalRemoteEvent } from "@/lib/server/goalSyncPlan";
import { adminDb } from "@/lib/server/firebase-admin";

export interface GoogleGoalSyncRecord {
  goalId: string;
  remoteId: string;
  title: string | null;
  targetDate: string | null;
  status: "active" | "cancelled" | "deleted" | "failed";
  base: {
    title?: string | null;
    targetDate?: string | null;
  } | null;
  etag: string | null;
  updatedAt: unknown;
}

function googleSyncGoalsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleSync").doc("goals").collection("items");
}

export async function listGoalRemoteEvents(uid: string): Promise<GoalRemoteEvent[]> {
  const snap = await googleSyncGoalsRef(uid).get();
  return snap.docs.map((doc) => {
    const data = doc.data() as Partial<GoogleGoalSyncRecord>;
    return {
      remoteId: String(data.remoteId ?? doc.id),
      title: String(data.title ?? ""),
      targetDate: data.targetDate ?? null,
      base: data.base ?? null,
      status: data.status ?? "active",
      etag: data.etag ?? null,
    };
  });
}

export async function saveGoalRemoteEvent(uid: string, goalId: string, remoteEvent: Partial<GoogleGoalSyncRecord>) {
  const ref = googleSyncGoalsRef(uid).doc(goalId);
  await ref.set({
    goalId,
    remoteId: remoteEvent.remoteId ?? goalId,
    title: remoteEvent.title ?? null,
    targetDate: remoteEvent.targetDate ?? null,
    status: remoteEvent.status ?? "active",
    base: remoteEvent.base ?? null,
    etag: remoteEvent.etag ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function removeGoalRemoteEvent(uid: string, goalId: string) {
  await googleSyncGoalsRef(uid).doc(goalId).delete().catch(() => undefined);
}
