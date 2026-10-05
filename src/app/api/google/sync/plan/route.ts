import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { getGoogleCalendarConnection, getAccessTokenForConnection } from "@/lib/server/googleConnections";
import { buildGoalSyncPlan } from "@/lib/server/goalSyncPlan";
import { listGoalRemoteEvents, saveGoalRemoteEvent } from "@/lib/server/googleSyncState";
import { eventToGoalFields, listCalendarEvents } from "@/lib/server/googleCalendar";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const goalIds = Array.isArray(body.goalIds) ? body.goalIds.filter((value): value is string => typeof value === "string") : [];

  if (goalIds.length > 25) {
    return NextResponse.json({ error: "goalIds must contain at most 25 items." }, { status: 400 });
  }

  try {
    const [snapshot, storedRemoteEvents, connection] = await Promise.all([
      adminDb.collection("users").doc(uid).collection("goals").get(),
      listGoalRemoteEvents(uid),
      getGoogleCalendarConnection(uid, "calendar"),
    ]);

    const goals = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (!connection?.enabled || !connection.calendarId) {
      return NextResponse.json({
        planToken: "",
        items: [],
        counts: { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0 },
        remaining: 0,
      });
    }

    const accessToken = await getAccessTokenForConnection(uid, "calendar", "calendar");
    const remoteList = await listCalendarEvents(accessToken, connection.calendarId, { showDeleted: true });

    const remoteEvents = await Promise.all((remoteList.items ?? [])
      .filter((event) => event.id && event.extendedProperties?.private?.studylampGoalId)
      .map(async (event) => {
        const goalId = event.extendedProperties?.private?.studylampGoalId;
        if (!goalId) return null;
        const fields = eventToGoalFields(event);
        await saveGoalRemoteEvent(uid, goalId, {
          goalId,
          remoteId: event.id ?? goalId,
          title: fields.title || event.summary || null,
          targetDate: fields.targetDate ?? null,
          status: event.status === "cancelled" ? "cancelled" : "active",
          base: { title: fields.title || (event.summary ?? null), targetDate: fields.targetDate ?? null },
          etag: (event as any).etag ?? null,
        });
        return {
          remoteId: event.id ?? goalId,
          title: fields.title || event.summary || "",
          targetDate: fields.targetDate ?? null,
          base: { title: fields.title || (event.summary ?? null), targetDate: fields.targetDate ?? null },
          status: event.status === "cancelled" ? "cancelled" : "active",
          etag: (event as any).etag ?? null,
        };
      }));

    const effectiveRemoteEvents = remoteEvents.filter(Boolean).concat(storedRemoteEvents);
    const plan = buildGoalSyncPlan({ uid, goals: goals as any, goalIds, remoteEvents: effectiveRemoteEvents as any, scope: "calendar" });
    return NextResponse.json({ planToken: plan.planToken, items: plan.items, counts: plan.counts, remaining: plan.remaining });
  } catch (error) {
    return NextResponse.json({ error: "Couldn't build the sync plan." }, { status: 500 });
  }
}, { scope: "googleSync", preset: "googleSync", limit: 30, tooManyMessage: "Too many sync checks. Please slow down." });
