import { NextResponse } from "next/server";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import {
  deleteGoogleConnection,
  getGoogleCalendarConnection,
  isPlausibleConnectionId,
  setGoogleCalendarEnabled,
  setGoogleTasksEnabled,
} from "@/lib/server/googleConnections";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

// `id` is the REAL connection doc id (the one the OAuth callback created). There is no literal "calendar" id.

export const GET = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  if (!isPlausibleConnectionId(params.id)) {
    return NextResponse.json({ error: "Invalid Google connection id." }, { status: 400 });
  }

  try {
    const connection = await getGoogleCalendarConnection(uid, params.id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return NextResponse.json({ connection });
  } catch (error) {
    return syncErrorResponse("google connection read", error);
  }
}, { scope: "googleSync", preset: "googleSync", limit: 20, tooManyMessage: "Too many connection reads. Please slow down." });

export const PATCH = withAuthedRoute<RouteParams["params"]>(async ({ uid, req, params }) => {
  if (!isPlausibleConnectionId(params.id)) {
    return NextResponse.json({ error: "Invalid Google connection id." }, { status: 400 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const flag = (block: unknown): boolean | undefined => {
    const value = block && typeof block === "object" ? (block as { enabled?: unknown }).enabled : undefined;
    return typeof value === "boolean" ? value : undefined;
  };
  const calendarEnabled = flag(parsed.body.calendar);
  const tasksEnabled = flag(parsed.body.tasks);
  if (calendarEnabled === undefined && tasksEnabled === undefined) {
    // A missing flag must never be read as "turn it off".
    return NextResponse.json({ error: "calendar.enabled or tasks.enabled must be true or false." }, { status: 400 });
  }

  try {
    const connection = calendarEnabled === undefined ? undefined : await setGoogleCalendarEnabled(uid, params.id, calendarEnabled);
    const tasks = tasksEnabled === undefined ? undefined : await setGoogleTasksEnabled(uid, params.id, tasksEnabled);
    return NextResponse.json({ ok: true, ...(connection ? { connection } : {}), ...(tasks ? { tasks } : {}) });
  } catch (error) {
    return syncErrorResponse("google sync toggle", error);
  }
}, { scope: "googleSync", preset: "googleSync", limit: 20, tooManyMessage: "Too many connection updates. Please slow down." });

export const DELETE = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  // Any stored connection id is valid here. Deleting only removes Study Lamp's
  // stored token (and best-effort revokes it at Google) — remote events and
  // tasks are never touched.
  const deleted = await deleteGoogleConnection(uid, params.id);
  if (!deleted) {
    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}, { scope: "google:connections", preset: "authSensitive" });
