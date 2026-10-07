import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTask, buildTaskNotes, completionPatch, dueFromDate, notesFingerprint, parseTaskMarker, taskMarker, taskToGoalFields, TASK_NOTES_MAX } from "./tasksGoalMapping";

describe("tasksGoalMapping", () => {
  it("marker round-trips and is the last line of the notes", () => {
    const notes = buildTaskNotes({ id: "goal_A-1", notes: "Read ch. 3", priority: "high" });
    assert.equal(notes.split("\n").pop(), "[studylamp:goal_A-1]");
    assert.equal(parseTaskMarker(notes), "goal_A-1");
    assert.match(notes, /Priority: high/);
    assert.equal(parseTaskMarker("no marker here"), null);
    assert.equal(taskMarker("x"), "[studylamp:x]");
  });

  it("keeps the marker when the notes are huge", () => {
    const notes = buildTaskNotes({ id: "g1", notes: "x".repeat(20_000), priority: "low" });
    assert.ok(notes.length <= TASK_NOTES_MAX);
    assert.equal(parseTaskMarker(notes), "g1");
  });

  it("due is midnight UTC only for a valid date", () => {
    assert.equal(dueFromDate("2026-03-05"), "2026-03-05T00:00:00.000Z");
    assert.equal(dueFromDate("2026-02-30"), null);
    assert.equal(dueFromDate(null), null);
  });

  it("buildTask: open goal sends needsAction AND completed null; done goal sends completed", () => {
    const open = buildTask({ id: "g", title: " Learn ", targetDate: "2026-03-05", completed: false });
    assert.equal(open.status, "needsAction");
    assert.equal(open.completed, null);
    assert.equal(open.title, "Learn");
    const done = buildTask({ id: "g", title: "Learn", completed: true });
    assert.equal(done.status, "completed");
    assert.equal("completed" in done, false);
    assert.equal(done.due, null);
    assert.deepEqual(completionPatch(false), { status: "needsAction", completed: null });
    assert.deepEqual(completionPatch(true), { status: "completed" });
  });

  it("taskToGoalFields: due -> date, status -> completed, notes are never read", () => {
    const ok = taskToGoalFields({ id: "t", title: " Learn ", due: "2026-03-05T00:00:00.000Z", status: "completed", notes: "[studylamp:g]\nPriority: high" });
    assert.deepEqual(ok, { title: "Learn", targetDate: "2026-03-05", completed: true });
    assert.deepEqual(taskToGoalFields({ id: "t", title: "A" }), { title: "A", targetDate: null, completed: false });
  });

  it("taskToGoalFields: attention reasons", () => {
    assert.equal(taskToGoalFields({ title: "A", deleted: true }).attention, "cancelled");
    assert.equal(taskToGoalFields({ title: "  " }).attention, "empty_title");
    assert.equal(taskToGoalFields({ title: "x".repeat(501) }).attention, "title_too_long");
    assert.equal(taskToGoalFields({ title: "A", due: "garbage-date-value" }).attention, "invalid_date");
  });

  it("notes fingerprint changes with notes or priority", () => {
    const a = notesFingerprint({ id: "g", notes: "a" });
    assert.notEqual(a, notesFingerprint({ id: "g", notes: "b" }));
    assert.notEqual(a, notesFingerprint({ id: "g", notes: "a", priority: "high" }));
    assert.equal(a, notesFingerprint({ id: "g", notes: "a" }));
  });
});
