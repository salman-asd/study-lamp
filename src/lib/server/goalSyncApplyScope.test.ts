import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyGoalSyncPlan } from "./goalSyncApply";
import { PlanTokenVerificationError, signPlanToken } from "./planToken";

const original = process.env.DRIVE_URL_SIGNING_SECRET;
beforeEach(() => { process.env.DRIVE_URL_SIGNING_SECRET = "scope-test-secret"; });
afterEach(() => {
  if (original === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
  else process.env.DRIVE_URL_SIGNING_SECRET = original;
});

describe("Calendar apply path refuses a Tasks plan token", () => {
  it("throws wrong_scope BEFORE the one-time token is claimed or any writer runs", async () => {
    const token = signPlanToken({ uid: "u1", scope: "tasks", items: [{ itemId: "a".repeat(64), fingerprint: "fp" }] });
    let claimed = false;
    let wrote = false;
    await assert.rejects(
      applyGoalSyncPlan({
        token,
        accepted: ["a".repeat(64)],
        freshPlan: [],
        expectedUser: "u1",
        expectedScope: "calendar",
        writers: { push_create: () => { wrote = true; } },
        claimToken: async () => { claimed = true; return true; },
      }),
      (error: unknown) => error instanceof PlanTokenVerificationError && error.code === "wrong_scope",
    );
    assert.equal(claimed, false, "a refused token must not be spent");
    assert.equal(wrote, false);
  });
});
