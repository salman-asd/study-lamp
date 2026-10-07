import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeRemovalCount,
  removeAllForTarget,
  removeThenDisconnect,
  RemovalIncompleteError,
  type RemovalApi,
  type RemovalPreviewResult,
} from "./googleRemovalFlow";

function plan(count: number, remaining = 0): RemovalPreviewResult {
  return { planToken: `tok-${count}-${remaining}`, count, orphans: 0, remaining, items: [] };
}

function fakeApi(plans: RemovalPreviewResult[], applyResult = { ok: true, applied: 0, skipped: 0, failed: 0 }) {
  const log: string[] = [];
  const api: RemovalApi = {
    preview: async (input) => { log.push(`preview:${input.target}:${input.scope}`); return plans.shift() ?? plan(0); },
    apply: async (input) => { log.push(`apply:${input.target}:${input.confirmCount}`); return { ...applyResult, applied: input.confirmCount }; },
  };
  return { api, log };
}

describe("removeAllForTarget", () => {
  it("confirms each round with that round's own count and stops when nothing remains", async () => {
    const { api, log } = fakeApi([plan(200, 30), plan(30, 0)]);
    assert.equal(await removeAllForTarget(api, "calendar", "c1"), 230);
    assert.deepEqual(log, ["preview:calendar:all", "apply:calendar:200", "preview:calendar:all", "apply:calendar:30"]);
  });

  it("does nothing for an empty preview", async () => {
    const { api, log } = fakeApi([plan(0)]);
    assert.equal(await removeAllForTarget(api, "tasks", "c1"), 0);
    assert.deepEqual(log, ["preview:tasks:all"]);
  });

  it("throws when an item could not be removed", async () => {
    const { api } = fakeApi([plan(3)], { ok: false, applied: 0, skipped: 0, failed: 1 });
    api.apply = async () => ({ ok: false, applied: 2, skipped: 0, failed: 1 });
    await assert.rejects(() => removeAllForTarget(api, "calendar", "c1"), RemovalIncompleteError);
  });
});

describe("removeThenDisconnect", () => {
  it("without the option: no removal call at all, just the disconnect", async () => {
    const { api, log } = fakeApi([plan(5)]);
    const removed = await removeThenDisconnect({ alsoRemove: false, counts: { calendar: 5, tasks: 2 }, connectionId: "c1", api, disconnect: async () => { log.push("disconnect"); } });
    assert.equal(removed, 0);
    assert.deepEqual(log, ["disconnect"]);
  });

  it("with the option: every removal finishes BEFORE the disconnect", async () => {
    const { api, log } = fakeApi([plan(2), plan(1)]);
    const removed = await removeThenDisconnect({ alsoRemove: true, counts: { calendar: 2, tasks: 1 }, connectionId: "c1", api, disconnect: async () => { log.push("disconnect"); } });
    assert.equal(removed, 3);
    assert.deepEqual(log, ["preview:calendar:all", "apply:calendar:2", "preview:tasks:all", "apply:tasks:1", "disconnect"]);
  });

  it("skips a service with nothing to remove", async () => {
    const { api, log } = fakeApi([plan(4)]);
    await removeThenDisconnect({ alsoRemove: true, counts: { calendar: 0, tasks: 4 }, connectionId: "c1", api, disconnect: async () => { log.push("disconnect"); } });
    assert.deepEqual(log, ["preview:tasks:all", "apply:tasks:4", "disconnect"]);
  });

  it("if a removal fails the token is NOT deleted (disconnect never runs)", async () => {
    const { api, log } = fakeApi([plan(2)]);
    api.apply = async () => ({ ok: false, applied: 1, skipped: 0, failed: 1 });
    await assert.rejects(
      () => removeThenDisconnect({ alsoRemove: true, counts: { calendar: 2, tasks: 0 }, connectionId: "c1", api, disconnect: async () => { log.push("disconnect"); } }),
      RemovalIncompleteError,
    );
    assert.ok(!log.includes("disconnect"));
  });
});

describe("describeRemovalCount", () => {
  it("uses the right noun and plural", () => {
    assert.equal(describeRemovalCount("calendar", 1), "1 event");
    assert.equal(describeRemovalCount("calendar", 2), "2 events");
    assert.equal(describeRemovalCount("tasks", 1), "1 task");
    assert.equal(describeRemovalCount("tasks", 0), "0 tasks");
  });
});
