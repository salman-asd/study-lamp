import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseDefaultConnection,
  getGoogleTasksStatus,
  GoogleConnectionError,
  resolveTasksConnectionId,
  setGoogleTasksEnabled,
  type ConnectionDocStore,
} from "./googleConnections";
import { parseGoalSyncMapping } from "./googleSyncMapping";
import { GoogleTasksApiError } from "./googleTasks";

// ─── An in-memory stand-in for the googleConnections subcollection (no Firestore, no emulator) ─────────────────────

type Doc = Record<string, any>;

function setPath(target: Doc, path: string, value: unknown) {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

function fakeStore(seed: Record<string, Doc>) {
  const docs = new Map<string, Doc>(Object.entries(seed).map(([id, doc]) => [id, structuredClone(doc)]));
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const snap = (id: string) => ({ id, exists: docs.has(id), data: () => (docs.has(id) ? structuredClone(docs.get(id)) : undefined) });
  const store: ConnectionDocStore = {
    async get(_uid, id) { return snap(id); },
    async list() { return Array.from(docs.keys()).map(snap); },
    async update(_uid, id, patch) {
      const doc = docs.get(id);
      if (!doc) throw new Error("no such doc");
      updates.push({ id, patch });
      for (const [key, value] of Object.entries(patch)) setPath(doc, key, value);
    },
  };
  return { store, docs, updates };
}

const conn = (overrides: Doc = {}): Doc => ({
  googleEmail: "student@example.com",
  encryptedRefreshToken: "ciphertext",
  grantedScopes: ["calendar", "tasks"],
  status: "active",
  calendar: { enabled: false },
  tasks: { enabled: false },
  ...overrides,
});

const tasksOn = (listId = "list-1") => ({ tasks: { enabled: true, listId, listName: "Study Lamp" } });

async function rejectsWith(promise: Promise<unknown>, code: GoogleConnectionError["code"]) {
  await assert.rejects(promise, (error: unknown) => error instanceof GoogleConnectionError && error.code === code);
}

// ─── chooseDefaultConnection (pure, audit M2) ───────────────────────────────

describe("chooseDefaultConnection", () => {
  it("picks the only candidate, enabled or not", () => {
    assert.deepEqual(chooseDefaultConnection([{ id: "a", enabled: false }]), { kind: "ok", id: "a" });
  });
  it("with several, picks the single one that has the feature on", () => {
    assert.deepEqual(chooseDefaultConnection([{ id: "a", enabled: false }, { id: "b", enabled: true }]), { kind: "ok", id: "b" });
  });
  it("with several and none on, says 'none' (the feature is simply off), not an error", () => {
    assert.deepEqual(chooseDefaultConnection([{ id: "a", enabled: false }, { id: "b", enabled: false }]), { kind: "none" });
  });
  it("with two or more on, is ambiguous", () => {
    assert.deepEqual(chooseDefaultConnection([{ id: "a", enabled: true }, { id: "b", enabled: true }]), { kind: "ambiguous" });
  });
  it("with no candidates, says 'none'", () => {
    assert.deepEqual(chooseDefaultConnection([]), { kind: "none" });
  });
});

// ─── resolveTasksConnectionId ───────────────────────────────────────────────

describe("resolveTasksConnectionId", () => {
  it("returns a requested connection that has Tasks access", async () => {
    const { store } = fakeStore({ c1: conn() });
    assert.equal(await resolveTasksConnectionId("u", "c1", store), "c1");
  });

  it("rejects a missing, malformed, or token-less connection as not_found", async () => {
    const { store } = fakeStore({ c1: conn({ encryptedRefreshToken: "" }) });
    await rejectsWith(resolveTasksConnectionId("u", "nope", store), "not_found");
    await rejectsWith(resolveTasksConnectionId("u", "a/b", store), "not_found");
    await rejectsWith(resolveTasksConnectionId("u", "c1", store), "not_found");
  });

  it("rejects a requested connection without the tasks permission as scope_missing", async () => {
    const { store } = fakeStore({ c1: conn({ grantedScopes: ["calendar"] }) });
    await rejectsWith(resolveTasksConnectionId("u", "c1", store), "scope_missing");
  });

  it("without a requested id, ignores connections that have no token or no tasks permission", async () => {
    const { store } = fakeStore({
      a: conn({ grantedScopes: ["calendar"] }),
      b: conn({ encryptedRefreshToken: "" }),
      c: conn(),
    });
    assert.equal(await resolveTasksConnectionId("u", null, store), "c");
  });

  it("without a requested id and no usable connection, is not_found", async () => {
    const { store } = fakeStore({ a: conn({ grantedScopes: ["calendar"] }) });
    await rejectsWith(resolveTasksConnectionId("u", undefined, store), "not_found");
  });

  it("with several connections prefers the one that has Tasks sync on", async () => {
    const { store } = fakeStore({ a: conn(), b: conn(tasksOn()) });
    assert.equal(await resolveTasksConnectionId("u", null, store), "b");
  });

  it("with several connections and none on, is not_found (a check just finds nothing to do)", async () => {
    const { store } = fakeStore({ a: conn(), b: conn() });
    await rejectsWith(resolveTasksConnectionId("u", null, store), "not_found");
  });

  it("with several connections all on, says ambiguous instead of picking one or doing nothing", async () => {
    const { store } = fakeStore({ a: conn(tasksOn("l1")), b: conn(tasksOn("l2")) });
    await rejectsWith(resolveTasksConnectionId("u", null, store), "ambiguous");
  });
});

// ─── setGoogleTasksEnabled ──────────────────────────────────────────────────

function fakeTasksClient(options: { existing?: "ok" | "missing" | "boom" } = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async getTaskList(listId: string) {
        calls.push(`get:${listId}`);
        if (options.existing === "missing") throw new GoogleTasksApiError(404, "remote_missing");
        if (options.existing === "boom") throw new GoogleTasksApiError(503, "retryable");
        return { id: listId, title: "Study Lamp" };
      },
      async createTaskList(title: string) {
        calls.push(`create:${title}`);
        return { id: "new-list", title };
      },
    },
  };
}

