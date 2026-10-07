import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { createAuthedRoute } from "./routeHelpers";
import { PlanAlreadyAppliedError } from "./goalSyncApply";
import { RemovalCountMismatchError, type RemovalPlan } from "./googleSyncRemoval";
import { signPlanToken } from "./planToken";
import {
  createRemovalApplyHandler,
  createRemovalPreviewHandler,
  createSyncHistoryHandler,
  HISTORY_PAGE_SIZE,
  type RemovalRouteDeps,
  type SyncHistoryDeps,
} from "./syncRemovalHandlers";

const UID = "user-1";
const original = process.env.DRIVE_URL_SIGNING_SECRET;
const originalSync = process.env.GOOGLE_SYNC_SIGNING_SECRET;
beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-handler-secret"; delete process.env.GOOGLE_SYNC_SIGNING_SECRET; });
afterEach(() => {
  if (original === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET; else process.env.DRIVE_URL_SIGNING_SECRET = original;
  if (originalSync === undefined) delete process.env.GOOGLE_SYNC_SIGNING_SECRET; else process.env.GOOGLE_SYNC_SIGNING_SECRET = originalSync;
});

const signedIn = async () => UID;
const signedOut = async () => null;
type Route = (req: NextRequest, ctx: { params: Record<string, never> }) => Promise<Response>;

function post(body: unknown, raw = false) {
  return new NextRequest("http://localhost/api/google/sync/remove", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}
const get = (query = "") => new NextRequest(`http://localhost/api/google/sync/history${query}`, { headers: { authorization: "Bearer t" } });
async function call(route: Route, req: NextRequest) {
  const res = await route(req, { params: {} });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const EMPTY: RemovalPlan = { planToken: "", count: 0, orphans: 0, remaining: 0, items: [] };
function fakeDeps(over: Partial<RemovalRouteDeps> = {}) {
  const calls = { preview: 0, apply: 0, prune: 0 };
  const deps: RemovalRouteDeps = {
    preview: async () => { calls.preview += 1; return EMPTY; },
    apply: async () => { calls.apply += 1; return { results: [{ itemId: "i", status: "applied" as const }] }; },
    pruneUsedTokens: async () => { calls.prune += 1; },
    ...over,
  };
  return { deps, calls };
}
const valid = { target: "calendar", scope: "all", connectionId: "conn1" };

describe("remove/preview route", () => {
  it("401 without a signed-in user, before anything runs", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedOut, createRemovalPreviewHandler(deps));
    assert.equal((await call(route, post(valid))).status, 401);
    assert.equal(calls.preview, 0);
  });

  it("400 on bad JSON, bad target, bad scope, missing connection id", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedIn, createRemovalPreviewHandler(deps));
    assert.equal((await call(route, post("nope", true))).status, 400);
    assert.equal((await call(route, post({ ...valid, target: "drive" }))).status, 400);
    assert.equal((await call(route, post({ ...valid, scope: "everything" }))).status, 400);
    assert.equal((await call(route, post({ target: "tasks", scope: "orphans" }))).status, 400);
    assert.equal((await call(route, post({ ...valid, connectionId: "a/b" }))).status, 400);
    assert.equal(calls.preview, 0);
  });

  it("success returns the plan and never calls apply or prune (zero writes)", async () => {
    const plan: RemovalPlan = { planToken: "tok", count: 3, orphans: 1, remaining: 0, items: [] };
    const { deps, calls } = fakeDeps({ preview: async () => plan });
    const route = createAuthedRoute(signedIn, createRemovalPreviewHandler(deps));
    const { status, body } = await call(route, post(valid));
    assert.equal(status, 200);
    assert.equal(body.count, 3);
    assert.equal(calls.apply, 0);
    assert.equal(calls.prune, 0);
  });
});

