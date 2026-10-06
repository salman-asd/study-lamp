import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Goal } from "@/types";
import { addDaysToIsoDate } from "@/lib/isoDate";
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
    // Google ends an all-day event on the NEXT day.
    end: { date: addDaysToIsoDate(date, 1) },
    extendedProperties: { private: { studylampGoalId: goalId, uid: UID } },
    ...extra,
  };
}

function mappingFor(goalId: string, base: { title: string; targetDate: string; completed?: boolean }, extra: { calendarId?: string; eventId?: string; status?: "synced" | "unlinked" } = {}): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: base.title,
    calendar: {
      connectionId: "conn-1",
      calendarId: extra.calendarId ?? CAL,
      eventId: extra.eventId ?? buildCalendarEventId(UID, goalId),
      remoteEtag: null,
      base: { title: base.title, targetDate: base.targetDate, completed: base.completed ?? false },
      hash: null,
      status: extra.status ?? "synced",
      lastSyncAt: null,
      lastErrorCode: null,
    },
  };
}

function plan(goals: Goal[], events: LiveCalendarEvent[], mappings: GoalSyncMapping[] = [], extra: { ignored?: string[]; goalIds?: string[] } = {}) {
  return buildGoalSyncPlan({
    uid: UID,
    calendarId: CAL,
    goals,
    liveEvents: events,
    mappings: new Map(mappings.map((m) => [m.goalId, m])),
    ignoredRemoteIds: new Set(extra.ignored ?? []),
    goalIds: extra.goalIds,
  });
}

