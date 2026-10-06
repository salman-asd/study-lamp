import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { addDaysToIsoDate } from "@/lib/isoDate";
import type { Goal } from "@/types";
import { PlanTokenVerificationError } from "./planToken";
import { buildCalendarEventId, GoogleCalendarApiError, type CalendarEventPayload, type GoogleCalendarEventLike } from "./googleCalendar";
import { buildGoalSyncPlan, type LiveCalendarEvent } from "./goalSyncPlan";
import { applyCalendarSync, validateGoalFieldPull, type CalendarApplyDeps, type GoalPullResult } from "./goalSyncApply";
import type { GoalSyncMapping, SyncBase } from "./googleSyncMapping";
import type { GoogleSyncLogEntry } from "./googleSyncLog";

const UID = "user-1";
const CAL = "cal-abc@group.calendar.google.com";

function goal(id: string, title: string, targetDate: string | null, completed = false): Goal {
  return { id, title, targetDate, completed } as Goal;
}

function liveEvent(goalId: string, title: string, date: string, extra: Partial<LiveCalendarEvent> = {}): LiveCalendarEvent {
  return {
    id: buildCalendarEventId(UID, goalId),
    etag: `"etag-${goalId}-1"`,
    status: "confirmed",
    summary: title,
    start: { date },
    end: { date: addDaysToIsoDate(date, 1) },
    extendedProperties: { private: { studylampGoalId: goalId, uid: UID } },
    ...extra,
  };
}

function mapping(goalId: string, base: { title: string; targetDate: string; completed?: boolean }): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: base.title,
    calendar: { connectionId: "conn-1", calendarId: CAL, eventId: buildCalendarEventId(UID, goalId), remoteEtag: null, base: { title: base.title, targetDate: base.targetDate, completed: base.completed ?? false }, hash: null, status: "synced", lastSyncAt: null, lastErrorCode: null },
  };
}

interface World {
  goals: Goal[];
  events: LiveCalendarEvent[];
  mappings: GoalSyncMapping[];
}

/** An in-memory Google + Firestore that records every write. */
function makeDeps(world: World, options: { insert?: () => Promise<void>; patch?: () => Promise<void>; pull?: GoalPullResult } = {}) {
  const writes: Array<{ op: string; detail?: unknown }> = [];
  const saved: Array<{ goalId: string; eventId: string; base: SyncBase | null; remoteEtag: string | null; status?: string }> = [];
  const logs: GoogleSyncLogEntry[] = [];
  const ignored: string[] = [];
  const created: Array<{ title: string; targetDate: string; eventId: string }> = [];
  const errors: Array<{ goalId: string; code: string }> = [];
  const usedTokens = new Set<string>();

  const deps: CalendarApplyDeps = {
    uid: UID,
    connectionId: "conn-1",
    calendarId: CAL,
    // Fake one-time-token store; a second claim of the same jti fails (Z3 item 6).
    claimToken: async (_uid, jti) => {
      if (usedTokens.has(jti)) return false;
      usedTokens.add(jti);
      return true;
    },
    listGoals: async () => world.goals,
    listMappings: async () => new Map(world.mappings.map((m) => [m.goalId, m])),
    listLiveEvents: async () => ({ events: world.events, truncated: false }),
    listIgnoredRemoteIds: async () => new Set(ignored),
    client: {
      insertEvent: async (_cal, event): Promise<GoogleCalendarEventLike> => {
        await options.insert?.();
        writes.push({ op: "insert", detail: event });
        const created = { ...event, etag: '"created"' } as unknown as LiveCalendarEvent;
        world.events.push(created);
        return created;
      },
      patchEvent: async (_cal, eventId, updates: Partial<CalendarEventPayload>, opts): Promise<GoogleCalendarEventLike> => {
        await options.patch?.();
        writes.push({ op: "patch", detail: { eventId, updates, ifMatch: opts?.ifMatch ?? null } });
        return { id: eventId, etag: '"patched"' };
      },
      getEvent: async (_cal, eventId) => {
        const found = world.events.find((e) => e.id === eventId);
        if (!found) throw new GoogleCalendarApiError(404, "remote_missing");
        return found;
      },
    },
    saveMapping: async (goalId, input) => {
      writes.push({ op: "saveMapping", detail: goalId });
      saved.push({ goalId, eventId: input.eventId, base: input.base, remoteEtag: input.remoteEtag, status: input.status });
    },
    recordError: async (goalId, code) => { errors.push({ goalId, code }); },
    pullGoalFields: async (goalId, _expected, updates, mappingSave) => {
      writes.push({ op: "pullGoal", detail: { goalId, updates } });
      const outcome = options.pull ?? "ok";
      // The real store writes the mapping in the same transaction, and only when the goal write succeeds.
      if (outcome === "ok") saved.push({ goalId, eventId: mappingSave.eventId, base: mappingSave.base, remoteEtag: mappingSave.remoteEtag });
      return outcome;
    },
    createGoalFromEvent: async (input) => {
      writes.push({ op: "createGoal", detail: input });
      created.push({ title: input.title, targetDate: input.targetDate, eventId: input.eventId });
      return { goalId: "new-goal" };
    },
    deleteGoal: async (goalId) => {
      writes.push({ op: "deleteGoal", detail: goalId });
      return options.pull ?? "ok";
    },
    ignoreRemote: async (remoteId) => { writes.push({ op: "ignore", detail: remoteId }); ignored.push(remoteId); },
    log: async (entry) => { logs.push(entry); },
  };
  return { deps, writes, saved, errors, usedTokens, logs, ignored, created };
}

