import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Goal } from "@/types";
import { buildTaskNotes, notesFingerprint } from "./tasksGoalMapping";
import { buildTasksSyncPlan, planTasksSync, TasksListTruncatedError, type LiveTask, type TasksPlanReader } from "./tasksSyncPlan";
import type { GoalSyncMapping, SyncBase, TasksMapping } from "./googleSyncMapping";

const UID = "user-1";
const LIST = "MDE2NzgxMjM0NTY3ODkwMTIzNDU6MDow"; // realistic Tasks list id shape
const TASK_ID = (n: number) => `Zk5ZUWx4b1dtVEZ${String(n).padStart(4, "0")}Mw`; // realistic opaque task id (NOT goal:<id>)

function goal(id: string, title: string, targetDate: string | null, extra: Partial<Goal> = {}): Goal {
  return { id, title, targetDate, completed: false, ...extra } as Goal;
}

function liveTask(g: Goal, n: number, extra: Partial<LiveTask> = {}): LiveTask {
  return {
    id: TASK_ID(n),
    etag: `"etag-${n}"`,
    title: g.title,
    notes: buildTaskNotes(g),
    status: g.completed ? "completed" : "needsAction",
    due: g.targetDate ? `${g.targetDate}T00:00:00.000Z` : null,
    ...extra,
  };
}

function mapping(g: Goal, n: number, base: Partial<SyncBase> = {}, extra: Partial<TasksMapping> = {}): GoalSyncMapping {
  return {
    goalId: g.id,
    titleSnapshot: g.title,
    calendar: null,
    tasks: {
      connectionId: "conn-1", listId: LIST, taskId: TASK_ID(n), remoteEtag: null,
      base: { title: g.title, targetDate: g.targetDate ?? null, completed: Boolean(g.completed), ...base },
      notesHash: notesFingerprint(g), hash: null, status: "synced", creatingAt: null, lastSyncAt: null, lastErrorCode: null, ...extra,
    },
  };
}

const plan = (goals: Goal[], tasks: LiveTask[], maps: GoalSyncMapping[] = [], opts: { goalIds?: string[]; now?: number } = {}) =>
  buildTasksSyncPlan({ uid: UID, listId: LIST, goals, mappings: new Map(maps.map((m) => [m.goalId, m])), liveTasks: tasks, ...opts });

