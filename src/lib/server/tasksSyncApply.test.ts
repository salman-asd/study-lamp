import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Goal } from "@/types";
import { PlanTokenVerificationError } from "./planToken";
import { GoogleTasksApiError } from "./googleTasks";
import { buildTaskNotes, notesFingerprint } from "./tasksGoalMapping";
import { buildTasksSyncPlan, type LiveTask } from "./tasksSyncPlan";
import { applyTasksSync, resolveTasksUpdate, validateTaskGoalPull, type TasksApplyDeps, type TasksMappingSave, type TasksPullResult } from "./tasksSyncApply";
import type { GoalSyncMapping, SyncBase, TasksMapping } from "./googleSyncMapping";
import type { GoogleSyncLogEntry } from "./googleSyncLog";

const UID = "user-1";
const LIST = "MDE2NzgxMjM0NTY3ODkwMTIzNDU6MDow";
const TID = (n: number) => `Zk5ZUWx4b1dtVEZ${String(n).padStart(4, "0")}Mw`;

const goal = (id: string, title: string, targetDate: string | null, extra: Partial<Goal> = {}): Goal => ({ id, title, targetDate, completed: false, ...extra }) as Goal;
const liveTask = (g: Goal, n: number, extra: Partial<LiveTask> = {}): LiveTask => ({
  id: TID(n), etag: `"e${n}"`, title: g.title, notes: buildTaskNotes(g), status: g.completed ? "completed" : "needsAction", due: g.targetDate ? `${g.targetDate}T00:00:00.000Z` : null, ...extra,
});
const mapping = (g: Goal, n: number, base: Partial<SyncBase> = {}, extra: Partial<TasksMapping> = {}): GoalSyncMapping => ({
  goalId: g.id, titleSnapshot: g.title, calendar: null,
  tasks: { connectionId: "conn-1", listId: LIST, taskId: TID(n), remoteEtag: null, base: { title: g.title, targetDate: g.targetDate ?? null, completed: Boolean(g.completed), ...base }, notesHash: notesFingerprint(g), hash: null, status: "synced", creatingAt: null, lastSyncAt: null, lastErrorCode: null, ...extra },
});

interface World { goals: Goal[]; tasks: LiveTask[]; mappings: GoalSyncMapping[] }

function makeDeps(world: World, opts: { insertError?: Error; patchError?: Error; pull?: TasksPullResult; busy?: boolean } = {}) {
  const writes: Array<{ op: string; detail?: unknown }> = [];
  const saved: Array<{ goalId: string } & TasksMappingSave> = [];
  const pulls: Array<{ goalId: string; updates: unknown }> = [];
  const logs: GoogleSyncLogEntry[] = [];
  const errors: string[] = [];
  const used = new Set<string>();
  const deps: TasksApplyDeps = {
    uid: UID, connectionId: "conn-1", listId: LIST,
    claimToken: async (_u, jti) => (used.has(jti) ? false : (used.add(jti), true)),
    listGoals: async () => world.goals,
    listMappings: async () => new Map(world.mappings.map((m) => [m.goalId, m])),
    listLiveTasks: async () => ({ tasks: world.tasks, truncated: false }),
    client: {
      insertTask: async (list, task) => { if (opts.insertError) throw opts.insertError; writes.push({ op: "insert", detail: { list, task } }); return { id: TID(99), etag: '"new"', ...task } as LiveTask; },
      patchTask: async (list, id, updates, o) => { if (opts.patchError) throw opts.patchError; writes.push({ op: "patch", detail: { list, id, updates, ifMatch: o?.ifMatch } }); return { id, etag: '"patched"' }; },
    },
    beginCreate: async (goalId) => { writes.push({ op: "begin", detail: goalId }); return opts.busy ? "busy" : "claimed"; },
    saveMapping: async (goalId, m) => { saved.push({ goalId, ...m }); },
    recordError: async (_g, code) => { errors.push(code); },
    pullGoalFields: async (goalId, _e, updates, m) => { pulls.push({ goalId, updates }); saved.push({ goalId, ...m }); return opts.pull ?? "ok"; },
    deleteGoal: async (goalId) => { writes.push({ op: "deleteGoal", detail: goalId }); return "ok"; },
    log: async (e) => { logs.push(e); },
  };
  return { deps, writes, saved, pulls, logs, errors };
}

const planOf = (w: World) => buildTasksSyncPlan({ uid: UID, listId: LIST, goals: w.goals, mappings: new Map(w.mappings.map((m) => [m.goalId, m])), liveTasks: w.tasks });

