import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeSyncCounts, listOrphanMappings, mappingRemovalAction, parseGoalSyncMapping, type GoalSyncMapping } from "./googleSyncMapping";

const CAL = "cal-abc@group.calendar.google.com";

function mapping(goalId: string, status: "synced" | "failed" | "unlinked" | "remote_deleted", calendarId = CAL): GoalSyncMapping {
  return {
    goalId,
    titleSnapshot: goalId,
    calendar: { connectionId: "c1", calendarId, eventId: `e-${goalId}`, remoteEtag: null, base: null, hash: null, status, lastSyncAt: null, lastErrorCode: null },
  };
}

describe("computeSyncCounts", () => {
  it("counts from mapping and goal docs only", () => {
    const mappings = new Map([
      ["g1", mapping("g1", "synced")],
      ["g2", mapping("g2", "failed")],
      ["g3", mapping("g3", "unlinked")],
      ["gone", mapping("gone", "synced")],
      ["other-cal", mapping("other-cal", "synced", "old-calendar")],
    ]);
    const goals = [
      { id: "g1", targetDate: "2026-10-10" },
      { id: "g2", targetDate: "2026-10-11" },
      { id: "g3", targetDate: "2026-10-12" },
      { id: "g4", targetDate: null },
      { id: "g5", targetDate: "not-a-date" },
      { id: "other-cal", targetDate: "2026-10-13" },
    ];
    assert.deepEqual(computeSyncCounts({ mappings, goals, calendarId: CAL }), { synced: 1, failed: 1, remoteDeleted: 0, unlinked: 1, noDate: 2, orphaned: 1 });
  });

  it("returns zeros when no calendar is set", () => {
    assert.deepEqual(computeSyncCounts({ mappings: new Map(), goals: [], calendarId: null }), { synced: 0, failed: 0, remoteDeleted: 0, unlinked: 0, noDate: 0, orphaned: 0 });
  });
});

describe("parseGoalSyncMapping", () => {
  it("keeps the 'unlinked' status", () => {
    const parsed = parseGoalSyncMapping("g1", { titleSnapshot: "T", calendar: { connectionId: "c", calendarId: CAL, eventId: "e", status: "unlinked" } });
    assert.equal(parsed?.calendar?.status, "unlinked");
  });
});

describe("mappingRemovalAction (audit M1)", () => {
  it("keeps the Tasks link when the Calendar link is removed", () => {
    assert.equal(mappingRemovalAction({ calendar: { eventId: "e" }, tasks: { taskId: "t" } }, "calendar"), "delete_block");
  });

  it("keeps the Calendar link when the Tasks link is removed", () => {
    assert.equal(mappingRemovalAction({ calendar: { eventId: "e" }, tasks: { taskId: "t" } }, "tasks"), "delete_block");
  });

  it("deletes the whole doc when nothing else lives in it", () => {
    assert.equal(mappingRemovalAction({ calendar: { eventId: "e" } }, "calendar"), "delete_doc");
    assert.equal(mappingRemovalAction({ tasks: { taskId: "t" } }, "tasks"), "delete_doc");
  });

  it("does nothing for a missing doc", () => {
    assert.equal(mappingRemovalAction(undefined, "calendar"), "none");
  });
});

describe("listOrphanMappings (W5)", () => {
  const tasksOnly = (goalId: string, listId: string): GoalSyncMapping => ({
    goalId,
    titleSnapshot: `Task goal ${goalId}`,
    calendar: null,
    tasks: { connectionId: "c1", listId, taskId: `t-${goalId}`, remoteEtag: null, base: null, notesHash: null, hash: null, status: "synced", creatingAt: null, lastSyncAt: null, lastErrorCode: null },
  });

  it("lists mappings whose goal is gone, for one calendar only, sorted and with the title snapshot", () => {
    const mappings = new Map([
      ["b-gone", mapping("b-gone", "synced")],
      ["a-gone", mapping("a-gone", "failed")],
      ["live", mapping("live", "synced")],
      ["old-cal", mapping("old-cal", "synced", "old-calendar")],
    ]);
    const result = listOrphanMappings({ mappings, goalIds: new Set(["live"]), block: "calendar", containerId: CAL });
    assert.deepEqual(result, [{ goalId: "a-gone", titleSnapshot: "a-gone" }, { goalId: "b-gone", titleSnapshot: "b-gone" }]);
  });

  it("is per service: a tasks-only mapping is not a calendar orphan", () => {
    const mappings = new Map([["x", tasksOnly("x", "L1")]]);
    assert.deepEqual(listOrphanMappings({ mappings, goalIds: new Set(), block: "calendar", containerId: CAL }), []);
    assert.equal(listOrphanMappings({ mappings, goalIds: new Set(), block: "tasks", containerId: "L1" }).length, 1);
  });

  it("returns nothing without a container and caps the list at 50", () => {
    const many = new Map(Array.from({ length: 80 }, (_, i) => [`g${String(i).padStart(3, "0")}`, mapping(`g${String(i).padStart(3, "0")}`, "synced")] as const));
    assert.deepEqual(listOrphanMappings({ mappings: many, goalIds: new Set(), block: "calendar", containerId: null }), []);
    assert.equal(listOrphanMappings({ mappings: many, goalIds: new Set(), block: "calendar", containerId: CAL }).length, 50);
  });
});
