import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Goal } from "@/types";
import { buildCalendarEventId } from "./googleCalendar";
import {
  buildGoalSyncPlan,
  CalendarListTruncatedError,
  planCalendarSync,
  type CalendarPlanReader,
  type LiveCalendarEvent,
} from "./goalSyncPlan";
import type { GoalSyncMapping } from "./googleSyncMapping";

const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;
const UID = "user-1";
const CAL = "cal-abc@group.calendar.google.com";

function goal(id: string, title: string, targetDate: string | null, completed = false): Goal {
  return { id, title, targetDate, completed } as Goal;
}

/** A live event shaped like Google returns it: the hashed id, an etag, our private marker. */
function liveEvent(goalId: string, title: string, date: string, extra: Partial<LiveCalendarEvent> = {}): LiveCalendarEvent {
  return {
    id: buildCalendarEventId(UID, goalId),
    etag: `"etag-${date}"`,
    status: "confirmed",
    summary: title,
    start: { date },
    end: { date },
    extendedProperties: { private: { studylampGoalId: goalId, uid: UID } },
    ...extra,
  };
}

function mappingFor(goalId: string, base: { title: string; targetDate: string }, extra: { calendarId?: string; eventId?: string } = {}): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: base.title,
    calendar: {
      connectionId: "conn-1",
      calendarId: extra.calendarId ?? CAL,
      eventId: extra.eventId ?? buildCalendarEventId(UID, goalId),
      remoteEtag: null,
      base: { ...base, completed: false },
      hash: null,
      status: "synced",
      lastSyncAt: null,
      lastErrorCode: null,
    },
  };
}

function plan(goals: Goal[], events: LiveCalendarEvent[], mappings: GoalSyncMapping[] = []) {
  return buildGoalSyncPlan({ uid: UID, calendarId: CAL, goals, liveEvents: events, mappings: new Map(mappings.map((m) => [m.goalId, m])) });
}

describe("goalSyncPlan (realistic ids)", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret"; });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
    else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  });

  it("proposes push_create for a goal with no event and no mapping", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], []);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "push_create");
    assert.equal(result.items[0].remoteId, buildCalendarEventId(UID, "g1"));
  });

  it("proposes nothing for a goal without a date and without an event", () => {
    assert.equal(plan([goal("g1", "No date", null)], []).items.length, 0);
  });

  it("an already-synced goal with the real hashed event id produces NO item (B5)", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items.length, 0);
    assert.equal(result.converged.length, 0);
  });

  it("a Google-side date change becomes pull_update with before = current goal value, after = Google's (B4)", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.kind, "pull_update");
    assert.deepEqual(item.fields, [{ name: "targetDate", before: "2026-10-10", after: "2026-10-12", direction: "google" }]);
    assert.equal(result.counts.pull, 1);
  });

  it("a Study Lamp-side date change becomes push_update that overwrites Google's current value", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-14")],
      [liveEvent("g1", "Read chapter 2", "2026-10-10")],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items[0].kind, "push_update");
    assert.deepEqual(result.items[0].fields, [{ name: "targetDate", before: "2026-10-10", after: "2026-10-14", direction: "study_lamp" }]);
  });

  it("the same change on both sides is converged, not an item", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-12")],
      [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items.length, 0);
    assert.equal(result.converged.length, 1);
    assert.deepEqual(result.converged[0].base, { title: "Read chapter 2", targetDate: "2026-10-12", completed: false });
  });

  it("different changes on both sides are a conflict carrying both values", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-14")],
      [liveEvent("g1", "Read chapter 2", "2026-10-12")],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items[0].kind, "conflict");
    assert.deepEqual(result.items[0].fields, [{ name: "targetDate", before: "2026-10-12", after: "2026-10-14", direction: "study_lamp" }]);
    assert.equal(result.counts.conflict, 1);
  });

  it("finds the event by its marker when the mapping is missing and the id is not the deterministic one", () => {
    const odd = liveEvent("g1", "Read chapter 2", "2026-10-10", { id: "someothereventid123" });
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], [odd]);
    assert.equal(result.items.length, 0, "must not propose push_create for a goal that already has an event");
    assert.equal(result.converged[0].eventId, "someothereventid123");
  });

  it("with no mapping, a differing event is a conflict (no base to decide from)", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], [liveEvent("g1", "Read chapter 2", "2026-10-12")]);
    assert.equal(result.items[0].kind, "conflict");
  });

  it("never matches on the bare goal id", () => {
    const stray = liveEvent("g1", "Read chapter 2", "2026-10-10", { id: "g1", extendedProperties: null });
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], [stray]);
    assert.equal(result.items[0].kind, "push_create");
  });

  it("ignores a mapping made for a different calendar", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" }, { calendarId: "old-calendar" })],
    );
    assert.equal(result.items[0].kind, "push_create");
  });

  it("a cancelled event becomes a destructive remote_deleted item", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" })],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items[0].kind, "remote_deleted");
    assert.equal(result.items[0].risk, "destructive");
    assert.equal(result.counts.remoteDeleted, 1);
  });

  it("a mapped goal whose event is gone entirely is remote_deleted", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], [], [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })]);
    assert.equal(result.items[0].kind, "remote_deleted");
  });

  it("a remote event without a usable date is an attention item", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [liveEvent("g1", "Read chapter 2", "2026-10-10", { start: {}, end: {} })],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items[0].kind, "attention");
  });

  it("changing the local date after the preview changes a pull item's fingerprint (B10)", () => {
    const events = [liveEvent("g1", "New title from Google", "2026-10-10")];
    const mappings = [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })];
    const before = plan([goal("g1", "Read chapter 2", "2026-10-10")], events, mappings).items[0];
    // Same title pull, but the goal's date changed locally after the preview.
    const after = plan([goal("g1", "Read chapter 2", "2026-10-11")], events, mappings).items[0];
    assert.equal(before.kind, "pull_update");
    assert.notEqual(before.fingerprint, after.fingerprint);
  });

  it("changing the live etag changes the fingerprint", () => {
    const mappings = [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })];
    const a = plan([goal("g1", "Read chapter 2", "2026-10-10")], [liveEvent("g1", "Read chapter 2", "2026-10-12", { etag: '"v1"' })], mappings).items[0];
    const b = plan([goal("g1", "Read chapter 2", "2026-10-10")], [liveEvent("g1", "Read chapter 2", "2026-10-12", { etag: '"v2"' })], mappings).items[0];
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

