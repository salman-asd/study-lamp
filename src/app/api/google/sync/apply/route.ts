import admin from "firebase-admin";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { getGoogleCalendarConnection, getAccessTokenForConnection } from "@/lib/server/googleConnections";
import { buildGoalSyncPlan } from "@/lib/server/goalSyncPlan";
import { applyGoalSyncPlan } from "@/lib/server/goalSyncApply";
import { listGoalRemoteEvents, saveGoalRemoteEvent } from "@/lib/server/googleSyncState";
import { buildCalendarEvent, buildCalendarEventId, insertGoalEvent, patchGoalEvent } from "@/lib/server/googleCalendar";
import { verifyPlanToken } from "@/lib/server/planToken";
import { withAuthedRoute, readJsonObject } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const planToken = typeof body.planToken === "string" ? body.planToken : "";
  const accepted = Array.isArray(body.accepted)
    ? body.accepted.filter((value): value is string => typeof value === "string")
    : [];
  const resolutions = body.resolutions && typeof body.resolutions === "object"
    ? body.resolutions as Record<string, "use_study_lamp" | "use_google" | "skip"> 
    : {};
  const confirmedDestructive = Array.isArray(body.confirmedDestructive)
    ? body.confirmedDestructive.filter((value): value is string => typeof value === "string")
    : [];

  if (!planToken) {
    return NextResponse.json({ error: "Missing planToken." }, { status: 400 });
  }

  try {
    verifyPlanToken(planToken, uid, "calendar");
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Invalid or expired plan token." }, { status: 401 });
  }

  if (accepted.length === 0) {
    return NextResponse.json({ error: "The sync plan was not accepted for application." }, { status: 409 });
  }

  try {
    const [snapshot, remoteEvents, connection] = await Promise.all([
      adminDb.collection("users").doc(uid).collection("goals").get(),
      listGoalRemoteEvents(uid),
      getGoogleCalendarConnection(uid, "calendar"),
    ]);

    if (!connection?.enabled || !connection.calendarId) {
      return NextResponse.json({ error: "Google Calendar sync is not enabled." }, { status: 409 });
    }

    const goals = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, any>) }));
    const basePlan = buildGoalSyncPlan({ uid, goals: goals as any, remoteEvents, scope: "calendar" });
    const goalById = new Map<string, any>(goals.map((goal) => [goal.id, goal]));
    const remoteById = new Map<string, any>(remoteEvents.map((event) => [event.remoteId, event]));
    const accessToken = await getAccessTokenForConnection(uid, "calendar", "calendar");

    const writers = Object.fromEntries(basePlan.items.map((item) => [item.itemId, async () => {
      const goalId = item.goalId ?? null;
      if (!goalId) return;

      const goal = goalById.get(goalId);
      if (!goal) return;

      const resolvedRemoteId = item.remoteId ?? buildCalendarEventId(uid, goalId);
      const eventGoal = {
        id: goalId,
        uid,
        title: String(goal.title ?? "Untitled goal"),
        targetDate: typeof goal.targetDate === "string" ? goal.targetDate : "",
        completed: Boolean(goal.completed),
      };

      if (item.kind === "push_create" || item.kind === "push_update") {
        const payload = buildCalendarEvent(eventGoal);
        const created = await insertGoalEvent(accessToken, connection.calendarId!, eventGoal);
        await saveGoalRemoteEvent(uid, goalId, {
          goalId,
          remoteId: created.id,
          title: goal.title ?? null,
          targetDate: goal.targetDate ?? null,
          status: "active",
          base: { title: goal.title ?? null, targetDate: goal.targetDate ?? null },
          etag: (created as any).etag ?? null,
        });
        return;
      }

      if (item.kind === "pull_update") {
        const remote = remoteById.get(resolvedRemoteId) ?? remoteById.get(`goal:${goalId}`);
        if (!remote) return;
        await adminDb.collection("users").doc(uid).collection("goals").doc(goalId).update({
          title: remote.title ?? goal.title,
          targetDate: remote.targetDate ?? goal.targetDate ?? null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      if (item.kind === "conflict") {
        const selected = resolutions[item.itemId] ?? "skip";
        if (selected === "use_google") {
          const remote = remoteById.get(resolvedRemoteId) ?? remoteById.get(`goal:${goalId}`);
          if (!remote) return;
          await adminDb.collection("users").doc(uid).collection("goals").doc(goalId).update({
            title: remote.title ?? goal.title,
            targetDate: remote.targetDate ?? goal.targetDate ?? null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        }
        if (selected === "use_study_lamp") {
          const payload = buildCalendarEvent(eventGoal);
          await patchGoalEvent(accessToken, connection.calendarId!, resolvedRemoteId, payload);
          await saveGoalRemoteEvent(uid, goalId, {
            goalId,
            remoteId: resolvedRemoteId,
            title: goal.title ?? null,
            targetDate: goal.targetDate ?? null,
            status: "active",
            base: { title: goal.title ?? null, targetDate: goal.targetDate ?? null },
          });
          return;
        }
        return;
      }

      if (item.kind === "remote_deleted") {
        const selected = resolutions[item.itemId] ?? "skip";
        if (selected === "use_study_lamp") {
          const payload = buildCalendarEvent(eventGoal);
          await insertGoalEvent(accessToken, connection.calendarId!, eventGoal);
          await saveGoalRemoteEvent(uid, goalId, {
            goalId,
            remoteId: buildCalendarEventId(uid, goalId),
            title: goal.title ?? null,
            targetDate: goal.targetDate ?? null,
            status: "active",
            base: { title: goal.title ?? null, targetDate: goal.targetDate ?? null },
          });
        }
        return;
      }
    }]));

    const results = await applyGoalSyncPlan({
      token: planToken,
      accepted,
      resolutions,
      confirmedDestructive,
      freshPlan: basePlan.items,
      expectedUser: uid,
      expectedScope: "calendar",
      writers: writers as Record<string, (item: any) => Promise<void> | void>,
    });

    return NextResponse.json({
      ok: results.length > 0,
      results,
      applied: results.filter((result) => result.status === "applied").length,
      skipped: results.filter((result) => result.status !== "applied").length,
    });
  } catch (error) {
    return NextResponse.json({ error: "Couldn't validate the sync apply request." }, { status: 500 });
  }
});
