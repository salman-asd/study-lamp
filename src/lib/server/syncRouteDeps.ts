import { adminDb } from "@/lib/server/firebase-admin";
import {
  getAccessTokenForConnection,
  getGoogleCalendarConnection,
  getGoogleSyncStatus,
  getGoogleTasksStatus,
  resolveCalendarConnectionId,
  touchCalendarLastCheck,
} from "@/lib/server/googleConnections";
import { applyCalendarSync, type CalendarApplyDeps } from "@/lib/server/goalSyncApply";
import { planCalendarSync, type CalendarPlanReader, type LiveCalendarEvent } from "@/lib/server/goalSyncPlan";
import { listGoalSyncMappings, recordCalendarMappingError, saveCalendarMapping } from "@/lib/server/googleSyncState";
import { createGoalWithMapping, deleteGoalWithMapping, pullGoalFieldsAtomic } from "@/lib/server/goalSyncStore";
import { ignoreRemote, listIgnoredRemoteIds } from "@/lib/server/googleIgnored";
import { saveSyncLogEntry } from "@/lib/server/googleSyncLog";
import { pruneUsedTokens } from "@/lib/server/googleUsedTokens";
import { previewTasksPlan, resolveTasksTarget, runTasksApply } from "@/lib/server/tasksSyncRuntime";
import { createCalendarClient } from "@/lib/server/googleCalendar";
import { EMPTY_CALENDAR_PLAN, type SyncApplyDeps, type SyncPlanDeps, type SyncStatusDeps } from "@/lib/server/syncRouteHandlers";
import type { Goal } from "@/types";

/** The real (Firestore + Google) dependencies of the sync routes. Admin SDK only. Tests use fakes instead. */

async function listGoalsFor(uid: string): Promise<Goal[]> {
  const snapshot = await adminDb.collection("users").doc(uid).collection("goals").get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Goal);
}

function liveEventsFor(client: ReturnType<typeof createCalendarClient>, calendarId: string) {
  return async () => {
    const listed = await client.listEvents(calendarId, { showDeleted: true });
    const events = listed.items.filter((event): event is LiveCalendarEvent => typeof event.id === "string" && event.id.length > 0);
    return { events, truncated: listed.truncated };
  };
}

export const realSyncPlanDeps: SyncPlanDeps = {
  /** PREVIEW. Performs ZERO writes (Global Rule 15): only reads goals, mapping docs and live Calendar events. */
  async planCalendar(uid, requestedConnectionId, goalIds) {
    const connectionId = await resolveCalendarConnectionId(uid, requestedConnectionId);
    const connection = await getGoogleCalendarConnection(uid, connectionId);
    if (!connection?.enabled || !connection.calendarId) return EMPTY_CALENDAR_PLAN;
    const calendarId = connection.calendarId;
    const client = createCalendarClient(await getAccessTokenForConnection(uid, connectionId, "calendar"));
    const reader: CalendarPlanReader = {
      listGoals: () => listGoalsFor(uid),
      listMappings: () => listGoalSyncMappings(uid),
      listIgnoredRemoteIds: () => listIgnoredRemoteIds(uid, "calendar"),
      listLiveEvents: liveEventsFor(client, calendarId),
    };
    const plan = await planCalendarSync(reader, { uid, calendarId, goalIds });
    return { planToken: plan.planToken, items: plan.items, counts: plan.counts, orphans: plan.orphans, remaining: plan.remaining };
  },
  async planTasks(uid, requestedConnectionId, goalIds) {
    const target = await resolveTasksTarget(uid, requestedConnectionId);
    return target ? previewTasksPlan(uid, target, goalIds) : null;
  },
};

export const realSyncApplyDeps: SyncApplyDeps = {
  async applyCalendar(uid, requestedConnectionId, input) {
    const connectionId = await resolveCalendarConnectionId(uid, requestedConnectionId);
    const connection = await getGoogleCalendarConnection(uid, connectionId);
    if (!connection?.enabled || !connection.calendarId) return null;

    const calendarId = connection.calendarId;
    const client = createCalendarClient(await getAccessTokenForConnection(uid, connectionId, "calendar"));

    const deps: CalendarApplyDeps = {
      uid,
      connectionId,
      calendarId,
      client,
      listGoals: () => listGoalsFor(uid),
      listMappings: () => listGoalSyncMappings(uid),
      listIgnoredRemoteIds: () => listIgnoredRemoteIds(uid, "calendar"),
      listLiveEvents: liveEventsFor(client, calendarId),
      saveMapping: (goalId, mapping) =>
        saveCalendarMapping(uid, goalId, {
          titleSnapshot: mapping.titleSnapshot,
          calendar: { connectionId, calendarId, eventId: mapping.eventId, remoteEtag: mapping.remoteEtag, base: mapping.base, status: mapping.status },
        }),
      recordError: (goalId, code) => recordCalendarMappingError(uid, goalId, code),
      pullGoalFields: (goalId, expected, updates, mapping) =>
        pullGoalFieldsAtomic(uid, goalId, expected, updates, { connectionId, calendarId, ...mapping }),
      createGoalFromEvent: (created) =>
        createGoalWithMapping(uid, {
          title: created.title,
          targetDate: created.targetDate,
          mapping: {
            connectionId,
            calendarId,
            eventId: created.eventId,
            remoteEtag: created.remoteEtag,
            base: { title: created.title, targetDate: created.targetDate, completed: false },
          },
        }),
      deleteGoal: (goalId, expected) => deleteGoalWithMapping(uid, goalId, expected),
      ignoreRemote: (remoteId) => ignoreRemote(uid, "calendar", remoteId),
      log: (entry) => saveSyncLogEntry(uid, entry),
    };

    const outcome = await applyCalendarSync(deps, input);
    if (outcome.results.some((result) => result.status === "applied")) {
      await touchCalendarLastCheck(uid, connectionId).catch(() => undefined);
    }
    return outcome;
  },
  async applyTasks(uid, requestedConnectionId, input) {
    const target = await resolveTasksTarget(uid, requestedConnectionId);
    if (!target) return null;
    return runTasksApply(uid, target, input);
  },
  pruneUsedTokens: (uid) => pruneUsedTokens(uid),
};

export const realSyncStatusDeps: SyncStatusDeps = {
  calendarStatus: (uid, connectionId) => getGoogleSyncStatus(uid, connectionId),
  tasksStatus: (uid, connectionId) => getGoogleTasksStatus(uid, connectionId),
};
