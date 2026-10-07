import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PlanAlreadyAppliedError } from "./goalSyncApply";
import { buildCalendarEventId, GoogleCalendarApiError } from "./googleCalendar";
import { GoogleTasksApiError } from "./googleTasks";
import type { GoogleSyncLogEntry } from "./googleSyncLog";
import type { GoalSyncMapping, MappingBlock } from "./googleSyncMapping";
import { signPlanToken, verifyPlanToken } from "./planToken";
import {
  applyRemoval,
  collectRemovalCandidates,
  deleteCalendarEventIdempotent,
  deleteTaskIdempotent,
  planRemoval,
  REMOVAL_CHUNK_SIZE,
  REMOVAL_MAX_ITEMS,
  RemovalCountMismatchError,
  type RemovalApplyDeps,
  type RemovalSelection,
} from "./googleSyncRemoval";

const UID = "user-1";
const CAL_ID = "c1k9d8f7@group.calendar.google.com";
const LIST_ID = "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA";
const original = process.env.DRIVE_URL_SIGNING_SECRET;
const originalSync = process.env.GOOGLE_SYNC_SIGNING_SECRET;

beforeEach(() => {
  process.env.DRIVE_URL_SIGNING_SECRET = "test-removal-secret";
  delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
});
afterEach(() => {
  if (original === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
  else process.env.DRIVE_URL_SIGNING_SECRET = original;
  if (originalSync === undefined) delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
  else process.env.GOOGLE_SYNC_SIGNING_SECRET = originalSync;
});

const calendarSel = (scope: "orphans" | "all" = "all"): RemovalSelection => ({ target: "calendar", scope, connectionId: "conn1", containerId: CAL_ID });
const tasksSel = (scope: "orphans" | "all" = "all"): RemovalSelection => ({ target: "tasks", scope, connectionId: "conn1", containerId: LIST_ID });

/** Real id shapes: the hashed Calendar event id and a Google Tasks id (not "goal:<id>"). */
function calMapping(goalId: string, over: Partial<NonNullable<GoalSyncMapping["calendar"]>> = {}): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: `Goal ${goalId}`,
    calendar: { connectionId: "conn1", calendarId: CAL_ID, eventId: buildCalendarEventId(UID, goalId), remoteEtag: `"etag-${goalId}"`, base: null, hash: null, status: "synced", lastSyncAt: null, lastErrorCode: null, ...over },
  };
}

function bothMapping(goalId: string): GoalSyncMapping {
  const base = calMapping(goalId);
  return { ...base, tasks: { connectionId: "conn1", listId: LIST_ID, taskId: `task-${goalId}-Xy9`, remoteEtag: null, base: null, notesHash: null, hash: null, status: "synced", creatingAt: null, lastSyncAt: null, lastErrorCode: null } };
}

function reader(mappings: GoalSyncMapping[], goalIds: string[]) {
  const calls: string[] = [];
  return {
    calls,
    listMappings: async () => { calls.push("listMappings"); return new Map(mappings.map((m) => [m.goalId, m])); },
    listGoalIds: async () => { calls.push("listGoalIds"); return goalIds; },
  };
}

function applyDeps(mappings: GoalSyncMapping[], goalIds: string[], selection: RemovalSelection, over: Partial<RemovalApplyDeps> = {}) {
  const deleted: string[] = [];
  const removedMappings: Array<{ goalId: string; block: MappingBlock }> = [];
  const logs: GoogleSyncLogEntry[] = [];
  const claimed = new Set<string>();
  const sleeps: number[] = [];
  const deps: RemovalApplyDeps = {
    ...reader(mappings, goalIds),
    uid: UID,
    selection,
    deleteRemote: async (id) => { deleted.push(id); return "deleted"; },
    removeMapping: async (goalId, block) => { removedMappings.push({ goalId, block }); },
    log: async (entry) => { logs.push(entry); },
    claimToken: async (_uid, jti) => { if (claimed.has(jti)) return false; claimed.add(jti); return true; },
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  };
  return { deps, deleted, removedMappings, logs, sleeps };
}

