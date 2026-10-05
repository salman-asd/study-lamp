/**
 * Z3 tests for applyGate, planToken (one-time tokens), googleSyncLog (prune),
 * and ConfirmChangesDialog helpers.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { buildPlanItem } from "@/lib/sync/plan";
import { applyConfirmed } from "@/lib/server/applyGate";
import { signPlanToken, verifyPlanToken, PlanTokenVerificationError } from "@/lib/server/planToken";
import { pruneGoogleSyncLog, logSyncApplied, type GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import { getDefaultSelectedItemIds, getDialogSummary, groupConflictFields } from "@/components/sync/ConfirmChangesDialog";

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.DRIVE_URL_SIGNING_SECRET = "test-z3-secret";
});

// ─── applyGate Z3 item 1 ────────────────────────────────────────────────────

describe("applyGate Z3", () => {
  it("writer returns skip → outcome is 'skipped' not 'applied'", async () => {
    const item = buildPlanItem({
      kind: "push_update",
      target: "goal:g1",
      goalId: "g1",
      title: "Goal 1",
      fields: [{ name: "title", before: "Old", after: "New", direction: "study_lamp" }],
      localValue: "New",
      remoteVersion: "etag1",
    });

    const token = signPlanToken({ uid: "u1", scope: "calendar", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }], exp: 2_000_000_000 });

    const results = await applyConfirmed({
      token,
      accepted: [item.itemId],
      freshPlan: [item],
      writers: {
        [item.itemId]: async () => ({ skipped: "goal_missing" }),
      },
      expectedUser: "u1",
      expectedScope: "calendar",
    });

    assert.equal(results.find((r) => r.itemId === item.itemId)?.status, "skipped");
    assert.equal(results.find((r) => r.itemId === item.itemId)?.code, "goal_missing");
  });

  it("writer throws → outcome is 'failed'", async () => {
    const item = buildPlanItem({
      kind: "push_update",
      target: "goal:g2",
      goalId: "g2",
      title: "Goal 2",
      fields: [{ name: "title", before: "Old", after: "New", direction: "study_lamp" }],
      localValue: "New",
      remoteVersion: "etag2",
    });

    const token = signPlanToken({ uid: "u1", scope: "calendar", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }], exp: 2_000_000_000 });

    const results = await applyConfirmed({
      token,
      accepted: [item.itemId],
      freshPlan: [item],
      writers: {
        [item.itemId]: async () => { throw new Error("Google 412"); },
      },
      expectedUser: "u1",
      expectedScope: "calendar",
    });

    assert.equal(results.find((r) => r.itemId === item.itemId)?.status, "failed");
  });

  it("token item missing from fresh plan → 'stale' with code item_gone", async () => {
    const item = buildPlanItem({
      kind: "push_update",
      target: "goal:g3",
      goalId: "g3",
      title: "Goal 3",
      fields: [{ name: "title", before: "A", after: "B", direction: "study_lamp" }],
      localValue: "B",
      remoteVersion: "etag3",
    });

    const token = signPlanToken({ uid: "u2", scope: "calendar", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }], exp: 2_000_000_000 });

    // freshPlan is EMPTY — the item is gone
    const results = await applyConfirmed({
      token,
      accepted: [item.itemId],
      freshPlan: [],
      writers: { [item.itemId]: async () => { throw new Error("Should not be called"); } },
      expectedUser: "u2",
      expectedScope: "calendar",
    });

    const decision = results.find((r) => r.itemId === item.itemId);
    assert.ok(decision, "should have a decision for the missing item");
    assert.equal(decision.status, "stale");
    assert.equal(decision.code, "item_gone");
  });

  it("writer returns void (success) → outcome is 'applied'", async () => {
    const item = buildPlanItem({
      kind: "push_update",
      target: "goal:g4",
      goalId: "g4",
      title: "Goal 4",
      fields: [{ name: "targetDate", before: "2026-01-01", after: "2026-02-01", direction: "study_lamp" }],
      localValue: "2026-02-01",
      remoteVersion: "etag4",
    });

    const token = signPlanToken({ uid: "u3", scope: "calendar", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }], exp: 2_000_000_000 });

    const results = await applyConfirmed({
      token,
      accepted: [item.itemId],
      freshPlan: [item],
      writers: { [item.itemId]: async () => undefined },
      expectedUser: "u3",
      expectedScope: "calendar",
    });

    assert.equal(results.find((r) => r.itemId === item.itemId)?.status, "applied");
  });
});

// ─── planToken jti (Z3 item 6) ────────────────────────────────────────────

describe("planToken Z3 — jti field", () => {
  it("signed token includes a non-empty jti in the verified payload", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-z3-secret";
    const token = signPlanToken({ uid: "u1", scope: "calendar", items: [], exp: 2_000_000_000 });
    const verified = verifyPlanToken(token, "u1", "calendar", 1_500_000_000_000);
    assert.ok(typeof verified.jti === "string" && verified.jti.length > 0, "jti should be present");
  });

  it("two tokens for the same input have different jti values", () => {
    process.env.DRIVE_URL_SIGNING_SECRET = "test-z3-secret";
    const t1 = signPlanToken({ uid: "u1", scope: "calendar", items: [], exp: 2_000_000_000 });
    const t2 = signPlanToken({ uid: "u1", scope: "calendar", items: [], exp: 2_000_000_000 });
    const v1 = verifyPlanToken(t1, "u1", "calendar", 1_500_000_000_000);
    const v2 = verifyPlanToken(t2, "u1", "calendar", 1_500_000_000_000);
    assert.notEqual(v1.jti, v2.jti, "jti must be unique per token");
  });
});

// ─── googleSyncLog prune (Z3 item 4) ────────────────────────────────────────

describe("pruneGoogleSyncLog Z3", () => {
  function makeEntry(i: number): GoogleSyncLogEntry {
    return {
      at: new Date(i * 1000).toISOString(),
      scope: "calendar",
      direction: "push",
      itemKind: "push_update",
      goalId: `goal-${i}`,
      titleSnapshot: `Goal ${i}`,
      fields: [],
      result: "applied",
    };
  }

  it("does not prune when at or below the threshold (220)", () => {
    const entries = Array.from({ length: 220 }, (_, i) => makeEntry(i));
    const pruned = pruneGoogleSyncLog(entries, 200, 220);
    assert.equal(pruned.length, 220, "should keep all 220 when exactly at threshold");
  });

  it("prunes down to maxEntries (200) when exceeding the threshold (221)", () => {
    const entries = Array.from({ length: 221 }, (_, i) => makeEntry(i));
    const pruned = pruneGoogleSyncLog(entries, 200, 220);
    assert.equal(pruned.length, 200, "should prune to 200 when over threshold");
  });

  it("logSyncApplied sets result to applied", () => {
    const entry = logSyncApplied({
      at: new Date().toISOString(),
      scope: "calendar",
      direction: "push",
      itemKind: "push_update",
      titleSnapshot: "T",
      fields: [],
    });
    assert.equal(entry.result, "applied");
  });
});

// ─── ConfirmChangesDialog pure helpers (Z3 item 8) ───────────────────────────

describe("ConfirmChangesDialog Z3", () => {
  it("groupConflictFields separates fields with direction (decided) from those without (conflicting)", () => {
    const fields = [
      { name: "title", before: "A", after: "B" },          // no direction → conflict
      { name: "targetDate", before: "2026-01-01", after: "2026-02-01", direction: "study_lamp" as const }, // decided
    ];

    const { conflicting, nonConflicting } = groupConflictFields(fields);
    assert.equal(conflicting.length, 1, "title field has no direction → conflicting");
    assert.equal(nonConflicting.length, 1, "targetDate has direction → decided");
  });

  it("getDefaultSelectedItemIds excludes conflicts and destructive items", () => {
    const items = [
      buildPlanItem({ kind: "push_update", target: "goal:1", goalId: "1", title: "Push", fields: [] }),
      buildPlanItem({ kind: "conflict", target: "goal:2", goalId: "2", title: "Conflict", fields: [] }),
      buildPlanItem({ kind: "remote_deleted", target: "goal:3", goalId: "3", title: "Delete", fields: [], risk: "destructive" }),
    ];

    const selected = getDefaultSelectedItemIds(items);
    assert.ok(selected.has(items[0].itemId), "push item should be selected by default");
    assert.ok(!selected.has(items[1].itemId), "conflict item should not be selected by default");
    assert.ok(!selected.has(items[2].itemId), "destructive item should not be selected by default");
  });

  it("getDialogSummary counts push, pull, conflict and destructive correctly", () => {
    const items = [
      buildPlanItem({ kind: "push_update", target: "goal:1", goalId: "1", title: "G1", fields: [] }),
      buildPlanItem({ kind: "pull_update", target: "goal:2", goalId: "2", title: "G2", fields: [] }),
      buildPlanItem({ kind: "conflict", target: "goal:3", goalId: "3", title: "G3", fields: [] }),
      buildPlanItem({ kind: "remote_deleted", target: "goal:4", goalId: "4", title: "G4", fields: [], risk: "destructive" }),
    ];
    const selected = new Set([items[0].itemId, items[1].itemId, items[3].itemId]);
    const summary = getDialogSummary(items, selected);
    assert.equal(summary.selectedCount, 3);
    assert.equal(summary.pushCount, 1);
    assert.equal(summary.pullCount, 1);
    assert.equal(summary.conflicts, 1);
    assert.equal(summary.destructive, 1, "destructive count is only for selected destructive items");
  });
});
