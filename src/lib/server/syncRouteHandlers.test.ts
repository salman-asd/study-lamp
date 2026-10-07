import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { createAuthedRoute } from "./routeHelpers";
import { GoogleConnectionError } from "./googleConnections";
import { PlanAlreadyAppliedError } from "./goalSyncApply";
import { signPlanToken, type PlanScope } from "./planToken";
import {
  createSyncApplyHandler,
  createSyncPlanHandler,
  createSyncStatusHandler,
  EMPTY_CALENDAR_PLAN,
  readTargets,
  type SyncApplyDeps,
  type SyncPlanDeps,
  type SyncStatusDeps,
} from "./syncRouteHandlers";

const UID = "user-1";
const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;
const originalSyncSecret = process.env.GOOGLE_SYNC_SIGNING_SECRET;

beforeEach(() => {
  process.env.DRIVE_URL_SIGNING_SECRET = "test-route-secret";
  delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
  else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  if (originalSyncSecret === undefined) delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
  else process.env.GOOGLE_SYNC_SIGNING_SECRET = originalSyncSecret;
});

const signedIn = async () => UID;
const signedOut = async () => null;

function post(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost/api/google/sync", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

function get(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/google/sync/status${query}`, { headers: { authorization: "Bearer test" } });
}

async function call(route: (req: NextRequest, ctx: { params: Record<string, never> }) => Promise<Response>, req: NextRequest) {
  const res = await route(req, { params: {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ─── readTargets (audit H1) ─────────────────────────────────────────────────

describe("readTargets", () => {
  it("defaults to Calendar only, so a goals-page check never reads Tasks", () => {
    assert.deepEqual(readTargets(undefined), { targets: ["calendar"], explicit: false });
    assert.deepEqual(readTargets(null), { targets: ["calendar"], explicit: false });
    assert.deepEqual(readTargets("tasks"), { targets: ["calendar"], explicit: false });
  });

  it("honours explicit targets, de-duplicates and drops unknown values", () => {
    assert.deepEqual(readTargets(["tasks"]), { targets: ["tasks"], explicit: true });
    assert.deepEqual(readTargets(["tasks", "calendar", "tasks", "drive"]), { targets: ["tasks", "calendar"], explicit: true });
    assert.deepEqual(readTargets([]), { targets: [], explicit: true });
  });
});

// ─── plan route ─────────────────────────────────────────────────────────────

function planFakes(overrides: Partial<SyncPlanDeps> = {}) {
  const calls: string[] = [];
  const deps: SyncPlanDeps = {
    async planCalendar(_uid, _connectionId, goalIds) {
      calls.push(`calendar:${goalIds.join(",")}`);
      return { planToken: "cal-token", items: [], counts: EMPTY_CALENDAR_PLAN.counts, orphans: [], remaining: 0 };
    },
    async planTasks() {
      calls.push("tasks");
      return { planToken: "tasks-token", items: [], counts: EMPTY_CALENDAR_PLAN.counts, orphans: [], remaining: 0 };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("POST /api/google/sync/plan", () => {
  it("answers 401 without a signed-in user and plans nothing", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedOut, createSyncPlanHandler(deps));
    const { status, body } = await call(route, post({}));
    assert.equal(status, 401);
    assert.equal(body.error, "Unauthorized");
    assert.deepEqual(calls, []);
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    assert.equal((await call(route, post("not json", true))).status, 400);
    assert.equal((await call(route, post([1, 2]))).status, 400);
    assert.deepEqual(calls, []);
  });

  it("answers 400 for more than 25 goal ids", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const { status } = await call(route, post({ goalIds: Array.from({ length: 26 }, (_, i) => `g${i}`) }));
    assert.equal(status, 400);
    assert.deepEqual(calls, []);
  });

  it("with no targets plans Calendar only: Tasks is never read (H1 regression)", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const { status, body } = await call(route, post({ goalIds: ["g1"] }));
    assert.equal(status, 200);
    assert.deepEqual(calls, ["calendar:g1"]);
    assert.equal(body.planToken, "cal-token");
    assert.equal("tasks" in body, false);
  });

  it("with targets [\"tasks\"] plans Tasks only and nests it under `tasks`", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const { status, body } = await call(route, post({ targets: ["tasks"] }));
    assert.equal(status, 200);
    assert.deepEqual(calls, ["tasks"]);
    assert.equal(body.tasks.planToken, "tasks-token");
    assert.equal(body.planToken, "", "the Calendar part stays the empty plan");
  });

  it("with both targets plans both, each with its own plan token", async () => {
    const { deps, calls } = planFakes();
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const { body } = await call(route, post({ targets: ["calendar", "tasks"] }));
    assert.deepEqual(calls, ["calendar:", "tasks"]);
    assert.notEqual(body.planToken, body.tasks.planToken);
  });

  it("tolerates a Calendar that was never set up on a default check, but not on an explicit one", async () => {
    const { deps } = planFakes({
      async planCalendar() {
        throw new GoogleConnectionError("not_found", "x");
      },
    });
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const implicit = await call(route, post({}));
    assert.equal(implicit.status, 200);
    assert.equal(implicit.body.planToken, "");

    const explicit = await call(route, post({ targets: ["calendar"] }));
    assert.equal(explicit.status, 404);
  });

  it("does NOT swallow 'ambiguous': several connections must be reported, never a silent empty plan (audit M2)", async () => {
    const { deps } = planFakes({
      async planCalendar() {
        throw new GoogleConnectionError("ambiguous", "x");
      },
    });
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const { status, body } = await call(route, post({}));
    assert.equal(status, 409);
    assert.equal(body.code, "ambiguous");
    assert.match(body.error, /more than one Google connection/i);
  });

  it("returns a fixed message and never the library error text", async () => {
    const { deps } = planFakes({
      async planCalendar() {
        throw new Error("secret-token-in-message");
      },
    });
    const route = createAuthedRoute(signedIn, createSyncPlanHandler(deps));
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const { status, body } = await call(route, post({}));
      assert.equal(status, 500);
      assert.equal(JSON.stringify(body).includes("secret-token"), false);
    } finally {
      console.error = originalError;
    }
  });
});

// ─── apply route ────────────────────────────────────────────────────────────

const ITEM_ID = "a".repeat(64);

function tokenFor(scope: PlanScope, uid = UID): string {
  return signPlanToken({ uid, scope, items: [{ itemId: ITEM_ID, fingerprint: "fp" }] });
}

function applyFakes(overrides: Partial<SyncApplyDeps> = {}) {
  const calls: string[] = [];
  const deps: SyncApplyDeps = {
    async applyCalendar() {
      calls.push("applyCalendar");
      return { results: [{ status: "applied" }] };
    },
    async applyTasks() {
      calls.push("applyTasks");
      return { results: [{ status: "applied" }] };
    },
    async pruneUsedTokens() {
      calls.push("prune");
      return 0;
    },
    ...overrides,
  };
  return { deps, calls };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("POST /api/google/sync/apply", () => {
  it("answers 401 without a signed-in user and writes nothing", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedOut, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [ITEM_ID] }));
    assert.equal(status, 401);
    assert.deepEqual(calls, []);
  });

  it("answers 400 when the body is not JSON or the plan token is missing", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    assert.equal((await call(route, post("nope", true))).status, 400);
    const missing = await call(route, post({ accepted: [ITEM_ID] }));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "Missing planToken.");
    assert.deepEqual(calls, []);
  });

  it("answers 401 for a tampered token, a token of another user, and an expired token", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    assert.equal((await call(route, post({ planToken: `${tokenFor("calendar")}x`, accepted: [ITEM_ID] }))).status, 401);
    assert.equal((await call(route, post({ planToken: tokenFor("calendar", "someone-else"), accepted: [ITEM_ID] }))).status, 401);
    const expired = signPlanToken({ uid: UID, scope: "calendar", items: [], exp: Math.floor(Date.now() / 1000) - 60 });
    assert.equal((await call(route, post({ planToken: expired, accepted: [ITEM_ID] }))).status, 401);
    assert.deepEqual(calls, []);
  });

  it("refuses a TASKS token on the Calendar apply path: nothing is applied or pruned", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("tasks"), accepted: [ITEM_ID] }));
    assert.equal(status, 401);
    await flush();
    assert.deepEqual(calls, []);
  });

  it("refuses a CALENDAR token on the Tasks apply path", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("calendar"), target: "tasks", accepted: [ITEM_ID] }));
    assert.equal(status, 401);
    assert.deepEqual(calls, []);
  });

  it("refuses a token from another service (docs append) on both paths", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    assert.equal((await call(route, post({ planToken: tokenFor("docs_append"), accepted: [ITEM_ID] }))).status, 401);
    assert.equal((await call(route, post({ planToken: tokenFor("docs_append"), target: "tasks", accepted: [ITEM_ID] }))).status, 401);
    assert.deepEqual(calls, []);
  });

  it("answers 409 when nothing was accepted", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [] }));
    assert.equal(status, 409);
    assert.deepEqual(calls, []);
  });

  it("applies a Calendar plan, prunes used tokens once, and reports the tally", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status, body } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [ITEM_ID] }));
    await flush();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.applied, 1);
    assert.deepEqual(calls, ["applyCalendar", "prune"]);
  });

  it("applies a Tasks plan and prunes used tokens too (H3: both routes)", async () => {
    const { deps, calls } = applyFakes();
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("tasks"), target: "tasks", accepted: [ITEM_ID] }));
    await flush();
    assert.equal(status, 200);
    assert.deepEqual(calls, ["applyTasks", "prune"]);
  });

  it("a failing prune never changes the response", async () => {
    const { deps } = applyFakes({
      async pruneUsedTokens() {
        throw new Error("firestore down");
      },
    });
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status, body } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [ITEM_ID] }));
    await flush();
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it("does not prune and answers 409 when the plan was already applied (replay)", async () => {
    const { deps, calls } = applyFakes({
      async applyCalendar() {
        throw new PlanAlreadyAppliedError();
      },
    });
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [ITEM_ID] }));
    await flush();
    assert.equal(status, 409);
    assert.deepEqual(calls, []);
  });

  it("answers 409 when that service's sync is not enabled, and does not prune", async () => {
    const { deps, calls } = applyFakes({ async applyTasks() { return null; } });
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { status, body } = await call(route, post({ planToken: tokenFor("tasks"), target: "tasks", accepted: [ITEM_ID] }));
    await flush();
    assert.equal(status, 409);
    assert.match(body.error, /not enabled/);
    assert.deepEqual(calls, []);
  });

  it("reports ok:false when every item failed", async () => {
    const { deps } = applyFakes({ async applyCalendar() { return { results: [{ status: "failed" }, { status: "skipped" }] }; } });
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    const { body } = await call(route, post({ planToken: tokenFor("calendar"), accepted: [ITEM_ID] }));
    assert.equal(body.ok, false);
    assert.equal(body.failed, 1);
    assert.equal(body.skipped, 1);
  });

  it("passes only well-formed resolutions through to the apply step", async () => {
    let seen: unknown;
    const { deps } = applyFakes({
      async applyCalendar(_uid, _connection, input) {
        seen = input.resolutions;
        return { results: [{ status: "applied" }] };
      },
    });
    const route = createAuthedRoute(signedIn, createSyncApplyHandler(deps));
    await call(route, post({
      planToken: tokenFor("calendar"),
      accepted: [ITEM_ID],
      resolutions: { [ITEM_ID]: "use_google", [`${ITEM_ID}:title`]: "use_study_lamp", "not-an-id": "use_google", [`${"b".repeat(64)}`]: "format_disk" },
    }));
    assert.deepEqual(seen, { [ITEM_ID]: "use_google", [`${ITEM_ID}:title`]: "use_study_lamp" });
  });
});

// ─── status route ───────────────────────────────────────────────────────────

describe("GET /api/google/sync/status", () => {
  function statusFakes() {
    const calls: string[] = [];
    const deps: SyncStatusDeps = {
      async calendarStatus(_uid, connectionId) { calls.push(`calendar:${connectionId}`); return { enabled: true, which: "calendar" }; },
      async tasksStatus(_uid, connectionId) { calls.push(`tasks:${connectionId}`); return { enabled: false, which: "tasks" }; },
    };
    return { deps, calls };
  }

  it("answers 401 without a signed-in user", async () => {
    const { deps, calls } = statusFakes();
    const route = createAuthedRoute(signedOut, createSyncStatusHandler(deps));
    assert.equal((await call(route, get())).status, 401);
    assert.deepEqual(calls, []);
  });

  it("returns the Calendar status by default and passes the connection id", async () => {
    const { deps, calls } = statusFakes();
    const route = createAuthedRoute(signedIn, createSyncStatusHandler(deps));
    const { status, body } = await call(route, get("?connectionId=conn-1"));
    assert.equal(status, 200);
    assert.equal(body.which, "calendar");
    assert.deepEqual(calls, ["calendar:conn-1"]);
  });

  it("returns the Tasks status for ?target=tasks", async () => {
    const { deps, calls } = statusFakes();
    const route = createAuthedRoute(signedIn, createSyncStatusHandler(deps));
    const { body } = await call(route, get("?target=tasks"));
    assert.equal(body.which, "tasks");
    assert.deepEqual(calls, ["tasks:null"]);
  });

  it("maps a connection problem to a fixed message", async () => {
    const deps: SyncStatusDeps = {
      async calendarStatus() { throw new GoogleConnectionError("invalid", "refresh token abc rejected"); },
      async tasksStatus() { return {}; },
    };
    const route = createAuthedRoute(signedIn, createSyncStatusHandler(deps));
    const { status, body } = await call(route, get());
    assert.equal(status, 409);
    assert.equal(JSON.stringify(body).includes("abc"), false);
  });
});
