import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlanItem } from "@/lib/sync/plan";

import { applyConfirmed } from "./applyGate";
import { signPlanToken } from "./planToken";

describe("applyConfirmed", () => {
  it("applies only accepted, fresh items and never calls a writer for an unverified id", async () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";

    const item = buildPlanItem({
      kind: "push_update",
      target: "goal:goal-1",
      goalId: "goal-1",
      title: "Finish Portuguese",
      fields: [{ name: "title", before: "Old title", after: "Finish Portuguese" }],
      localValue: "Finish Portuguese",
      remoteVersion: "v1",
    });

    const token = signPlanToken({
      uid: "user-7",
      scope: "calendar",
      items: [{ itemId: item.itemId, fingerprint: item.fingerprint }],
      exp: 2_000_000_000,
    });

    let called = false;
    const results = await applyConfirmed({
      token,
      accepted: [item.itemId],
      resolutions: { [item.itemId]: "use_google" },
      freshPlan: [item, buildPlanItem({
        kind: "pull_update",
        target: "goal:goal-2",
        goalId: "goal-2",
        title: "Ignored goal",
        fields: [{ name: "title", before: "Old", after: "New" }],
        localValue: "New",
        remoteVersion: "v2",
      })],
      writers: {
        [item.itemId]: async () => {
          called = true;
        },
      },
      expectedUser: "user-7",
      expectedScope: "calendar",
    });

    assert.equal(called, true);
    assert.deepEqual(results, [{ itemId: item.itemId, status: "applied" }]);
  });

  it("marks stale or unaccepted items as skipped without calling their writers", async () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";

    const staleItem = buildPlanItem({
      kind: "conflict",
      target: "goal:goal-3",
      goalId: "goal-3",
      title: "Conflicting goal",
      fields: [{ name: "targetDate", before: "2026-01-01", after: "2026-01-15" }],
      localValue: "2026-01-15",
      remoteVersion: "v1",
      risk: "normal",
    });

    const token = signPlanToken({
      uid: "user-7",
      scope: "tasks",
      items: [{ itemId: staleItem.itemId, fingerprint: staleItem.fingerprint }],
      exp: 2_000_000_000,
    });

    let hit = false;
    const results = await applyConfirmed({
      token,
      accepted: [staleItem.itemId],
      resolutions: {},
      freshPlan: [{ ...staleItem, fingerprint: "different" }],
      writers: {
        [staleItem.itemId]: async () => {
          hit = true;
        },
      },
      expectedUser: "user-7",
      expectedScope: "tasks",
    });

    assert.equal(hit, false);
    assert.equal(results[0].status, "stale");
  });
});
