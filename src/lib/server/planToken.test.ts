import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { PlanTokenVerificationError, planTokenSecretSource, signPlanToken, verifyPlanToken } from "./planToken";

const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
  else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
  process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";
});

describe("sync plan tokens", () => {
  it("accepts a valid signed token and returns the verified payload", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";
    const token = signPlanToken({
      uid: "user-42",
      scope: "calendar",
      items: [{ itemId: "goal-1", fingerprint: "abc123" }],
      exp: 2_000_000_000,
    });

    const verified = verifyPlanToken(token, "user-42", "calendar", 1_500_000_000_000);
    assert.equal(verified.uid, "user-42");
    assert.equal(verified.scope, "calendar");
    assert.deepEqual(verified.items, [{ itemId: "goal-1", fingerprint: "abc123" }]);
  });

  it("rejects expired, wrong-user and wrong-scope tokens", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";
    const token = signPlanToken({
      uid: "user-42",
      scope: "tasks",
      items: [{ itemId: "goal-1", fingerprint: "abc123" }],
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    assert.throws(() => verifyPlanToken(token, "user-42", "calendar"), (error: unknown) => {
      return error instanceof PlanTokenVerificationError && error.code === "wrong_scope";
    });

    assert.throws(() => verifyPlanToken(token, "user-99", "tasks"), (error: unknown) => {
      return error instanceof PlanTokenVerificationError && error.code === "wrong_user";
    });

    const expired = signPlanToken({
      uid: "user-42",
      scope: "tasks",
      items: [{ itemId: "goal-1", fingerprint: "abc123" }],
      exp: Math.floor(Date.now() / 1000) - 1,
    });

    assert.throws(() => verifyPlanToken(expired, "user-42", "tasks"), (error: unknown) => {
      return error instanceof PlanTokenVerificationError && error.code === "expired";
    });
  });

  it("rejects tampered tokens", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-sync-plan-secret";
    const token = signPlanToken({
      uid: "user-42",
      scope: "remove",
      items: [{ itemId: "goal-1", fingerprint: "abc123" }],
      exp: 2_000_000_000,
    });

    assert.throws(() => verifyPlanToken(`${token}x`, "user-42", "remove"), (error: unknown) => {
      return error instanceof PlanTokenVerificationError && error.code === "tampered";
    });
  });
});

describe("plan token signing secret (audit M5)", () => {
  const originalSyncSecret = process.env.GOOGLE_SYNC_SIGNING_SECRET;
  afterEach(() => {
    if (originalSyncSecret === undefined) delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
    else process.env.GOOGLE_SYNC_SIGNING_SECRET = originalSyncSecret;
  });

  it("prefers the dedicated secret and falls back to the Drive URL secret", () => {
    assert.equal(planTokenSecretSource({ GOOGLE_SYNC_SIGNING_SECRET: "a", DRIVE_URL_SIGNING_SECRET: "b" }), "GOOGLE_SYNC_SIGNING_SECRET");
    assert.equal(planTokenSecretSource({ DRIVE_URL_SIGNING_SECRET: "b" }), "DRIVE_URL_SIGNING_SECRET");
    assert.equal(planTokenSecretSource({ GOOGLE_SYNC_SIGNING_SECRET: "", DRIVE_URL_SIGNING_SECRET: "b" }), "DRIVE_URL_SIGNING_SECRET");
    assert.equal(planTokenSecretSource({}), null);
  });

  it("a token signed with the dedicated secret is NOT valid under the Drive URL secret alone", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "drive-secret";
    process.env.GOOGLE_SYNC_SIGNING_SECRET = "dedicated-secret";
    const token = signPlanToken({ uid: "u1", scope: "calendar", items: [], exp: 2_000_000_000 });
    assert.equal(verifyPlanToken(token, "u1", "calendar", 1_500_000_000_000).uid, "u1");

    delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
    assert.throws(() => verifyPlanToken(token, "u1", "calendar", 1_500_000_000_000), (error: unknown) => error instanceof PlanTokenVerificationError && error.code === "tampered");
  });

  it("a leaked Drive URL secret cannot forge a plan token once the dedicated secret is set", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "leaked-drive-secret";
    process.env.GOOGLE_SYNC_SIGNING_SECRET = "dedicated-secret";
    // The attacker only knows the Drive secret: sign with it, then verify on a server using the dedicated one.
    delete process.env.GOOGLE_SYNC_SIGNING_SECRET;
    const forged = signPlanToken({ uid: "u1", scope: "calendar", items: [], exp: 2_000_000_000 });
    process.env.GOOGLE_SYNC_SIGNING_SECRET = "dedicated-secret";
    assert.throws(() => verifyPlanToken(forged, "u1", "calendar", 1_500_000_000_000), PlanTokenVerificationError);
  });
});
