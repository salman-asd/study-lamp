import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { createAuthedRoute } from "./routeHelpers";
import { GoogleConnectionError } from "./googleConnections";
import { createConnectionRouteHandlers, type ConnectionRouteDeps } from "./connectionRouteHandlers";

const signedIn = async () => "user-1";
const signedOut = async () => null;

function fakes(overrides: Partial<ConnectionRouteDeps> = {}) {
  const calls: string[] = [];
  const deps: ConnectionRouteDeps = {
    async list() { calls.push("list"); return [{ id: "c1" }]; },
    async getCalendar(_u, id) { calls.push(`get:${id}`); return id === "c1" ? { id } : null; },
    async setCalendarEnabled(_u, id, on) { calls.push(`cal:${id}:${on}`); return { id, enabled: on }; },
    async setTasksEnabled(_u, id, on) { calls.push(`tasks:${id}:${on}`); return { id, enabled: on }; },
    async remove(_u, id) { calls.push(`remove:${id}`); return id === "c1"; },
    ...overrides,
  };
  return { deps, calls, handlers: createConnectionRouteHandlers(deps) };
}

const req = (method: string, body?: unknown, raw = false) =>
  new NextRequest("http://localhost/api/google/connections/c1", {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    ...(body === undefined ? {} : { body: raw ? (body as string) : JSON.stringify(body) }),
  });

async function run(route: (r: NextRequest, c: { params: { id: string } }) => Promise<Response>, r: NextRequest, id = "c1") {
  const res = await route(r, { params: { id } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("GET /api/google/connections", () => {
  it("401 without a user, 200 with the list", async () => {
    const { handlers, calls } = fakes();
    const out = await createAuthedRoute(signedOut, handlers.list as any)(req("GET"), { params: {} as any });
    assert.equal(out.status, 401);
    assert.deepEqual(calls, []);
    const ok = await createAuthedRoute(signedIn, handlers.list as any)(req("GET"), { params: {} as any });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { connections: [{ id: "c1" }] });
  });
});

describe("GET /api/google/connections/[id]", () => {
  it("401 without a user", async () => {
    const { handlers, calls } = fakes();
    assert.equal((await run(createAuthedRoute(signedOut, handlers.get), req("GET"))).status, 401);
    assert.deepEqual(calls, []);
  });
  it("400 for a malformed id, 404 for an unknown one, 200 for a known one", async () => {
    const { handlers } = fakes();
    const route = createAuthedRoute(signedIn, handlers.get);
    assert.equal((await run(route, req("GET"), "a/b")).status, 400);
    assert.equal((await run(route, req("GET"), "zzz")).status, 404);
    assert.equal((await run(route, req("GET"), "c1")).status, 200);
  });
});

describe("PATCH /api/google/connections/[id]", () => {
  it("401 without a user and nothing is toggled", async () => {
    const { handlers, calls } = fakes();
    assert.equal((await run(createAuthedRoute(signedOut, handlers.patch), req("PATCH", { tasks: { enabled: true } }))).status, 401);
    assert.deepEqual(calls, []);
  });

  it("400 for bad JSON, a malformed id, and a missing flag (a missing flag is never 'turn off')", async () => {
    const { handlers, calls } = fakes();
    const route = createAuthedRoute(signedIn, handlers.patch);
    assert.equal((await run(route, req("PATCH", "nope", true))).status, 400);
    assert.equal((await run(route, req("PATCH", { tasks: { enabled: true } }), "a/b")).status, 400);
    assert.equal((await run(route, req("PATCH", {}))).status, 400);
    assert.equal((await run(route, req("PATCH", { tasks: { enabled: "yes" } }))).status, 400);
    assert.deepEqual(calls, []);
  });

  it("toggles Tasks only, Calendar only, or both", async () => {
    const { handlers, calls } = fakes();
    const route = createAuthedRoute(signedIn, handlers.patch);
    const t = await run(route, req("PATCH", { tasks: { enabled: true } }));
    assert.equal(t.status, 200);
    assert.equal(t.body.tasks.enabled, true);
    assert.equal("connection" in t.body, false);
    await run(route, req("PATCH", { calendar: { enabled: false } }));
    await run(route, req("PATCH", { calendar: { enabled: true }, tasks: { enabled: false } }));
    assert.deepEqual(calls, ["tasks:c1:true", "cal:c1:false", "cal:c1:true", "tasks:c1:false"]);
  });

  it("maps a deleted Study Lamp list to a fixed 409 message", async () => {
    const { handlers } = fakes({ async setTasksEnabled() { throw new GoogleConnectionError("tasks_list_deleted", "raw"); } });
    const { status, body } = await run(createAuthedRoute(signedIn, handlers.patch), req("PATCH", { tasks: { enabled: true } }));
    assert.equal(status, 409);
    assert.match(body.error, /task list was deleted/);
  });
});

describe("DELETE /api/google/connections/[id]", () => {
  it("401 without a user, 404 when unknown, 200 when removed", async () => {
    const { handlers, calls } = fakes();
    assert.equal((await run(createAuthedRoute(signedOut, handlers.remove), req("DELETE"))).status, 401);
    assert.deepEqual(calls, []);
    const route = createAuthedRoute(signedIn, handlers.remove);
    assert.equal((await run(route, req("DELETE"), "zzz")).status, 404);
    assert.equal((await run(route, req("DELETE"), "c1")).status, 200);
  });
});