describe("remove route", () => {
  const token = () => signPlanToken({ uid: UID, scope: "remove", items: [{ itemId: "a".repeat(64), fingerprint: "f" }] });

  it("401 when signed out", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedOut, createRemovalApplyHandler(deps));
    assert.equal((await call(route, post({ ...valid, planToken: token(), confirmCount: 1 }))).status, 401);
    assert.equal(calls.apply, 0);
  });

  it("no token -> 400; bad confirmCount -> 400; nothing applied", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    assert.equal((await call(route, post({ ...valid, confirmCount: 1 }))).status, 400);
    assert.equal((await call(route, post({ ...valid, planToken: token() }))).status, 400);
    assert.equal((await call(route, post({ ...valid, planToken: token(), confirmCount: "1" }))).status, 400);
    assert.equal((await call(route, post({ ...valid, planToken: token(), confirmCount: 1.5 }))).status, 400);
    assert.equal((await call(route, post({ planToken: token(), confirmCount: 1 }))).status, 400);
    assert.equal(calls.apply, 0);
  });

  it("a tampered token or one signed for another scope -> 401", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    assert.equal((await call(route, post({ ...valid, planToken: `${token()}x`, confirmCount: 1 }))).status, 401);
    const calendarToken = signPlanToken({ uid: UID, scope: "calendar", items: [] });
    assert.equal((await call(route, post({ ...valid, planToken: calendarToken, confirmCount: 1 }))).status, 401);
    assert.equal(calls.apply, 0);
  });

  it("success returns the summary and prunes spent tokens in the background", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    const { status, body } = await call(route, post({ ...valid, planToken: token(), confirmCount: 1 }));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.applied, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.prune, 1);
  });

  it("a stale confirmCount -> 409 carrying the fresh count", async () => {
    const { deps } = fakeDeps({ apply: async () => { throw new RemovalCountMismatchError(7); } });
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    const { status, body } = await call(route, post({ ...valid, planToken: token(), confirmCount: 3 }));
    assert.equal(status, 409);
    assert.equal(body.code, "count_changed");
    assert.equal(body.count, 7);
  });

  it("a replayed token -> 409", async () => {
    const { deps } = fakeDeps({ apply: async () => { throw new PlanAlreadyAppliedError(); } });
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    assert.equal((await call(route, post({ ...valid, planToken: token(), confirmCount: 1 }))).status, 409);
  });

  it("an unexpected failure is a generic 500 with no internal message", async () => {
    const { deps } = fakeDeps({ apply: async () => { throw new Error("secret detail from google"); } });
    const route = createAuthedRoute(signedIn, createRemovalApplyHandler(deps));
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const { status, body } = await call(route, post({ ...valid, planToken: token(), confirmCount: 1 }));
      assert.equal(status, 500);
      assert.ok(!JSON.stringify(body).includes("secret"));
    } finally {
      console.error = originalError;
    }
  });
});

describe("history route", () => {
  function fakeHistory() {
    const seen: Array<{ cursor: string | undefined; limit: number }> = [];
    const pages: Record<string, { entries: any[]; nextCursor: string | null }> = {
      first: { entries: [{ at: "2026-10-07T10:00:00.000Z", titleSnapshot: "A" }], nextCursor: "abc123" },
      abc123: { entries: [{ at: "2026-10-06T10:00:00.000Z", titleSnapshot: "B" }], nextCursor: null },
    };
    const deps: SyncHistoryDeps = {
      list: async (_uid, cursor, limit) => { seen.push({ cursor, limit }); return pages[cursor ?? "first"]; },
    };
    return { deps, seen };
  }

  it("401 when signed out", async () => {
    const { deps, seen } = fakeHistory();
    const route = createAuthedRoute(signedOut, createSyncHistoryHandler(deps));
    assert.equal((await call(route, get())).status, 401);
    assert.equal(seen.length, 0);
  });

  it("pages with a cursor, 50 at a time", async () => {
    const { deps, seen } = fakeHistory();
    const route = createAuthedRoute(signedIn, createSyncHistoryHandler(deps));
    const first = await call(route, get());
    assert.equal(first.status, 200);
    assert.equal(first.body.nextCursor, "abc123");
    const second = await call(route, get("?cursor=abc123"));
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual(seen, [{ cursor: undefined, limit: HISTORY_PAGE_SIZE }, { cursor: "abc123", limit: HISTORY_PAGE_SIZE }]);
    assert.equal(HISTORY_PAGE_SIZE, 50);
  });

  it("400 for a cursor that could address another path", async () => {
    const { deps, seen } = fakeHistory();
    const route = createAuthedRoute(signedIn, createSyncHistoryHandler(deps));
    assert.equal((await call(route, get("?cursor=..%2Fusers"))).status, 400);
    assert.equal((await call(route, get(`?cursor=${"a".repeat(200)}`))).status, 400);
    assert.equal(seen.length, 0);
  });
});
