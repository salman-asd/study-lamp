import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Goal } from "@/types";
import { PlanTokenVerificationError } from "./planToken";
import { buildCalendarEventId, GoogleCalendarApiError, type CalendarEventPayload, type GoogleCalendarEventLike } from "./googleCalendar";
import { buildGoalSyncPlan, type LiveCalendarEvent } from "./goalSyncPlan";
import { applyCalendarSync, type CalendarApplyDeps, type GoalPullResult } from "./goalSyncApply";
import type { GoalSyncMapping, SyncBase } from "./googleSyncMapping";

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
    end: { date },
    extendedProperties: { private: { studylampGoalId: goalId, uid: UID } },
    ...extra,
  };
}

function mapping(goalId: string, base: { title: string; targetDate: string }): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: base.title,
    calendar: { connectionId: "conn-1", calendarId: CAL, eventId: buildCalendarEventId(UID, goalId), remoteEtag: null, base: { ...base, completed: false }, hash: null, status: "synced", lastSyncAt: null, lastErrorCode: null },
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
  const saved: Array<{ goalId: string; eventId: string; base: SyncBase; remoteEtag: string | null }> = [];
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
      saved.push({ goalId, eventId: input.eventId, base: input.base, remoteEtag: input.remoteEtag });
    },
    recordError: async (goalId, code) => { errors.push({ goalId, code }); },
    pullGoalFields: async (goalId, _expected, updates) => {
      writes.push({ op: "pullGoal", detail: { goalId, updates } });
      return options.pull ?? "ok";
    },
  };
  return { deps, writes, saved, errors, usedTokens };
}

function previewOf(world: World) {
  return buildGoalSyncPlan({ uid: UID, calendarId: CAL, goals: world.goals, liveEvents: world.events, mappings: new Map(world.mappings.map((m) => [m.goalId, m])) });
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
    assert.equal(saved[0].base.targetDate, "2026-10-10");

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
    assert.equal(saved[0].base.targetDate, "2026-10-12");
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

  it("a pull of an invalid value (empty title) is skipped, not written", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "   ", "2026-10-10")],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const { deps, writes } = makeDeps(world);
    const { results } = await applyCalendarSync(deps, { planToken: preview.planToken, accepted: preview.items.map((i) => i.itemId) });
    assert.equal(results[0].code, "invalid_remote_value");
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

  it("remote_deleted needs the destructive confirmation; an unsupported choice is skipped, never 'applied'", async () => {
    const world: World = {
      goals: [goal("g1", "Read chapter 2", "2026-10-10")],
      events: [liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" })],
      mappings: [mapping("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    };
    const preview = previewOf(world);
    const itemId = preview.items[0].itemId;

    let ctx = makeDeps(world);
    let out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "use_study_lamp" } });
    assert.equal(out.results[0].code, "destructive_not_confirmed");
    assert.deepEqual(ctx.writes, []);

    ctx = makeDeps(world);
    out = await applyCalendarSync(ctx.deps, { planToken: preview.planToken, accepted: [itemId], resolutions: { [itemId]: "skip" }, confirmedDestructive: [itemId] });
    assert.equal(out.results[0].status, "skipped");
    assert.equal(out.results[0].code, "unsupported_resolution");
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
