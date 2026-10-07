import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeApplyOutcome, describeAttentionReason, describeResultCode, summarizeApplyResults } from "./syncMessages";
import { AUTO_CHECK_INTERVAL_MS, countActionableItems, isAutoCheckDue, cacheSyncStateFromConnections, readCalendarFlag, readLastAutoCheck, readSyncConnectionId, readTasksFlag, syncCacheFromConnections, writeCalendarFlag, writeLastAutoCheck, writeSyncConnectionId, writeTasksFlag } from "./googleCalendarFlag";

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

describe("Google Tasks wording (audit L3)", () => {
  const reasons = ["timed", "multi_day", "cancelled", "no_date", "invalid_date", "empty_title", "title_too_long", "goal_has_no_date"] as const;

  it("attention reasons for Tasks never say event or calendar", () => {
    for (const reason of reasons) {
      const text = describeAttentionReason(reason, "tasks");
      assert.ok(text.length > 10, reason);
      assert.doesNotMatch(text, /event|calendar/i, reason);
    }
  });

  it("Calendar wording is unchanged by default", () => {
    assert.match(describeAttentionReason("cancelled"), /event/);
    assert.match(describeAttentionReason("goal_has_no_date", "calendar"), /calendar event/);
  });

  it("result codes for Tasks say task, not event", () => {
    for (const code of ["changed_remotely", "remote_missing", "remote_unsupported", "needs_attention", "remote_cancelled"]) {
      assert.doesNotMatch(describeResultCode(code, "tasks"), /event|calendar/i, code);
    }
  });
});

describe("Tasks flag and connection cache (audit M2, M3)", () => {
  const fake = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("keeps the Tasks flag separate from the Calendar flag", () => {
    const storage = fake();
    writeTasksFlag("u1", true, storage);
    assert.equal(readTasksFlag("u1", storage), true);
    assert.equal(readCalendarFlag("u1", storage), null);
  });

  it("remembers a connection id per service, rejects malformed values, and can forget it", () => {
    const storage = fake();
    writeSyncConnectionId("u1", "tasks", "abc123", storage);
    assert.equal(readSyncConnectionId("u1", "tasks", storage), "abc123");
    assert.equal(readSyncConnectionId("u1", "calendar", storage), null);
    storage.setItem("studylamp:gcal:connection:u1", "../evil");
    assert.equal(readSyncConnectionId("u1", "calendar", storage), null);
    writeSyncConnectionId("u1", "tasks", null, storage);
    assert.equal(readSyncConnectionId("u1", "tasks", storage), null);
  });

  it("caches an id only when exactly one usable connection has the sync on", () => {
    const list = [
      { id: "a", status: "active", calendarEnabled: true, tasksEnabled: false },
      { id: "b", status: "active", calendarEnabled: true, tasksEnabled: true },
      { id: "c", status: "invalid", calendarEnabled: false, tasksEnabled: true },
    ];
    assert.deepEqual(syncCacheFromConnections(list, "calendar"), { enabled: true, connectionId: null });
    assert.deepEqual(syncCacheFromConnections(list, "tasks"), { enabled: true, connectionId: "b" });
    assert.deepEqual(syncCacheFromConnections([], "tasks"), { enabled: false, connectionId: null });
    const storage = fake();
    cacheSyncStateFromConnections("u1", list, storage);
    assert.equal(readSyncConnectionId("u1", "tasks", storage), "b");
    assert.equal(readSyncConnectionId("u1", "calendar", storage), null);
  });
});