describe("setGoogleTasksEnabled", () => {
  it("enabling creates the Study Lamp list once and stores its id", async () => {
    const { store, docs } = fakeStore({ c1: conn() });
    const fake = fakeTasksClient();
    const result = await setGoogleTasksEnabled("u", "c1", true, { store, tasksClient: async () => fake.client });
    assert.deepEqual(fake.calls, ["create:Study Lamp"]);
    assert.equal(result.enabled, true);
    assert.equal(result.listId, "new-list");
    assert.equal(docs.get("c1")!.tasks.enabled, true);
  });

  it("enabling again verifies the stored list and does NOT create another", async () => {
    const { store } = fakeStore({ c1: conn(tasksOn("list-9")) });
    const fake = fakeTasksClient();
    const result = await setGoogleTasksEnabled("u", "c1", true, { store, tasksClient: async () => fake.client });
    assert.deepEqual(fake.calls, ["get:list-9"]);
    assert.equal(result.listId, "list-9");
  });

  it("a list deleted in Google is not re-created: sync stays off and the stored id is cleared", async () => {
    const { store, docs } = fakeStore({ c1: conn(tasksOn("gone")) });
    const fake = fakeTasksClient({ existing: "missing" });
    await rejectsWith(setGoogleTasksEnabled("u", "c1", true, { store, tasksClient: async () => fake.client }), "tasks_list_deleted");
    assert.deepEqual(fake.calls, ["get:gone"], "no createTaskList call");
    assert.equal(docs.get("c1")!.tasks.enabled, false);
    assert.equal(docs.get("c1")!.tasks.listId, null);
  });

  it("another Google failure propagates and leaves the stored state untouched", async () => {
    const { store, docs, updates } = fakeStore({ c1: conn(tasksOn("list-1")) });
    const fake = fakeTasksClient({ existing: "boom" });
    await assert.rejects(setGoogleTasksEnabled("u", "c1", true, { store, tasksClient: async () => fake.client }), GoogleTasksApiError);
    assert.equal(updates.length, 0);
    assert.equal(docs.get("c1")!.tasks.listId, "list-1");
  });

  it("disabling only flips the flag and never calls Google", async () => {
    const { store, docs } = fakeStore({ c1: conn(tasksOn()) });
    let clientBuilt = false;
    const result = await setGoogleTasksEnabled("u", "c1", false, { store, tasksClient: async () => { clientBuilt = true; return fakeTasksClient().client; } });
    assert.equal(clientBuilt, false);
    assert.equal(result.enabled, false);
    assert.equal(docs.get("c1")!.tasks.listId, "list-1", "the list id is kept so a later enable reuses the list");
  });

  it("refuses a missing connection and a connection without the tasks permission, before any Google call", async () => {
    const { store } = fakeStore({ c1: conn({ grantedScopes: ["calendar"] }) });
    let clientBuilt = false;
    const deps = { store, tasksClient: async () => { clientBuilt = true; return fakeTasksClient().client; } };
    await rejectsWith(setGoogleTasksEnabled("u", "missing", true, deps), "not_found");
    await rejectsWith(setGoogleTasksEnabled("u", "c1", true, deps), "scope_missing");
    assert.equal(clientBuilt, false);
  });
});