/** An event nobody at Study Lamp made: no private marker, a random Google id. */
function foreignEvent(id: string, title: string, date: string, extra: Partial<LiveCalendarEvent> = {}): LiveCalendarEvent {
  return { id, etag: `"etag-${id}"`, status: "confirmed", summary: title, start: { date }, end: { date: addDaysToIsoDate(date, 1) }, ...extra };
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
    // No direction: the user picks a side per field. Both values travel with the field.
    assert.deepEqual(result.items[0].fields, [{ name: "targetDate", before: "2026-10-14", after: "2026-10-12", local: "2026-10-14", remote: "2026-10-12" }]);
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

  it("a cancelled event becomes a remote_deleted item", () => {
    const result = plan(
      [goal("g1", "Read chapter 2", "2026-10-10")],
      [liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" })],
      [mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" })],
    );
    assert.equal(result.items[0].kind, "remote_deleted");
    // Destructive only for the "delete the goal here" CHOICE (enforced by the gate), not for unlink or recreate.
    assert.equal(result.items[0].risk, "normal");
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
      listLiveEvents: async () => ({ events: [liveEvent("g2", "Read chapter 3", "2026-10-13"), foreignEvent("abc123foreign", "Team lunch", "2026-10-20")], truncated }),
      listIgnoredRemoteIds: async () => new Set<string>(),
      ignoreRemote: async () => { writes.push("ignoreRemote"); },
      createGoalFromEvent: async () => { writes.push("createGoalFromEvent"); },
      deleteGoal: async () => { writes.push("deleteGoal"); },
      saveMapping: async () => { writes.push("saveMapping"); },
      saveCalendarMapping: async () => { writes.push("saveCalendarMapping"); },
      insertEvent: async () => { writes.push("insertEvent"); },
      patchEvent: async () => { writes.push("patchEvent"); },
      deleteEvent: async () => { writes.push("deleteEvent"); },
      pullGoalFields: async () => { writes.push("pullGoalFields"); },
      touchLastCheck: async () => { writes.push("touchLastCheck"); },
    };
    return { reader: reader as unknown as CalendarPlanReader, writes };
  }

  it("performs zero writes (Rule 15)", async () => {
    const { reader, writes } = recordingReader();
    const result = await planCalendarSync(reader, { uid: UID, calendarId: CAL });
    assert.deepEqual(result.items.map((i) => i.kind).sort(), ["pull_create", "pull_update", "push_create"]);
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

describe("goalSyncPlan — Z4 item kinds", () => {
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret"; });
  const synced = (id: string, title: string, date: string, completed = false) => mappingFor(id, { title, targetDate: date, completed });

  it("completing a goal proposes ONE push_update that adds the ✓ (completed is Study Lamp -> Google)", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10", true)], [liveEvent("g1", "Read chapter 2", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10", false)]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "push_update");
    assert.deepEqual(result.items[0].fields, [{ name: "completed", before: false, after: true, direction: "study_lamp" }]);
  });

  it("a ✓ removed in Google never re-opens the goal and proposes nothing", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10", true)], [liveEvent("g1", "Read chapter 2", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10", true)]);
    assert.equal(result.items.length, 0);
  });

  it("a ✓ added in Google never completes the goal and proposes nothing", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10", false)], [liveEvent("g1", "✓ Read chapter 2", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10", false)]);
    assert.equal(result.items.length, 0);
  });

  it("a long title is not mistaken for a Google-side change", () => {
    const long = "L".repeat(300);
    const result = plan([goal("g1", long, "2026-10-10")], [liveEvent("g1", "L".repeat(200), "2026-10-10")], [synced("g1", long, "2026-10-10")]);
    assert.equal(result.items.length, 0);
  });

  it("title changed in Google and date changed in Study Lamp is ONE item with a direction per field", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-14")], [liveEvent("g1", "Read chapter 2b", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10")]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "pull_update");
    assert.deepEqual(result.items[0].fields.map((f) => [f.name, f.direction]), [["title", "google"], ["targetDate", "study_lamp"]]);
  });

  it("only the conflicting field has no direction; the other field keeps its own", () => {
    const result = plan([goal("g1", "Read chapter 2", "2026-10-14")], [liveEvent("g1", "Read chapter 2b", "2026-10-12")], [synced("g1", "Read chapter 2", "2026-10-10")]);
    assert.equal(result.items[0].kind, "conflict");
    const date = result.items[0].fields.find((f) => f.name === "targetDate")!;
    assert.equal(date.direction, undefined);
    assert.deepEqual([date.local, date.remote], ["2026-10-14", "2026-10-12"]);
  });

  it("a timed event in the Study Lamp calendar is an attention item with a reason, not an import", () => {
    const timed = foreignEvent("timed1", "Dentist", "2026-10-10", { start: { dateTime: "2026-10-10T09:00:00+06:00" }, end: { dateTime: "2026-10-10T10:00:00+06:00" } });
    const result = plan([], [timed]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "attention");
    assert.equal(result.items[0].reason, "timed");
    assert.equal(result.items[0].goalId, null);
    assert.equal(result.counts.attention, 1);
  });

  it("an unmarked all-day event becomes a pull_create (import as goal)", () => {
    const result = plan([], [foreignEvent("abc123foreign", "Team lunch", "2026-10-20")]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, "pull_create");
    assert.equal(result.items[0].title, "Team lunch");
    assert.equal(result.items[0].remoteId, "abc123foreign");
    assert.equal(result.items[0].goalId, null);
  });

  it("an ignored event is never offered again, as an import or as attention", () => {
    const timed = foreignEvent("timed1", "Dentist", "2026-10-10", { start: { dateTime: "2026-10-10T09:00:00+06:00" }, end: { dateTime: "2026-10-10T10:00:00+06:00" } });
    const result = plan([], [foreignEvent("abc123foreign", "Team lunch", "2026-10-20"), timed], [], { ignored: ["abc123foreign", "timed1"] });
    assert.equal(result.items.length, 0);
  });

  it("an event that belongs to a goal is never offered as an import, even on a partial plan", () => {
    const g1 = goal("g1", "Read chapter 2", "2026-10-10");
    const full = plan([g1], [liveEvent("g1", "Read chapter 2", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10")]);
    assert.equal(full.items.length, 0);
    const odd = liveEvent("g1", "Read chapter 2", "2026-10-10", { id: "someothereventid123" });
    const partial = plan([g1, goal("g2", "Other", "2026-10-11")], [odd], [], { goalIds: ["g2"] });
    assert.equal(partial.items.some((i) => i.kind === "pull_create"), false);
  });

  it("a partial plan (goalIds) proposes no imports and reports no orphans", () => {
    const result = plan([goal("g1", "A", "2026-10-10")], [foreignEvent("abc123foreign", "Team lunch", "2026-10-20")], [synced("gone", "Deleted goal", "2026-10-01")], { goalIds: ["g1"] });
    assert.deepEqual(result.items.map((i) => i.kind), ["push_create"]);
    assert.equal(result.counts.orphaned, 0);
  });

  it("an event Study Lamp made for a goal that no longer exists is left alone (not imported)", () => {
    const result = plan([], [liveEvent("deleted-goal", "Old goal", "2026-10-10")]);
    assert.equal(result.items.length, 0);
  });

  it("a cancelled foreign event is history, not an item", () => {
    assert.equal(plan([], [foreignEvent("abc123foreign", "Team lunch", "2026-10-20", { status: "cancelled" })]).items.length, 0);
  });

  it("a mapping without a goal is reported as an orphan, never as an item", () => {
    const result = plan([], [], [synced("gone", "Deleted goal", "2026-10-01")]);
    assert.equal(result.items.length, 0);
    assert.equal(result.counts.orphaned, 1);
    assert.deepEqual(result.orphans.map((o) => o.goalId), ["gone"]);
  });

  it("an unlinked goal is skipped while Google has no live event, and resumes when the event is back", () => {
    const g1 = goal("g1", "Read chapter 2", "2026-10-10");
    const unlinked = mappingFor("g1", { title: "Read chapter 2", targetDate: "2026-10-10" }, { status: "unlinked" });
    assert.equal(plan([g1], [], [unlinked]).items.length, 0);
    assert.equal(plan([g1], [liveEvent("g1", "Read chapter 2", "2026-10-10", { status: "cancelled" })], [unlinked]).items.length, 0);
    const restored = plan([g1], [liveEvent("g1", "Read chapter 2 (restored)", "2026-10-10")], [unlinked]);
    assert.equal(restored.items.length, 1);
  });

  it("a multi-day event for a goal is attention (multi_day), never guessed into a date", () => {
    const multi = liveEvent("g1", "Read chapter 2", "2026-10-10", { end: { date: "2026-10-14" } });
    const result = plan([goal("g1", "Read chapter 2", "2026-10-10")], [multi], [synced("g1", "Read chapter 2", "2026-10-10")]);
    assert.equal(result.items[0].kind, "attention");
    assert.equal(result.items[0].reason, "multi_day");
  });

  it("a goal whose date was removed locally but still has an event is attention (goal_has_no_date)", () => {
    const result = plan([goal("g1", "Read chapter 2", null)], [liveEvent("g1", "Read chapter 2", "2026-10-10")], [synced("g1", "Read chapter 2", "2026-10-10")]);
    assert.equal(result.items[0].reason, "goal_has_no_date");
  });

  it("Study Lamp's own write does not come back as a change on the next plan", () => {
    // After apply: the event holds what the goal holds and the base matches.
    const g1 = goal("g1", "Read chapter 2", "2026-10-14", true);
    const result = plan([g1], [liveEvent("g1", "✓ Read chapter 2", "2026-10-14")], [synced("g1", "Read chapter 2", "2026-10-14", true)]);
    assert.equal(result.items.length, 0);
    assert.equal(result.converged.length, 0);
  });
});