function previewOf(world: World, ignored: string[] = []) {
  return buildGoalSyncPlan({ uid: UID, calendarId: CAL, goals: world.goals, liveEvents: world.events, mappings: new Map(world.mappings.map((m) => [m.goalId, m])), ignoredRemoteIds: new Set(ignored) });
}

function deletedWorld(): World {
  return {
    goals: [goal("g1", "Read chapter 2", "2026-10-10")],
    events: [liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" })],
    mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
  };
}

describe("applyCalendarSync", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-apply-secret"; });

  it("push_create inserts once with the deterministic id, saves the mapping, and the next plan is empty", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const { deps, writes, saved } = makeDeps(world);

    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });

    assert.equal(results[0].status, "applied");
    const inserts = writes.filter((w) => w.op === "insert");
    assert.equal(inserts.length, 1);
    assert.equal((inserts[0].detail as { id: string }).id, buildCalendarEventId(UID, "g1"));
    assert.equal(saved[0].base!.targetDate, "2026-10-10");

    world.mappings.push(mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" }));
    assert.equal(previewOf(world).items.length, 0);
  });

  it("does nothing for items the user did not accept", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const { deps, writes } = makeDeps(world);
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: ["some-other-id"] });
    assert.equal(results[0].status, "skipped");
    assert.deepEqual(writes, []);
  });

  it("a token for another user is rejected before any read-modify-write", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const { deps, writes } = makeDeps(world);
    await assert.rejects(applyCalendarSync({ ...deps, uid: "someone-else" }, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) }), PlanTokenVerificationError);
    assert.deepEqual(writes, []);
  });

  it("insert 409 raised by Google itself is adopted via get + patch with If-Match", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const { deps, writes, saved } = makeDeps(world);
    const raced = liveEvent("g1", "Read chapter 2", "2026-10-10");
    // The event appears only AFTER apply's own read (so the plan still says push_create), then insert answers 409.
    deps.client.insertEvent = async () => { world.events.push(raced); throw new GoogleCalendarApiError(409, "exists"); };

    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "applied");
    const patch = writes.find((w) => w.op === "patch")!;
    assert.deepEqual((patch.detail as { ifMatch: string }).ifMatch, raced.etag);
    assert.equal(saved.length, 1);
  });

  it("insert 409 on a cancelled event is skipped as remote_cancelled and nothing is saved", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const { deps, saved } = makeDeps(world);
    const cancelled = liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" });
    deps.client.insertEvent = async () => { world.events.push(cancelled); throw new GoogleCalendarApiError(409, "exists"); };

    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "skipped");
    assert.equal(results[0].code, "remote_cancelled");
    assert.deepEqual(saved, []);
  });

  it("push_update PATCHES with If-Match = the etag the user saw (never inserts)", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    assert.equal(preview.items[0].kind, "push_update");
    const { deps, writes, saved } = makeDeps(world);

    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });

    assert.equal(results[0].status, "applied");
    assert.equal(writes.filter((w) => w.op === "insert").length, 0);
    const patch = writes.find((w) => w.op === "patch")!.detail as { ifMatch: string; updates: CalendarEventPayload };
    assert.equal(patch.ifMatch, world.events[0].etag);
    assert.deepEqual(patch.updates.start, { date: "2026-10-14" });
    assert.equal(saved[0].remoteEtag, '"patched"');
  });

  it("a 412 on patch is reported as skipped changed_remotely and the mapping is not saved", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const { deps, saved } = makeDeps(world, { patch: async () => { throw new GoogleCalendarApiError(412, "changed_remotely"); } });
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "skipped");
    assert.equal(results[0].code, "changed_remotely");
    assert.deepEqual(saved, []);
  });

  it("an unexpected Google error is 'failed', records the error code, and saves nothing", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const { deps, saved, errors } = makeDeps(world, { patch: async () => { throw new GoogleCalendarApiError(503, "retryable"); } });
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "failed");
    assert.deepEqual(errors, [{ goalId: "g1", code: "retryable" }]);
    assert.deepEqual(saved, []);
  });

  it("pull_update changes ONLY the Google-changed field on the goal and never writes to Google", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    assert.equal(preview.items[0].kind, "pull_update");
    const { deps, writes, saved } = makeDeps(world);

    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });

    assert.equal(results[0].status, "applied");
    assert.deepEqual(writes.find((w) => w.op === "pullGoal")!.detail, { goalId: "g1", updates: { targetDate: "2026-10-12" } });
    assert.equal(writes.filter((w) => w.op === "patch" || w.op === "insert").length, 0);
    assert.equal(saved[0].base!.targetDate, "2026-10-12");
  });

  it("a pull is skipped as goal_changed when the goal changed under the transaction", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const { deps, saved } = makeDeps(world, { pull: "changed" });
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].code, "goal_changed");
    assert.equal(results[0].status, "skipped");
    assert.deepEqual(saved, []);
  });

  it("a blank title in Google is an attention item: never pulled into the goal", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "   ", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const { deps, writes } = makeDeps(world);
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(preview.items[0].kind, "attention");
    assert.equal(results[0].status, "skipped");
    assert.equal(results[0].code, "needs_attention");
    assert.deepEqual(writes, []);
  });

  it("a goal edited after the preview makes that item stale: nothing is written", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    world.goals = [goal("g1", "Read chapter 2 (edited)", "2026-10-10")];
    const { deps, writes } = makeDeps(world);
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "stale");
    assert.deepEqual(writes, []);
  });

  it("an event changed in Google after the preview makes that item stale", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    world.events = [liveEvent("g1", "Read chapter 2", "2026-10-10", { etag: '"etag-g1-2"' })];
    const { deps, writes } = makeDeps(world);
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "stale");
    assert.deepEqual(writes, []);
  });

  it("a conflict needs a resolution; use_google pulls, use_study_lamp patches", async () => {
    const make = (): World => ({
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    });

    let world = make();
    let preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    let ctx = makeDeps(world);
    let out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId] });
    assert.equal(out.results[0].code, "missing_resolution");
    assert.deepEqual(ctx.writes, []);

    world = make(); preview = previewOf(world); ctx = makeDeps(world);
    out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "use_google" } });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.find((w) => w.op === "pullGoal")!.detail, { goalId: "g1", updates: { targetDate: "2026-10-12" } });
    assert.equal(ctx.writes.filter((w) => w.op === "patch").length, 0);

    world = make(); preview = previewOf(world); ctx = makeDeps(world);
    out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "use_study_lamp" } });
    assert.equal(out.results[0].status, "applied");
    assert.equal(ctx.writes.filter((w) => w.op === "patch").length, 1);
    assert.equal(ctx.writes.filter((w) => w.op === "pullGoal").length, 0);
  });

  it("remote_deleted without a choice is skipped, never 'applied'", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "skip" } });
    assert.equal(out.results[0].status, "skipped");
    assert.equal(out.results[0].code, "no_resolution");
    assert.deepEqual(ctx.writes, []);
  });

  it("converged goals only get a mapping bookkeeping write: no Google write, no goal write", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-12"), goal("g2", "Read chapter 3", "2026-10-11")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    assert.equal(preview.items.length, 1);
    assert.equal(preview.converged.length, 1);
    const { deps, writes } = makeDeps(world);

    const out = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: [] });
    assert.equal(out.bookkeeping, 1);
    assert.deepEqual(writes.map((w) => w.op), ["saveMapping"]);
  });
});