describe("tasks apply", () => {
  const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;
  beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "test-tasks-secret"; });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
    else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  });
  let g: Goal;
  beforeEach(() => { g = goal("g1", "Learn", "2026-03-10", { notes: "n1" }); });

  it("push_create: claims first, inserts the built task into the stored list, then saves the task id", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const plan = planOf(w);
    const { deps, writes, saved } = makeDeps(w);
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "applied");
    assert.deepEqual(writes.map((x) => x.op), ["begin", "insert"]);
    const sent = (writes[1].detail as { list: string; task: { title: string; due: string; notes: string } });
    assert.equal(sent.list, LIST);
    assert.equal(sent.task.due, "2026-03-10T00:00:00.000Z");
    assert.match(sent.task.notes, /\[studylamp:g1\]/);
    assert.equal(saved[0].taskId, TID(99));
    assert.equal(saved[0].status, "synced");
    assert.equal(saved[0].notesHash, notesFingerprint(g));
  });

  it("busy claim -> skipped, nothing inserted", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const plan = planOf(w);
    const { deps, writes } = makeDeps(w, { busy: true });
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.deepEqual([results[0].status, results[0].code], ["skipped", "busy"]);
    assert.ok(!writes.some((x) => x.op === "insert"));
  });

  it("a failed insert is reported failed, never applied, and the error is recorded", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const plan = planOf(w);
    const { deps, saved, errors } = makeDeps(w, { insertError: new GoogleTasksApiError(503, "retryable") });
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "failed");
    assert.equal(saved.length, 0);
    assert.deepEqual(errors, ["retryable"]);
  });

  it("nothing is written without being accepted, and a replayed token is rejected", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const plan = planOf(w);
    const { deps, writes } = makeDeps(w);
    const none = await applyTasksSync(deps, { planToken: plan.planToken, accepted: [] });
    assert.equal(none.results[0].code, "not_accepted");
    assert.equal(writes.length, 0);
    const again = makeDeps(w);
    await applyTasksSync(again.deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    await assert.rejects(() => applyTasksSync(again.deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) }), /already applied/i);
  });

  it("a Calendar-scope token is refused for Tasks", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const { signPlanToken } = await import("./planToken");
    const token = signPlanToken({ uid: UID, scope: "calendar", items: [] });
    await assert.rejects(() => applyTasksSync(makeDeps(w).deps, { planToken: token, accepted: ["x"] }), PlanTokenVerificationError);
  });

  it("pull_update changes ONLY the pulled field on the goal and moves the base", async () => {
    const t = liveTask(g, 1, { due: "2026-03-12T00:00:00.000Z" });
    const w: World = { goals: [g], tasks: [t], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const { deps, writes, pulls, saved } = makeDeps(w);
    await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.deepEqual(pulls[0].updates, { targetDate: "2026-03-12" });
    assert.ok(!writes.some((x) => x.op === "patch"));
    assert.equal(saved[0].base?.targetDate, "2026-03-12");
    assert.equal(saved[0].base?.title, "Learn");
  });

  it("due removed in Google clears the goal date (null)", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { due: null })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const { deps, pulls } = makeDeps(w);
    await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.deepEqual(pulls[0].updates, { targetDate: null });
  });

  it("completion pulls both ways: Google done -> goal completed; local re-open -> status needsAction + completed null", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { status: "completed" })], mappings: [mapping(g, 1)] };
    const p1 = planOf(w);
    const a = makeDeps(w);
    await applyTasksSync(a.deps, { planToken: p1.planToken, accepted: p1.items.map((i) => i.itemId) });
    assert.deepEqual(a.pulls[0].updates, { completed: true });

    const done = goal("g1", "Learn", "2026-03-10", { notes: "n1", completed: true });
    const reopened = goal("g1", "Learn", "2026-03-10", { notes: "n1", completed: false });
    const w2: World = { goals: [reopened], tasks: [liveTask(done, 1)], mappings: [mapping(done, 1)] };
    const p2 = planOf(w2);
    const b = makeDeps(w2);
    await applyTasksSync(b.deps, { planToken: p2.planToken, accepted: p2.items.map((i) => i.itemId) });
    const patch = b.writes.find((x) => x.op === "patch")!.detail as { updates: Record<string, unknown>; ifMatch: string };
    assert.deepEqual(patch.updates, { status: "needsAction", completed: null });
    assert.equal(patch.ifMatch, '"e1"');
  });

  it("changed_remotely (412) -> skipped, goal and mapping untouched", async () => {
    const edited = goal("g1", "Learn faster", "2026-03-10", { notes: "n1" });
    const w: World = { goals: [edited], tasks: [liveTask(g, 1)], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const { deps, saved } = makeDeps(w, { patchError: new GoogleTasksApiError(412, "changed_remotely") });
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.deepEqual([results[0].status, results[0].code], ["skipped", "changed_remotely"]);
    assert.equal(saved.length, 0);
  });

  it("the goal edited between preview and apply -> stale, nothing written", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { due: "2026-03-12T00:00:00.000Z" })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    w.goals = [goal("g1", "Learn", "2026-04-01", { notes: "n1" })]; // local edit after the preview
    const { deps, writes, pulls } = makeDeps(w);
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(results[0].status, "stale");
    assert.equal(writes.length + pulls.length, 0);
  });

  it("goal_changed from the transaction -> skipped", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { due: "2026-03-12T00:00:00.000Z" })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const { deps } = makeDeps(w, { pull: "changed" });
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(results[0].code, "goal_changed");
  });

  it("conflict: per-field choice; a field left on skip is untouched on both sides", async () => {
    const mine = goal("g1", "Mine", "2026-03-20", { notes: "n1" });
    const t = liveTask(g, 1, { title: "Theirs", due: "2026-03-12T00:00:00.000Z" });
    const w: World = { goals: [mine], tasks: [t], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const item = plan.items[0];
    assert.equal(item.kind, "conflict");
    const { deps, writes, pulls } = makeDeps(w);
    await applyTasksSync(deps, { planToken: plan.planToken, accepted: [item.itemId], resolutions: { [`${item.itemId}:title`]: "use_google" } });
    assert.deepEqual(pulls[0].updates, { title: "Theirs" });
    assert.ok(!writes.some((x) => x.op === "patch")); // the date was left on skip
  });

  it("conflict with every field on skip -> skipped missing_resolution", async () => {
    const mine = goal("g1", "Mine", "2026-03-10", { notes: "n1" });
    const w: World = { goals: [mine], tasks: [liveTask(g, 1, { title: "Theirs" })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const { deps } = makeDeps(w);
    const { results } = await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(results[0].code, "missing_resolution");
  });

  it("remote_deleted: unlink touches only our mapping; delete_goal needs its own confirmation", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { deleted: true })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const id = plan.items[0].itemId;

    const a = makeDeps(w);
    await applyTasksSync(a.deps, { planToken: plan.planToken, accepted: [id], resolutions: { [id]: "unlink" } });
    assert.equal(a.saved[0].status, "unlinked");
    assert.equal(a.writes.length, 0);

    const b = makeDeps(w);
    const denied = await applyTasksSync(b.deps, { planToken: planOf(w).planToken, accepted: [id], resolutions: { [id]: "delete_goal" } });
    assert.equal(denied.results[0].code, "destructive_not_confirmed");
    assert.ok(!b.writes.some((x) => x.op === "deleteGoal"));

    const c = makeDeps(w);
    await applyTasksSync(c.deps, { planToken: planOf(w).planToken, accepted: [id], resolutions: { [id]: "delete_goal" }, confirmedDestructive: [id] });
    assert.ok(c.writes.some((x) => x.op === "deleteGoal"));
  });

  it("remote_deleted + recreate inserts a NEW task (no restore of the deleted id)", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 1, { deleted: true })], mappings: [mapping(g, 1)] };
    const plan = planOf(w);
    const id = plan.items[0].itemId;
    const { deps, writes, saved } = makeDeps(w);
    await applyTasksSync(deps, { planToken: plan.planToken, accepted: [id], resolutions: { [id]: "recreate" } });
    assert.deepEqual(writes.map((x) => x.op), ["begin", "insert"]);
    assert.equal(saved[0].taskId, TID(99));
  });

  it("writes a history entry with scope 'tasks' and goal-level fields only", async () => {
    const w: World = { goals: [g], tasks: [], mappings: [] };
    const plan = planOf(w);
    const { deps, logs } = makeDeps(w);
    await applyTasksSync(deps, { planToken: plan.planToken, accepted: plan.items.map((i) => i.itemId) });
    assert.equal(logs[0].scope, "tasks");
    assert.equal(logs[0].result, "applied");
    assert.ok(!JSON.stringify(logs[0]).includes("[studylamp:"));
  });

  it("converged bookkeeping writes only our mapping", async () => {
    const w: World = { goals: [g], tasks: [liveTask(g, 3)], mappings: [] };
    const plan = planOf(w);
    const { deps, writes, saved } = makeDeps(w);
    const r = await applyTasksSync(deps, { planToken: plan.planToken, accepted: [] });
    assert.equal(r.bookkeeping, 1);
    assert.equal(writes.length, 0);
    assert.equal(saved[0].taskId, TID(3));
  });

  it("validation of pulled values", () => {
    assert.equal(validateTaskGoalPull({ title: "ok", targetDate: null }), null);
    assert.equal(validateTaskGoalPull({ title: " " }), "invalid_remote_value");
    assert.equal(validateTaskGoalPull({ title: "x".repeat(501) }), "invalid_remote_value");
    assert.equal(validateTaskGoalPull({ targetDate: "2026-13-40" }), "invalid_remote_value");
  });

  it("resolveTasksUpdate: notes push does not need a conflict choice", () => {
    const edited = goal("g1", "Learn", "2026-03-10", { notes: "v2" });
    const out = resolveTasksUpdate({ goal: edited, remote: { title: "Learn", targetDate: "2026-03-10", completed: false }, mapping: mapping(goal("g1", "Learn", "2026-03-10", { notes: "v1" }), 1).tasks, remoteNotes: null, choose: () => undefined });
    assert.ok(out.taskUpdates.notes?.includes("v2"));
    assert.equal(out.newNotesHash, notesFingerprint(edited));
    assert.deepEqual(out.unresolved, []);
  });
});
