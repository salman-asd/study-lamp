import { adminDb } from "@/lib/server/firebase-admin";
import {
  getAccessTokenForConnection,
  getGoogleCalendarConnection,
  getGoogleTasksConnection,
  resolveCalendarConnectionId,
  resolveTasksConnectionId,
} from "@/lib/server/googleConnections";
import { createCalendarClient } from "@/lib/server/googleCalendar";
import { createTasksClient } from "@/lib/server/googleTasks";
import { listGoalSyncMappings, removeMappingBlock } from "@/lib/server/googleSyncState";
import { listSyncLog, saveSyncLogEntry } from "@/lib/server/googleSyncLog";
import { markTokenUsed, pruneUsedTokens } from "@/lib/server/googleUsedTokens";
import {
  applyRemoval,
  deleteCalendarEventIdempotent,
  deleteTaskIdempotent,
  planRemoval,
  type RemovalReader,
  type RemovalSelection,
} from "@/lib/server/googleSyncRemoval";
import type { RemovalRouteDeps, RemovalSelectionInput, SyncHistoryDeps } from "@/lib/server/syncRemovalHandlers";

/** The real (Firestore + Google) dependencies of the W5 routes. Admin SDK only. Tests use fakes instead. */

function readerFor(uid: string): RemovalReader {
  return {
    listMappings: () => listGoalSyncMappings(uid),
    async listGoalIds() {
      return (await adminDb.collection("users").doc(uid).collection("goals").select().get()).docs.map((doc) => doc.id);
    },
  };
}

/**
 * The stored calendar / task list of ONE connection. Removal is allowed even when sync is switched off (the user may
 * want to clean up first). Returns null when nothing was ever created, so there is nothing to remove.
 */
async function resolveSelection(uid: string, input: RemovalSelectionInput): Promise<RemovalSelection | null> {
  if (input.target === "calendar") {
    const connectionId = await resolveCalendarConnectionId(uid, input.connectionId);
    const connection = await getGoogleCalendarConnection(uid, connectionId);
    return connection?.calendarId ? { ...input, connectionId, containerId: connection.calendarId } : null;
  }
  const connectionId = await resolveTasksConnectionId(uid, input.connectionId);
  const connection = await getGoogleTasksConnection(uid, connectionId);
  return connection?.listId ? { ...input, connectionId, containerId: connection.listId } : null;
}

export const realRemovalRouteDeps: RemovalRouteDeps = {
  /** PREVIEW. Zero writes and no Google call: only our own mapping and goal docs are read. */
  async preview(uid, input) {
    const selection = await resolveSelection(uid, input);
    if (!selection) return { planToken: "", count: 0, orphans: 0, remaining: 0, items: [] };
    return planRemoval(readerFor(uid), { uid, ...selection });
  },

  async apply(uid, input, request) {
    const selection = await resolveSelection(uid, input);
    if (!selection) return { results: [] };
    const accessToken = await getAccessTokenForConnection(uid, selection.connectionId, selection.target);
    const calendarClient = selection.target === "calendar" ? createCalendarClient(accessToken) : null;
    const tasksClient = selection.target === "tasks" ? createTasksClient(accessToken) : null;

    return applyRemoval(
      {
        ...readerFor(uid),
        uid,
        selection,
        deleteRemote: (remoteId) =>
          calendarClient
            ? deleteCalendarEventIdempotent(calendarClient, selection.containerId, remoteId)
            : deleteTaskIdempotent(tasksClient!, selection.containerId, remoteId),
        removeMapping: (goalId, block) => removeMappingBlock(uid, goalId, block),
        log: (entry) => saveSyncLogEntry(uid, entry),
        claimToken: markTokenUsed,
      },
      request,
    );
  },

  pruneUsedTokens: (uid) => pruneUsedTokens(uid),
};

export const realSyncHistoryDeps: SyncHistoryDeps = {
  list: (uid, cursor, limit) => listSyncLog(uid, cursor, limit),
};