describe("applyCalendarSync — one-time plan token (Z3 item 6)", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-apply-secret"; });

  it("replaying the same plan token is rejected and nothing is written", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [],
      mappings: [],
    };
    const preview = previewOf(world);
    const ctx = makeDeps(world);

    const first = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(first.results[0].status, "applied");

    const writesAfterFirst = ctx.writes.length;
    await assert.rejects(
      applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) }),
      /already applied/i,
    );
    assert.equal(ctx.writes.length, writesAfterFirst, "a replayed token must not write anything");
  });
});

describe("applyCalendarSync — Z4 writers", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-apply-secret"; });

  it("remote_deleted + unlink saves an 'unlinked' mapping and writes nothing else; the next plan is empty", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "unlink" } });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.map((w) => w.op), ["saveMapping"]);
    assert.equal(ctx.saved[0].status, "unlinked");
    assert.equal(ctx.saved[0].base, null);

    world.mappings = [{ ...mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" }), calendar: { ...mapping("g1", { title: "x", targetDate: "2026-10-10" }).calendar!, status: "unlinked" } }];
    assert.equal(previewOf(world).items.length, 0);
  });

  it("remote_deleted + recreate restores the event with a patch (If-Match) and needs no destructive confirmation", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    ctx.deps.client.insertEvent = async () => { throw new GoogleCalendarApiError(409, "exists"); };
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "recreate" } });
    assert.equal(out.results[0].status, "applied");
    const patch = ctx.writes.find((w) => w.op === "patch")!.detail as { ifMatch: string };
    assert.equal(patch.ifMatch, world.events[0].etag);
  });

  it("remote_deleted + delete_goal is refused without the separate confirmation, and writes nothing", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "delete_goal" } });
    assert.equal(out.results[0].status, "skipped");
    assert.equal(out.results[0].code, "destructive_not_confirmed");
    assert.deepEqual(ctx.writes, []);
  });

  it("remote_deleted + delete_goal with the confirmation deletes the goal (guarded) and nothing in Google", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "delete_goal" }, confirmedDestructive: [itemId] });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.map((w) => w.op), ["deleteGoal"]);
  });

  it("delete_goal on a goal edited meanwhile is skipped as goal_changed", async () => {
    const world = deletedWorld();
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world, { pull: "changed" });
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "delete_goal" }, confirmedDestructive: [itemId] });
    assert.equal(out.results[0].code, "goal_changed");
  });

  it("pull_create imports ONE new goal from the event, links it, and never writes to Google", async () => {
    const world: World = { goals: [], events: [{ id: "abc123foreign", etag: '"e1"', status: "confirmed", summary: "✓ Team lunch", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } }], mappings: [] };
    const preview = previewOf(world);
    assert.equal(preview.items[0].kind, "pull_create");
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [preview.items[0].itemId] });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.created, [{ title: "Team lunch", targetDate: "2026-10-20", eventId: "abc123foreign" }]);
    assert.equal(ctx.writes.filter((w) => w.op === "patch" || w.op === "insert").length, 0);
  });

  it("pull_create with 'ignore' records the ignore and creates no goal; the next plan stays quiet", async () => {
    const world: World = { goals: [], events: [{ id: "abc123foreign", etag: '"e1"', status: "confirmed", summary: "Team lunch", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } }], mappings: [] };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "ignore" } });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.map((w) => w.op), ["ignore"]);
    assert.equal(previewOf(world, ctx.ignored).items.length, 0);
  });

  it("an attention item is never applied; only 'ignore' on an event-only item does anything", async () => {
    const timed = { id: "timed1", etag: '"e1"', status: "confirmed", summary: "Dentist", start: { dateTime: "2026-10-10T09:00:00+06:00" }, end: { dateTime: "2026-10-10T10:00:00+06:00" } };
    const world: World = { goals: [], events: [timed], mappings: [] };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;

    let ctx = makeDeps(world);
    let out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId] });
    assert.equal(out.results[0].code, "needs_attention");
    assert.deepEqual(ctx.writes, []);

    ctx = makeDeps(world);
    out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "ignore" } });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.map((w) => w.op), ["ignore"]);
  });

  it("completing a goal patches the event with the ✓ prefix and records completed in the base", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10", true)],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10", completed: false })],
    };
    const preview = previewOf(world);
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [preview.items[0].itemId] });
    assert.equal(out.results[0].status, "applied");
    const patch = ctx.writes.find((w) => w.op === "patch")!.detail as { updates: CalendarEventPayload };
    assert.equal(patch.updates.summary, "✓ Read chapter 2");
    assert.equal(ctx.saved[0].base!.completed, true);
    assert.equal(ctx.writes.filter((w) => w.op === "pullGoal").length, 0);
  });

  it("a mixed item (title from Google, date from Study Lamp) patches Google first, then updates only the title on the goal", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2b", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [preview.items[0].itemId] });
    assert.equal(out.results[0].status, "applied");
    assert.deepEqual(ctx.writes.map((w) => w.op), ["patch", "pullGoal"]);
    const pulled = ctx.writes.find((w) => w.op === "pullGoal")!.detail as { updates: object };
    assert.deepEqual(pulled.updates, { title: "Read chapter 2b" });
    const patch = ctx.writes.find((w) => w.op === "patch")!.detail as { updates: CalendarEventPayload };
    assert.deepEqual(patch.updates.start, { date: "2026-10-14" });
    assert.equal(patch.updates.summary, "Read chapter 2b");
  });

  it("conflict, resolved PER FIELD: title from Google, date from Study Lamp", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2b", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    assert.equal(preview.items[0].kind, "conflict");
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [`${itemId}:title`]: "use_google", [`${itemId}:targetDate`]: "use_study_lamp" } });
    assert.equal(out.results[0].status, "applied");
    const pulled = ctx.writes.find((w) => w.op === "pullGoal")!.detail as { updates: object };
    assert.deepEqual(pulled.updates, { title: "Read chapter 2b" });
    assert.equal(ctx.writes.filter((w) => w.op === "patch").length, 1);
  });

  it("a conflicting field left on 'skip' stays untouched on both sides and the conflict remains", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2b", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [`${itemId}:title`]: "use_google", [`${itemId}:targetDate`]: "skip" } });
    assert.equal(out.results[0].status, "applied");
    assert.equal(ctx.writes.filter((w) => w.op === "patch").length, 0, "the skipped date must not be pushed");
    assert.deepEqual((ctx.writes.find((w) => w.op === "pullGoal")!.detail as { updates: object }).updates, { title: "Read chapter 2b" });
    // The base keeps its OLD date, so the date conflict shows up again next time.
    assert.equal(ctx.saved[0].base!.targetDate, "2026-10-10");
  });

  it("every field of a conflict on 'skip' writes nothing and is reported missing_resolution", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [`${itemId}:targetDate`]: "skip" } });
    assert.equal(out.results[0].code, "missing_resolution");
    assert.deepEqual(ctx.writes, []);
  });

  it("pulling a date also works when the user edited ONLY the title locally afterwards: the item is stale, nothing written", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    world.goals = [goal("g1", "Edited locally", "2026-10-10")];
    const ctx = makeDeps(world);
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [preview.items[0].itemId] });
    assert.equal(out.results[0].status, "stale");
    assert.deepEqual(ctx.writes, []);
  });

  it("writes a history entry per decision with goal-level fields only; not-accepted items are not logged", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-14"), goal("g2", "Other", "2026-10-15")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const update = preview.items.find((i) => i.goalId === "g1")!;
    const ctx = makeDeps(world);
    await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [update.itemId] });
    assert.equal(ctx.logs.length, 1);
    const entry = ctx.logs[0];
    assert.equal(entry.scope, "calendar");
    assert.equal(entry.result, "applied");
    assert.equal(entry.direction, "study_lamp_to_google");
    assert.deepEqual(Object.keys(entry).sort(), ["at", "completedSnapshot", "direction", "fields", "goalId", "itemKind", "result", "scope", "targetDateSnapshot", "titleSnapshot"]);
  });

  it("a failing history write never changes the outcome", async () => {
    const world: World = { goals: [goal("g1", "Read chapter 2", "2026-10-10")], events: [], mappings: [] };
    const preview = previewOf(world);
    const ctx = makeDeps(world);
    ctx.deps.log = async () => { throw new Error("firestore down"); };
    const out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [preview.items[0].itemId] });
    assert.equal(out.results[0].status, "applied");
  });
});

describe("validateGoalFieldPull / resolveGoalUpdate", () => {
  it("rejects blank or overlong titles and invalid dates", () => {
    assert.equal(validateGoalFieldPull({ title: "  " }), "invalid_remote_value");
    assert.equal(validateGoalFieldPull({ title: "x".repeat(501) }), "invalid_remote_value");
    assert.equal(validateGoalFieldPull({ targetDate: "2026-02-31" }), "invalid_remote_value");
    assert.equal(validateGoalFieldPull({ title: "ok", targetDate: "2026-10-10" }), null);
  });
});
