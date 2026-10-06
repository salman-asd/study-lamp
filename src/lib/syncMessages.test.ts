import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeApplyOutcome, describeAttentionReason, describeResultCode, summarizeApplyResults } from "./syncMessages";
import { AUTO_CHECK_INTERVAL_MS, countActionableItems, isAutoCheckDue, readCalendarFlag, readLastAutoCheck, writeCalendarFlag, writeLastAutoCheck } from "./googleCalendarFlag";

describe("syncMessages", () => {
  it("never reports success when something failed", () => {
    const outcome = describeApplyOutcome(summarizeApplyResults([{ status: "applied" }, { status: "failed", code: "writer_error" }]));
    assert.equal(outcome.tone, "error");
    assert.match(outcome.message, /failed/);
  });

  it("success only when something was written and nothing was left out", () => {
    assert.equal(describeApplyOutcome(summarizeApplyResults([{ status: "applied" }])).tone, "success");
    assert.equal(describeApplyOutcome(summarizeApplyResults([{ status: "applied" }, { status: "stale", code: "fingerprint_mismatch" }])).tone, "warning");
    assert.equal(describeApplyOutcome(summarizeApplyResults([{ status: "stale" }])).tone, "warning");
  });

  it("does not count items that were simply not ticked", () => {
    assert.deepEqual(summarizeApplyResults([{ status: "skipped", code: "not_accepted" }, { status: "applied" }]), { applied: 1, stale: 0, skipped: 0, failed: 0 });
  });

  it("has words for every code the server can send and a safe fallback", () => {
    for (const code of ["fingerprint_mismatch", "goal_changed", "changed_remotely", "missing_resolution", "destructive_not_confirmed", "needs_attention", "writer_error", "remote_cancelled"]) {
      assert.ok(describeResultCode(code).length > 10, code);
    }
    assert.equal(describeResultCode("something_new"), "This change was not applied.");
  });

  it("explains every attention reason", () => {
    for (const reason of ["timed", "multi_day", "cancelled", "no_date", "invalid_date", "empty_title", "title_too_long", "goal_has_no_date"] as const) {
      assert.ok(describeAttentionReason(reason).length > 10, reason);
    }
  });
});

describe("googleCalendarFlag", () => {
  const fake = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("remembers the flag per user and treats 'never stored' as unknown", () => {
    const storage = fake();
    assert.equal(readCalendarFlag("u1", storage), null);
    writeCalendarFlag("u1", true, storage);
    writeCalendarFlag("u2", false, storage);
    assert.equal(readCalendarFlag("u1", storage), true);
    assert.equal(readCalendarFlag("u2", storage), false);
  });

  it("works without storage and when storage throws", () => {
    assert.equal(readCalendarFlag("u1", null), null);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    writeCalendarFlag("u1", true, broken);
    assert.equal(readCalendarFlag("u1", broken), null);
    assert.equal(readLastAutoCheck("u1", broken), 0);
  });

  it("allows at most one automatic check per 10 minutes", () => {
    const storage = fake();
    assert.equal(isAutoCheckDue(readLastAutoCheck("u1", storage), 1_000_000), true);
    writeLastAutoCheck("u1", 1_000_000, storage);
    const last = readLastAutoCheck("u1", storage);
    assert.equal(isAutoCheckDue(last, 1_000_000 + AUTO_CHECK_INTERVAL_MS - 1), false);
    assert.equal(isAutoCheckDue(last, 1_000_000 + AUTO_CHECK_INTERVAL_MS), true);
    assert.equal(isAutoCheckDue(last, 500_000), true, "a clock that went backwards is treated as due");
  });

  it("doesn't count attention items as changes ready", () => {
    assert.equal(countActionableItems([{ kind: "push_create" }, { kind: "attention" }, { kind: "conflict" }]), 2);
  });
});