describe("planCalendarSync (preview use-case)", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret"; });

  /** A reader that ALSO carries write methods, all recording. The plan must never call them. */
  function recordingReader(truncated = false) {
    const writes: string[] = [];
    const reader = {
      listGoals: async () => [goal("g1", "Read chapter 2", "2026-10-10"), goal("g2", "Read chapter 3", "2026-10-11")],
      listMappings: async () => new Map([["g2", mappingFor("g2", { title: "Read chapter 3", targetDate: "2026-10-11" })]]),
      listLiveEvents: async () => ({ events: [liveEvent("g2", "Read chapter 3", "2026-10-13")], truncated }),
      saveMapping: async () => { writes.push("saveMapping"); },
      saveCalendarMapping: async () => { writes.push("saveCalendarMapping"); },
      insertEvent: async () => { writes.push("insertEvent"); },
      patchEvent: async () => { writes.push("patchEvent"); },
      deleteEvent: async () => { writes.push("deleteEvent"); },
      pullGoalFields: async () => { writes.push("pullGoalFields"); },
      touchLastCheck: async () => { writes.push("touchLastCheck"); },
    };
    return { reader: reader as CalendarPlanReader, writes };
  }

  it("performs zero writes (Rule 15)", async () => {
    const { reader, writes } = recordingReader();
    const result = await planCalendarSync(reader, { uid: UID, calendarId: CAL });
    assert.deepEqual(result.items.map((i) => i.kind).sort(), ["pull_update", "push_create"]);
    assert.deepEqual(writes, []);
  });

  it("refuses to plan from a truncated event list", async () => {
    const { reader } = recordingReader(true);
    await assert.rejects(planCalendarSync(reader, { uid: UID, calendarId: CAL }), CalendarListTruncatedError);
  });

  it("the planner module imports no write function", () => {
    const source = readFileSync(new URL("./goalSyncPlan.ts", import.meta.url), "utf8");
    for (const forbidden of ["insertEvent", "patchEvent", "deleteEvent", "createCalendar", "createCalendarClient", "googleSyncState", "saveCalendarMapping", "firebase-admin"]) {
      assert.ok(!source.includes(forbidden), `goalSyncPlan.ts must not reference ${forbidden}`);
    }
  });
});
