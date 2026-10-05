import { NextResponse } from "next/server";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { deleteGoogleConnection, getGoogleCalendarConnection, setGoogleCalendarEnabled } from "@/lib/server/googleConnections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

export const GET = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  if (params.id !== "calendar") {
    return NextResponse.json({ error: "Unsupported Google connection id." }, { status: 400 });
  }

  const connection = await getGoogleCalendarConnection(uid, params.id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found." }, { status: 404 });
  }

  return NextResponse.json({ connection });
}, { scope: "googleSync", preset: "googleSync", limit: 20, tooManyMessage: "Too many connection reads. Please slow down." });

export const PATCH = withAuthedRoute<RouteParams["params"]>(async ({ uid, req, params }) => {
  if (params.id !== "calendar") {
    return NextResponse.json({ error: "Unsupported Google connection id." }, { status: 400 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const calendarBlock = parsed.body.calendar;
  const enabled = Boolean(
    calendarBlock && typeof calendarBlock === "object" &&
    typeof (calendarBlock as { enabled?: boolean }).enabled === "boolean"
      ? (calendarBlock as { enabled: boolean }).enabled
      : false,
  );

  try {
    const connection = await setGoogleCalendarEnabled(uid, enabled, params.id);
    return NextResponse.json({ ok: true, connection });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update the Google Calendar connection." }, { status: 500 });
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