describe("collectRemovalCandidates", () => {
  const mappings = new Map([
    ["live", calMapping("live")],
    ["gone", calMapping("gone")],
    ["other-cal", calMapping("other-cal", { calendarId: "someone-elses-calendar" })],
    ["other-conn", calMapping("other-conn", { connectionId: "conn2" })],
    ["tasks-only", { goalId: "tasks-only", titleSnapshot: "t", calendar: null, tasks: bothMapping("tasks-only").tasks }],
  ]);

  it("orphans scope returns only mappings whose goal is gone, for the stored calendar and connection", () => {
    const result = collectRemovalCandidates({ mappings, goalIds: new Set(["live", "gone", "other-cal", "other-conn"]), selection: calendarSel("orphans") });
    assert.deepEqual(result.map((c) => c.goalId), []);
    const withGone = collectRemovalCandidates({ mappings, goalIds: new Set(["live"]), selection: calendarSel("orphans") });
    assert.deepEqual(withGone.map((c) => c.goalId), ["gone"]);
    assert.equal(withGone[0].orphan, true);
  });

  it("all scope never includes another calendar, another connection or the other service", () => {
    const result = collectRemovalCandidates({ mappings, goalIds: new Set(["live", "gone"]), selection: calendarSel("all") });
    assert.deepEqual(result.map((c) => c.goalId), ["gone", "live"]);
    assert.ok(result.every((c) => c.remoteId === buildCalendarEventId(UID, c.goalId)));
  });

  it("tasks: skips a row that never got a task id and a different list", () => {
    const m = new Map([
      ["a", bothMapping("a")],
      ["creating", { goalId: "creating", titleSnapshot: "c", calendar: null, tasks: { ...bothMapping("creating").tasks!, taskId: null, status: "creating" as const } }],
      ["elsewhere", { goalId: "elsewhere", titleSnapshot: "e", calendar: null, tasks: { ...bothMapping("elsewhere").tasks!, listId: "another-list" } }],
    ]);
    const result = collectRemovalCandidates({ mappings: m, goalIds: new Set(["a", "creating", "elsewhere"]), selection: tasksSel("all") });
    assert.deepEqual(result.map((c) => c.goalId), ["a"]);
  });
});

describe("planRemoval (preview)", () => {
  it("performs no write: only the two read functions are called, and no Google call is possible", async () => {
    const r = reader([calMapping("g1"), calMapping("g2")], ["g1"]);
    const plan = await planRemoval(r, { uid: UID, ...calendarSel("all") });
    assert.deepEqual(r.calls.sort(), ["listGoalIds", "listMappings"]);
    assert.equal(plan.count, 2);
    assert.equal(plan.orphans, 1);
    const token = verifyPlanToken(plan.planToken, UID, "remove");
    assert.equal(token.items.length, 2);
  });

  it("returns an empty plan with no token when there is nothing to remove", async () => {
    const plan = await planRemoval(reader([], []), { uid: UID, ...calendarSel("all") });
    assert.deepEqual(plan, { planToken: "", count: 0, orphans: 0, remaining: 0, items: [] });
  });

  it("caps one plan and reports what remains", async () => {
    const many = Array.from({ length: REMOVAL_MAX_ITEMS + 7 }, (_, i) => calMapping(`g${String(i).padStart(4, "0")}`));
    const plan = await planRemoval(reader(many, []), { uid: UID, ...calendarSel("all") });
    assert.equal(plan.count, REMOVAL_MAX_ITEMS);
    assert.equal(plan.remaining, 7);
    assert.equal(plan.items.length, 50);
  });
});

