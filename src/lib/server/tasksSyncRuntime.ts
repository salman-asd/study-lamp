import { adminDb } from "@/lib/server/firebase-admin";
import { getAccessTokenForConnection, getGoogleTasksConnection, resolveTasksConnectionId, touchTasksLastCheck } from "@/lib/server/googleConnections";
import { createTasksClient } from "@/lib/server/googleTasks";
import { listGoalSyncMappings, beginTasksCreate, recordTasksMappingError, saveTasksMapping } from "@/lib/server/googleSyncState";
import { saveSyncLogEntry } from "@/lib/server/googleSyncLog";
import { deleteGoalWithTasksMapping, pullTaskGoalFieldsAtomic } from "@/lib/server/tasksSyncStore";
import { applyTasksSync, type ApplyTasksSyncInput, type TasksApplyDeps } from "@/lib/server/tasksSyncApply";
import { planTasksSync, type LiveTask, type TasksPlanReader } from "@/lib/server/tasksSyncPlan";
import type { Goal } from "@/types";

/** Server wiring for the Tasks routes (Admin SDK only). Keeps the route files short and the logic testable. */

export interface ResolvedTasksTarget {
  connectionId: string;
  listId: string;
  client: ReturnType<typeof createTasksClient>;
}

/** Null when Tasks sync is not enabled for the connection. Throws GoogleConnectionError for a missing/ambiguous connection. */
export async function resolveTasksTarget(uid: string, requestedConnectionId: string | null): Promise<ResolvedTasksTarget | null> {
  const connectionId = await resolveTasksConnectionId(uid, requestedConnectionId);
  const connection = await getGoogleTasksConnection(uid, connectionId);
  if (!connection?.enabled || !connection.listId) return null;
  const client = createTasksClient(await getAccessTokenForConnection(uid, connectionId, "tasks"));
  return { connectionId, listId: connection.listId, client };
}

function readerFor(uid: string, target: ResolvedTasksTarget): TasksPlanReader {
  return {
    async listGoals() {
      const snapshot = await adminDb.collection("users").doc(uid).collection("goals").get();
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Goal);
    },
    listMappings: () => listGoalSyncMappings(uid),
    async listLiveTasks() {
      const listed = await target.client.listTasks(target.listId);
      const tasks = listed.items.filter((task): task is LiveTask => typeof task.id === "string" && task.id.length > 0);
      return { tasks, truncated: listed.truncated };
    },
  };
}

/** PREVIEW. ZERO writes: only reads goals, mapping docs and live tasks. */
export async function previewTasksPlan(uid: string, target: ResolvedTasksTarget, goalIds: string[]) {
  const plan = await planTasksSync(readerFor(uid, target), { uid, listId: target.listId, goalIds });
  return { planToken: plan.planToken, items: plan.items, counts: plan.counts, orphans: plan.orphans, remaining: plan.remaining };
}

export async function runTasksApply(uid: string, target: ResolvedTasksTarget, input: ApplyTasksSyncInput) {
  const { connectionId, listId, client } = target;
  const deps: TasksApplyDeps = {
    ...readerFor(uid, target),
    uid,
    connectionId,
    listId,
    client,
    beginCreate: (goalId, titleSnapshot) => beginTasksCreate(uid, goalId, { connectionId, listId, titleSnapshot }),
    saveMapping: (goalId, m) => saveTasksMapping(uid, goalId, { titleSnapshot: m.titleSnapshot, tasks: { connectionId, listId, taskId: m.taskId, remoteEtag: m.remoteEtag, base: m.base, notesHash: m.notesHash, status: m.status } }),
    recordError: (goalId, code) => recordTasksMappingError(uid, goalId, code),
    pullGoalFields: (goalId, expected, updates, m) => pullTaskGoalFieldsAtomic(uid, goalId, expected, updates, { connectionId, listId, ...m }),
    deleteGoal: (goalId, expected) => deleteGoalWithTasksMapping(uid, goalId, expected),
    log: (entry) => saveSyncLogEntry(uid, entry),
  };
  const result = await applyTasksSync(deps, input);
  if (result.results.some((r) => r.status === "applied")) await touchTasksLastCheck(uid, connectionId).catch(() => undefined);
  return result;
}