// ─── getGoogleTasksStatus ───────────────────────────────────────────────────

describe("getGoogleTasksStatus", () => {
  const mappings = () =>
    new Map([
      ["g1", parseGoalSyncMapping("g1", { titleSnapshot: "A", tasks: { connectionId: "c1", listId: "list-1", taskId: "t1", status: "synced" } })!],
      ["g2", parseGoalSyncMapping("g2", { titleSnapshot: "B", tasks: { connectionId: "c1", listId: "list-1", taskId: "t2", status: "failed" } })!],
      ["gone", parseGoalSyncMapping("gone", { titleSnapshot: "C", tasks: { connectionId: "c1", listId: "list-1", taskId: "t3", status: "synced" } })!],
    ]);

  it("reports the connection, list name and counts from our own docs", async () => {
    const { store } = fakeStore({ c1: conn(tasksOn("list-1")) });
    const status = await getGoogleTasksStatus("u", null, { store, listMappings: async () => mappings(), listGoalIds: async () => ["g1", "g2"] });
    assert.equal(status.enabled, true);
    assert.equal(status.connectionId, "c1");
    assert.equal(status.listName, "Study Lamp");
    assert.deepEqual(status.counts, { synced: 1, failed: 1, remoteDeleted: 0, unlinked: 0, noDate: 0, orphaned: 1 });
  });

  it("when Tasks sync is off, reports disabled with zero counts and reads no mappings", async () => {
    const { store } = fakeStore({ c1: conn() });
    let read = false;
    const status = await getGoogleTasksStatus("u", "c1", { store, listMappings: async () => { read = true; return new Map(); }, listGoalIds: async () => [] });
    assert.equal(status.enabled, false);
    assert.equal(status.counts.synced, 0);
    assert.equal(read, false);
  });

  it("with no usable connection, reports disabled instead of failing", async () => {
    const { store } = fakeStore({});
    const status = await getGoogleTasksStatus("u", null, { store, listMappings: async () => new Map(), listGoalIds: async () => [] });
    assert.deepEqual({ enabled: status.enabled, connectionId: status.connectionId }, { enabled: false, connectionId: null });
  });

  it("with several connections on, throws ambiguous so the page can ask the user to choose", async () => {
    const { store } = fakeStore({ a: conn(tasksOn("l1")), b: conn(tasksOn("l2")) });
    await rejectsWith(getGoogleTasksStatus("u", null, { store, listMappings: async () => new Map(), listGoalIds: async () => [] }), "ambiguous");
  });

  it("with several connections and none on, reports disabled (no error nag)", async () => {
    const { store } = fakeStore({ a: conn(), b: conn() });
    const status = await getGoogleTasksStatus("u", null, { store, listMappings: async () => new Map(), listGoalIds: async () => [] });
    assert.equal(status.enabled, false);
  });
});
