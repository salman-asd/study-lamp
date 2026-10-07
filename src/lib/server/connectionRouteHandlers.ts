import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isPlausibleConnectionId } from "@/lib/server/googleConnections";
import { readJsonObject } from "@/lib/server/routeHelpers";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";

/**
 * Handler bodies for /api/google/connections and /api/google/connections/[id]. The route files wrap them in
 * withAuthedRoute (auth + rate limit) and pass the real dependencies, so every branch can be tested with fakes.
 * `id` is the REAL connection doc id the OAuth callback created.
 */

export interface ConnectionRouteDeps {
  list(uid: string): Promise<unknown[]>;
  /** Null when the connection does not exist. */
  getCalendar(uid: string, id: string): Promise<unknown | null>;
  setCalendarEnabled(uid: string, id: string, enabled: boolean): Promise<unknown>;
  setTasksEnabled(uid: string, id: string, enabled: boolean): Promise<unknown>;
  /** False when there was nothing to delete. */
  remove(uid: string, id: string): Promise<boolean>;
}

type Ctx = { uid: string; req: NextRequest; params: { id: string } };

export function createConnectionRouteHandlers(deps: ConnectionRouteDeps) {
  return {
    async list({ uid }: { uid: string }): Promise<Response> {
      const connections = await deps.list(uid);
      return NextResponse.json({ connections });
    },

    async get({ uid, params }: Ctx): Promise<Response> {
      if (!isPlausibleConnectionId(params.id)) {
        return NextResponse.json({ error: "Invalid Google connection id." }, { status: 400 });
      }
      try {
        const connection = await deps.getCalendar(uid, params.id);
        if (!connection) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
        return NextResponse.json({ connection });
      } catch (error) {
        return syncErrorResponse("google connection read", error);
      }
    },

    async patch({ uid, req, params }: Ctx): Promise<Response> {
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
        const connection = calendarEnabled === undefined ? undefined : await deps.setCalendarEnabled(uid, params.id, calendarEnabled);
        const tasks = tasksEnabled === undefined ? undefined : await deps.setTasksEnabled(uid, params.id, tasksEnabled);
        return NextResponse.json({ ok: true, ...(connection ? { connection } : {}), ...(tasks ? { tasks } : {}) });
      } catch (error) {
        return syncErrorResponse("google sync toggle", error);
      }
    },

    async remove({ uid, params }: Ctx): Promise<Response> {
      // Any stored connection id is valid here. Deleting only removes Study Lamp's stored token (and best-effort
      // revokes it at Google); remote events and tasks are never touched.
      const deleted = await deps.remove(uid, params.id);
      if (!deleted) return NextResponse.json({ error: "Connection not found." }, { status: 404 });
      return NextResponse.json({ ok: true });
    },
  };
}
