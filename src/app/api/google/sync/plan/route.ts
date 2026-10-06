import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { getAccessTokenForConnection, getGoogleCalendarConnection, resolveCalendarConnectionId } from "@/lib/server/googleConnections";
import { planCalendarSync, type CalendarPlanReader, type LiveCalendarEvent } from "@/lib/server/goalSyncPlan";
import { listGoalSyncMappings } from "@/lib/server/googleSyncState";
import { listIgnoredRemoteIds } from "@/lib/server/googleIgnored";
import { createCalendarClient } from "@/lib/server/googleCalendar";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import type { Goal } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EMPTY_PLAN = {
  planToken: "",
  items: [],
  counts: { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0, orphaned: 0 },
  orphans: [],
  remaining: 0,
};

/**
 * PREVIEW. Performs ZERO writes: no Google write, no goal write, no Firestore mapping or sync-state write
 * (Global Rule 15). It only reads goals, mapping docs and live Calendar events.
 */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const goalIds = Array.isArray(body.goalIds) ? body.goalIds.filter((value): value is string => typeof value === "string") : [];
  const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;

  if (goalIds.length > 25) {
    return NextResponse.json({ error: "goalIds must contain at most 25 items." }, { status: 400 });
  }

  try {
    const connectionId = await resolveCalendarConnectionId(uid, requestedConnectionId);
    const connection = await getGoogleCalendarConnection(uid, connectionId);
    if (!connection?.enabled || !connection.calendarId) return NextResponse.json(EMPTY_PLAN);

    const calendarId = connection.calendarId;
    const accessToken = await getAccessTokenForConnection(uid, connectionId, "calendar");
    const client = createCalendarClient(accessToken);

    const reader: CalendarPlanReader = {
      async listGoals() {
        const snapshot = await adminDb.collection("users").doc(uid).collection("goals").get();
        return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Goal);
      },
      listMappings: () => listGoalSyncMappings(uid),
      listIgnoredRemoteIds: () => listIgnoredRemoteIds(uid, "calendar"),
      async listLiveEvents() {
        const listed = await client.listEvents(calendarId, { showDeleted: true });
        const events = listed.items.filter((event): event is LiveCalendarEvent => typeof event.id === "string" && event.id.length > 0);
        return { events, truncated: listed.truncated };
      },
    };

    const plan = await planCalendarSync(reader, { uid, calendarId, goalIds });
    return NextResponse.json({ planToken: plan.planToken, items: plan.items, counts: plan.counts, orphans: plan.orphans, remaining: plan.remaining });
  } catch (error) {
    return syncErrorResponse("google sync plan", error);
  }
}, { scope: "googleSync", preset: "googleSync", limit: 30, tooManyMessage: "Too many sync checks. Please slow down." });