describe("tasks planner", () => {
  const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-tasks-secret"; });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
    else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  });
  it("proposes push_create for a goal with no task (all-open goals, undated too)", () => {
    const r = plan([goal("g1", "Learn", "2026-03-05"), goal("g2", "No date", null)], []);
    assert.deepEqual(r.items.map((i) => i.kind), ["push_create", "push_create"]);
  });

  it("does not back-fill completed goals that were never synced", () => {
    assert.equal(plan([goal("g1", "Old", "2026-01-01", { completed: true })], []).items.length, 0);
  });

  it("an already-synced goal with the real opaque task id produces NO item", () => {
    const g = goal("g1", "Learn", "2026-03-05");
    const r = plan([g], [liveTask(g, 1)], [mapping(g, 1)]);
    assert.equal(r.items.length, 0);
    assert.equal(r.converged.length, 0);
  });

  it("finds the task by its notes marker when the mapping is missing, and remembers the agreement", () => {
    const g = goal("g1", "Learn", "2026-03-05");
    const r = plan([g], [liveTask(g, 7)]);
    assert.equal(r.items.length, 0);
    assert.equal(r.converged.length, 1);
    assert.equal(r.converged[0].taskId, TASK_ID(7));
  });

  it("Google-side date change -> pull_update with before = current goal value", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const t = liveTask(g, 1, { due: "2026-03-12T00:00:00.000Z" });
    const r = plan([g], [t], [mapping(g, 1)]);
    assert.equal(r.items[0].kind, "pull_update");
    assert.deepEqual(r.items[0].fields.map((f) => [f.name, f.before, f.after, f.direction]), [["targetDate", "2026-03-10", "2026-03-12", "google"]]);
  });

  it("local change only -> push_update; same change on both sides -> nothing", () => {
    const g = goal("g1", "Learn more", "2026-03-10");
    const old = goal("g1", "Learn", "2026-03-10");
    const push = plan([g], [liveTask(old, 1)], [mapping({ ...old, notes: undefined } as Goal, 1)]);
    assert.equal(push.items[0].kind, "push_update");
    const t = liveTask(g, 1);
    assert.equal(plan([g], [t], [mapping(old, 1)]).items.length, 0);
  });

  it("different changes to the same field -> conflict carrying both values", () => {
    const g = goal("g1", "Mine", "2026-03-10");
    const t = liveTask(g, 1, { title: "Theirs" });
    const r = plan([g], [t], [mapping(goal("g1", "Original", "2026-03-10"), 1)]);
    assert.equal(r.items[0].kind, "conflict");
    const f = r.items[0].fields.find((x) => x.name === "title")!;
    assert.equal(f.direction, undefined);
    assert.equal(f.local, "Mine");
    assert.equal(f.remote, "Theirs");
  });

  it("completion goes both ways", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const doneInGoogle = plan([g], [liveTask(g, 1, { status: "completed" })], [mapping(g, 1)]);
    assert.equal(doneInGoogle.items[0].kind, "pull_update");
    assert.deepEqual(doneInGoogle.items[0].fields[0], { name: "completed", before: false, after: true, direction: "google" });

    const done = goal("g1", "Learn", "2026-03-10", { completed: true });
    const doneLocally = plan([done], [liveTask(g, 1)], [mapping(g, 1, {}, { notesHash: notesFingerprint(done) })]);
    assert.equal(doneLocally.items[0].kind, "push_update");
    assert.equal(doneLocally.items[0].fields[0].direction, "study_lamp");
  });

  it("due removed in Google shows Target date -> (none) as a pull", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const r = plan([g], [liveTask(g, 1, { due: null })], [mapping(g, 1)]);
    assert.equal(r.items[0].kind, "pull_update");
    assert.deepEqual(r.items[0].fields[0], { name: "targetDate", before: "2026-03-10", after: null, direction: "google" });
  });

  it("notes are push-only: edited in Study Lamp -> pushed; edited in Google -> ignored", () => {
    const g = goal("g1", "Learn", "2026-03-10", { notes: "v1" });
    const edited = { ...g, notes: "v2" } as Goal;
    const pushed = plan([edited], [liveTask(g, 1)], [mapping(g, 1)]);
    assert.deepEqual(pushed.items[0].fields.map((f) => f.name), ["notes"]);
    assert.equal(pushed.items[0].kind, "push_update");
    const googleEdit = plan([g], [liveTask(g, 1, { notes: "typed in Google\n[studylamp:g1]" })], [mapping(g, 1)]);
    assert.equal(googleEdit.items.length, 0);
  });

  it("task deleted in Google -> remote_deleted; gone entirely -> remote_deleted; unlinked is skipped", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    assert.equal(plan([g], [liveTask(g, 1, { deleted: true })], [mapping(g, 1)]).items[0].kind, "remote_deleted");
    assert.equal(plan([g], [], [mapping(g, 1)]).items[0].kind, "remote_deleted");
    assert.equal(plan([g], [], [mapping(g, 1, {}, { status: "unlinked" })]).items.length, 0);
  });

  it("a fresh 'creating' row is busy (no second create); a stale one is created again", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const now = Date.parse("2026-03-01T10:00:00Z");
    const fresh = mapping(g, 1, {}, { status: "creating", taskId: null, base: null, notesHash: null, creatingAt: "2026-03-01T09:59:30Z" });
    assert.equal(plan([g], [], [fresh], { now }).items.length, 0);
    const stale = mapping(g, 1, {}, { status: "creating", taskId: null, base: null, notesHash: null, creatingAt: "2026-03-01T09:50:00Z" });
    assert.equal(plan([g], [], [stale], { now }).items[0].kind, "push_create");
  });

  it("a stuck 'creating' row with the task already in Google adopts it by marker (no create)", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const stale = mapping(g, 1, {}, { status: "creating", taskId: null, base: null, notesHash: null, creatingAt: "2026-03-01T09:50:00Z" });
    const r = plan([g], [liveTask(g, 5)], [stale], { now: Date.parse("2026-03-01T10:00:00Z") });
    assert.equal(r.items.length, 0);
    assert.equal(r.converged[0].taskId, TASK_ID(5));
  });

  it("an unusable task (empty title) is an attention item", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    assert.equal(plan([g], [liveTask(g, 1, { title: "" })], [mapping(g, 1)]).items[0].kind, "attention");
  });

  it("a partial plan only looks at the requested goals and reports no orphans; a full plan reports orphans", () => {
    const a = goal("a", "A", "2026-03-10");
    const b = goal("b", "B", "2026-03-11");
    assert.equal(plan([a, b], [], [], { goalIds: ["a"] }).items.length, 1);
    const orphan = mapping(goal("gone", "Gone", null), 9);
    assert.equal(plan([a], [liveTask(a, 1)], [mapping(a, 1), orphan]).orphans[0].goalId, "gone");
    assert.equal(plan([a], [liveTask(a, 1)], [mapping(a, 1), orphan], { goalIds: ["a"] }).orphans.length, 0);
  });

  it("items from a mapping for ANOTHER list are not trusted (re-created list starts clean)", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const other = mapping(g, 1, {}, { listId: "OTHER" });
    assert.equal(plan([g], [], [other]).items[0].kind, "push_create");
  });

  it("preview performs ZERO writes: the planner only sees a read-only reader and its source imports nothing that can write", async () => {
    const calls: string[] = [];
    const reader: TasksPlanReader = {
      listGoals: async () => { calls.push("goals"); return [goal("g1", "Learn", "2026-03-10")]; },
      listMappings: async () => { calls.push("mappings"); return new Map(); },
      listLiveTasks: async () => { calls.push("tasks"); return { tasks: [], truncated: false }; },
    };
    const result = await planTasksSync(reader, { uid: UID, listId: LIST });
    assert.deepEqual(calls.sort(), ["goals", "mappings", "tasks"]);
    assert.equal(result.items.length, 1);
    const src = readFileSync(new URL("./tasksSyncPlan.ts", import.meta.url), "utf8");
    assert.ok(!/googleTasks"|googleSyncState|tasksSyncStore|goalSyncStore|tasksSyncApply/.test(src), "planner must not import any write module");
  });

  it("a truncated list is refused, never compared", async () => {
    const reader: TasksPlanReader = { listGoals: async () => [], listMappings: async () => new Map(), listLiveTasks: async () => ({ tasks: [], truncated: true }) };
    await assert.rejects(() => planTasksSync(reader, { uid: UID, listId: LIST }), TasksListTruncatedError);
  });

  it("fingerprint changes when the local goal changes after the preview", () => {
    const g = goal("g1", "Learn", "2026-03-10");
    const a = plan([g], [liveTask(g, 1, { title: "Theirs" })], [mapping(goal("g1", "Original", "2026-03-10"), 1)]);
    const g2 = goal("g1", "Learn", "2026-04-01");
    const b = plan([g2], [liveTask(g, 1, { title: "Theirs" })], [mapping(goal("g1", "Original", "2026-03-10"), 1)]);
    assert.notEqual(a.items[0].fingerprint, b.items[0].fingerprint);
  });
});
