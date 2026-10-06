import admin from "firebase-admin";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { getAccessTokenForConnection, getGoogleCalendarConnection, resolveCalendarConnectionId, touchCalendarLastCheck } from "@/lib/server/googleConnections";
import { applyCalendarSync, PlanAlreadyAppliedError, type CalendarApplyDeps, type SyncResolution } from "@/lib/server/goalSyncApply";
import type { LiveCalendarEvent } from "@/lib/server/goalSyncPlan";
import { listGoalSyncMappings, recordCalendarMappingError, saveCalendarMapping } from "@/lib/server/googleSyncState";
import { createCalendarClient } from "@/lib/server/googleCalendar";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";
import { PlanTokenVerificationError, verifyPlanToken } from "@/lib/server/planToken";
import { withAuthedRoute, readJsonObject } from "@/lib/server/routeHelpers";
import type { Goal } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RESOLUTIONS: readonly SyncResolution[] = ["use_study_lamp", "use_google", "skip"];

function readResolutions(value: unknown): Record<string, SyncResolution> {
  const result: Record<string, SyncResolution> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [itemId, choice] of Object.entries(value)) {
    if (typeof choice === "string" && (RESOLUTIONS as readonly string[]).includes(choice)) result[itemId] = choice as SyncResolution;
  }
  return result;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * APPLY. Verifies the plan token, re-reads CURRENT goals, mappings and LIVE Google events, recomputes the plan and
 * lets the confirmation gate decide. Content sent to Google is built on the server from stored goals; the request
 * body only says which plan items the user accepted and how they resolved conflicts.
 */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const planToken = typeof body.planToken === "string" ? body.planToken : "";
  const accepted = readStrings(body.accepted);
  const resolutions = readResolutions(body.resolutions);
  const confirmedDestructive = readStrings(body.confirmedDestructive);
  const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;

  if (!planToken) {
    return NextResponse.json({ error: "Missing planToken." }, { status: 400 });
  }

  try {
    verifyPlanToken(planToken, uid, "calendar");
  } catch (error) {
    if (error instanceof PlanTokenVerificationError) {
      return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
    }
    return syncErrorResponse("google sync apply token", error);
  }

  if (accepted.length === 0) {
    return NextResponse.json({ error: "The sync plan was not accepted for application." }, { status: 409 });
  }

  try {
    const connectionId = await resolveCalendarConnectionId(uid, requestedConnectionId);
    const connection = await getGoogleCalendarConnection(uid, connectionId);
    if (!connection?.enabled || !connection.calendarId) {
      return NextResponse.json({ error: "Google Calendar sync is not enabled." }, { status: 409 });
    }

    const calendarId = connection.calendarId;
    const accessToken = await getAccessTokenForConnection(uid, connectionId, "calendar");
    const client = createCalendarClient(accessToken);
    const goalsRef = adminDb.collection("users").doc(uid).collection("goals");

    const deps: CalendarApplyDeps = {
      uid,
      connectionId,
      calendarId,
      client,
      async listGoals() {
        const snapshot = await goalsRef.get();
        return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Goal);
      },
      listMappings: () => listGoalSyncMappings(uid),
      async listLiveEvents() {
        const listed = await client.listEvents(calendarId, { showDeleted: true });
        const events = listed.items.filter((event): event is LiveCalendarEvent => typeof event.id === "string" && event.id.length > 0);
        return { events, truncated: listed.truncated };
      },
      saveMapping: (goalId, input) =>
        saveCalendarMapping(uid, goalId, {
          titleSnapshot: input.titleSnapshot,
          calendar: { connectionId, calendarId, eventId: input.eventId, remoteEtag: input.remoteEtag, base: input.base },
        }),
      recordError: (goalId, code) => recordCalendarMappingError(uid, goalId, code),
      pullGoalFields: (goalId, expected, updates) =>
        adminDb.runTransaction(async (tx) => {
          const ref = goalsRef.doc(goalId);
          const snap = await tx.get(ref);
          if (!snap.exists) return "missing" as const;
          const current = snap.data() ?? {};
          const currentTitle = typeof current.title === "string" ? current.title : "";
          const currentDate = typeof current.targetDate === "string" ? current.targetDate : null;
          // The goal must still be exactly what apply just read; otherwise the user changed it meanwhile.
          if (currentTitle !== expected.title || currentDate !== expected.targetDate) return "changed" as const;
          tx.update(ref, { ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          return "ok" as const;
        }),
    };

    const { results } = await applyCalendarSync(deps, { planToken, accepted, resolutions, confirmedDestructive });

    if (results.some((result) => result.status === "applied")) {
      await touchCalendarLastCheck(uid, connectionId).catch(() => undefined);
    }

    const applied = results.filter((result) => result.status === "applied").length;
    const failed = results.filter((result) => result.status === "failed").length;
    return NextResponse.json({
      ok: results.length > 0 && failed === 0,
      results,
      applied,
      skipped: results.length - applied - failed,
      failed,
    });
  } catch (error) {
    if (error instanceof PlanTokenVerificationError) {
      return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
    }
    if (error instanceof PlanAlreadyAppliedError) {
      return NextResponse.json({ error: "This plan was already applied." }, { status: 409 });
    }
    return syncErrorResponse("google sync apply", error);
  }
}, { scope: "googleApply", preset: "googleApply", limit: 20, tooManyMessage: "Too many sync applies. Please slow down." });
