import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildGoalSyncPlan } from "./goalSyncPlan";

const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;

describe("goalSyncPlan", () => {
  beforeEach(() => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
    else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  });

  it("builds a push-create item when a Study Lamp goal has no matching remote record", () => {
    const plan = buildGoalSyncPlan({
      uid: "user-1",
      goals: [{
        id: "g1",
        title: "Read chapter 2",
        targetDate: "2026-10-10",
        completed: false,
        createdAt: null,
      } as any],
      remoteEvents: [],
    });

    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].kind, "push_create");
    assert.equal(plan.counts.push, 1);
  });

  it("builds a pull-update item when Google changed but Study Lamp did not", () => {
    const plan = buildGoalSyncPlan({
      uid: "user-1",
      goals: [{
        id: "g2",
        title: "Read chapter 3",
        targetDate: "2026-10-12",
        completed: false,
        createdAt: null,
      } as any],
      remoteEvents: [{
        remoteId: "g2",
        title: "Read chapter 3",
        targetDate: "2026-10-15",
        base: { title: "Read chapter 3", targetDate: "2026-10-12" },
        etag: "etag-1",
      }],
    });

    assert.equal(plan.items[0].kind, "pull_update");
    assert.equal(plan.counts.pull, 1);
  });

  it("builds a conflict item when both sides changed differently", () => {
    const plan = buildGoalSyncPlan({
      uid: "user-1",
      goals: [{
        id: "g3",
        title: "Read chapter 4",
        targetDate: "2026-10-20",
        completed: false,
        createdAt: null,
      } as any],
      remoteEvents: [{
        remoteId: "g3",
        title: "Read chapter 4 from Google",
        targetDate: "2026-10-25",
        base: { title: "Read chapter 4", targetDate: "2026-10-18" },
        etag: "etag-2",
      }],
    });

    assert.equal(plan.items[0].kind, "conflict");
    assert.equal(plan.counts.conflict, 1);
  });
});