describe("applyRemoval", () => {
  it("deletes only the mapped remote ids, then removes only that service's mapping block, and logs each", async () => {
    const mappings = [bothMapping("g1"), calMapping("g2"), calMapping("other", { calendarId: "not-ours" })];
    const plan = await planRemoval(reader(mappings, ["g1"]), { uid: UID, ...calendarSel("all") });
    const run = applyDeps(mappings, ["g1"], calendarSel("all"));
    const { results } = await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: plan.count });

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "applied"));
    assert.deepEqual(run.deleted.sort(), [buildCalendarEventId(UID, "g1"), buildCalendarEventId(UID, "g2")].sort());
    assert.ok(!run.deleted.includes(buildCalendarEventId(UID, "other")));
    assert.ok(run.removedMappings.every((m) => m.block === "calendar"));
    assert.equal(run.logs.length, 2);
    assert.ok(run.logs.every((l) => l.itemKind === "remove" && l.direction === "study_lamp_to_google" && l.scope === "calendar" && l.result === "applied"));
    assert.ok(!JSON.stringify(run.logs).includes(plan.planToken));
  });

  it("tasks removal deletes task ids and removes the tasks block", async () => {
    const mappings = [bothMapping("g1")];
    const plan = await planRemoval(reader(mappings, ["g1"]), { uid: UID, ...tasksSel("all") });
    const run = applyDeps(mappings, ["g1"], tasksSel("all"));
    await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 1 });
    assert.deepEqual(run.deleted, ["task-g1-Xy9"]);
    assert.deepEqual(run.removedMappings, [{ goalId: "g1", block: "tasks" }]);
  });

  it("a stale confirmCount throws with the fresh count and deletes nothing (and does not burn the token)", async () => {
    const mappings = [calMapping("g1"), calMapping("g2")];
    const plan = await planRemoval(reader(mappings, ["g1", "g2"]), { uid: UID, ...calendarSel("all") });
    const run = applyDeps([...mappings, calMapping("g3")], ["g1", "g2", "g3"], calendarSel("all"));
    await assert.rejects(
      () => applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 2 }),
      (error: unknown) => error instanceof RemovalCountMismatchError && error.count === 3,
    );
    assert.equal(run.deleted.length, 0);
    assert.equal(run.removedMappings.length, 0);

    // The user typed the wrong number for an otherwise valid plan.
    const run2 = applyDeps(mappings, ["g1", "g2"], calendarSel("all"));
    await assert.rejects(() => applyRemoval(run2.deps, { planToken: plan.planToken, confirmCount: 1 }), RemovalCountMismatchError);
    assert.equal(run2.deleted.length, 0);
    const ok = await applyRemoval(run2.deps, { planToken: plan.planToken, confirmCount: 2 });
    assert.equal(ok.results.length, 2);
  });

  it("a replayed token is rejected and deletes nothing the second time", async () => {
    const mappings = [calMapping("g1")];
    const plan = await planRemoval(reader(mappings, ["g1"]), { uid: UID, ...calendarSel("all") });
    const run = applyDeps(mappings, ["g1"], calendarSel("all"));
    await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 1 });
    assert.equal(run.deleted.length, 1);
    await assert.rejects(() => applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 1 }), PlanAlreadyAppliedError);
    assert.equal(run.deleted.length, 1);
  });

  it("a token for another scope or another user is refused before anything is read or written", async () => {
    const mappings = [calMapping("g1")];
    const wrongScope = signPlanToken({ uid: UID, scope: "calendar", items: [] });
    const run = applyDeps(mappings, ["g1"], calendarSel("all"));
    assert.throws(() => verifyPlanToken(wrongScope, UID, "remove"));
    await assert.rejects(() => applyRemoval(run.deps, { planToken: wrongScope, confirmCount: 1 }));
    const otherUser = signPlanToken({ uid: "someone-else", scope: "remove", items: [] });
    await assert.rejects(() => applyRemoval(run.deps, { planToken: otherUser, confirmCount: 1 }));
    assert.equal(run.deleted.length, 0);
  });

  it("an item whose state changed after the preview is stale, not deleted", async () => {
    const mappings = [calMapping("g1")];
    const plan = await planRemoval(reader(mappings, []), { uid: UID, ...calendarSel("all") }); // g1 was an orphan in the preview
    const run = applyDeps(mappings, ["g1"], calendarSel("all")); // ...but the goal exists again at apply time
    const { results } = await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 1 });
    assert.deepEqual(results.map((r) => [r.status, r.code]), [["stale", "fingerprint_mismatch"]]);
    assert.equal(run.deleted.length, 0);
    assert.equal(run.removedMappings.length, 0);
  });

  it("a failed remote delete keeps the mapping and is reported as failed, never applied", async () => {
    const mappings = [calMapping("g1"), calMapping("g2")];
    const plan = await planRemoval(reader(mappings, ["g1", "g2"]), { uid: UID, ...calendarSel("all") });
    const failing = buildCalendarEventId(UID, "g1");
    const run = applyDeps(mappings, ["g1", "g2"], calendarSel("all"), {
      deleteRemote: async (id) => {
        if (id === failing) throw new GoogleCalendarApiError(503, "retryable");
        return "deleted";
      },
    });
    const { results } = await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 2 });
    assert.deepEqual(results.map((r) => r.status).sort(), ["applied", "failed"]);
    assert.deepEqual(run.removedMappings.map((m) => m.goalId), ["g2"]);
    assert.ok(run.logs.some((l) => l.result === "failed"));
  });

  it("paces deletes in chunks of 25", async () => {
    const mappings = Array.from({ length: 60 }, (_, i) => calMapping(`g${String(i).padStart(3, "0")}`));
    const ids = mappings.map((m) => m.goalId);
    const plan = await planRemoval(reader(mappings, ids), { uid: UID, ...calendarSel("all") });
    const run = applyDeps(mappings, ids, calendarSel("all"));
    await applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 60 });
    assert.equal(run.deleted.length, 60);
    assert.equal(run.sleeps.length, 2); // after the 25th and the 50th delete
    assert.equal(REMOVAL_CHUNK_SIZE, 25);
  });

  it("a different scope than the one previewed does not match the token", async () => {
    const mappings = [calMapping("live"), calMapping("gone")];
    const plan = await planRemoval(reader(mappings, ["live"]), { uid: UID, ...calendarSel("orphans") });
    assert.equal(plan.count, 1);
    const run = applyDeps(mappings, ["live"], calendarSel("all"));
    await assert.rejects(() => applyRemoval(run.deps, { planToken: plan.planToken, confirmCount: 2 }), RemovalCountMismatchError);
    assert.equal(run.deleted.length, 0);
  });
});

describe("remote delete helpers (404/410 = already gone)", () => {
  it("calendar: remote_missing resolves as already_gone; other errors throw", async () => {
    assert.equal(await deleteCalendarEventIdempotent({ deleteEvent: async () => undefined }, CAL_ID, "e1"), "deleted");
    assert.equal(await deleteCalendarEventIdempotent({ deleteEvent: async () => { throw new GoogleCalendarApiError(410, "remote_missing"); } }, CAL_ID, "e1"), "already_gone");
    await assert.rejects(() => deleteCalendarEventIdempotent({ deleteEvent: async () => { throw new GoogleCalendarApiError(403, "scope_missing"); } }, CAL_ID, "e1"));
  });

  it("tasks: remote_missing resolves as already_gone; other errors throw", async () => {
    assert.equal(await deleteTaskIdempotent({ deleteTask: async () => undefined }, LIST_ID, "t1"), "deleted");
    assert.equal(await deleteTaskIdempotent({ deleteTask: async () => { throw new GoogleTasksApiError(404, "remote_missing"); } }, LIST_ID, "t1"), "already_gone");
    await assert.rejects(() => deleteTaskIdempotent({ deleteTask: async () => { throw new GoogleTasksApiError(500, "retryable"); } }, LIST_ID, "t1"));
  });
});
