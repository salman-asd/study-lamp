import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlanItem } from "@/lib/sync/plan";
import { getDefaultSelectedItemIds, getDialogSummary } from "./ConfirmChangesDialog";

describe("ConfirmChangesDialog helpers", () => {
  it("defaults to selected items except conflicts and destructive changes", () => {
    const items = [
      buildPlanItem({
        kind: "push_update",
        target: "goal:1",
        goalId: "1",
        title: "Goal 1",
        fields: [{ name: "title", before: "Old", after: "New" }],
      }),
      buildPlanItem({
        kind: "conflict",
        target: "goal:2",
        goalId: "2",
        title: "Conflict",
        fields: [{ name: "targetDate", before: "2026-01-01", after: "2026-01-10" }],
      }),
      buildPlanItem({
        kind: "remote_deleted",
        target: "goal:3",
        goalId: "3",
        title: "Delete",
        fields: [{ name: "title", before: "X", after: null }],
        risk: "destructive",
      }),
    ];

    const selected = getDefaultSelectedItemIds(items);
    assert.equal(selected.has(items[0].itemId), true);
    assert.equal(selected.has(items[1].itemId), false);
    assert.equal(selected.has(items[2].itemId), false);
  });

  it("summarizes selection counts correctly", () => {
    const items = [
      buildPlanItem({ kind: "push_update", target: "goal:1", goalId: "1", title: "Goal 1", fields: [] }),
      buildPlanItem({ kind: "pull_update", target: "goal:2", goalId: "2", title: "Goal 2", fields: [] }),
      buildPlanItem({ kind: "conflict", target: "goal:3", goalId: "3", title: "Goal 3", fields: [] }),
    ];

    const selected = new Set([items[0].itemId, items[1].itemId]);
    const summary = getDialogSummary(items, selected);
    assert.equal(summary.selectedCount, 2);
    assert.equal(summary.pushCount, 1);
    assert.equal(summary.pullCount, 1);
    assert.equal(summary.conflicts, 1);
  });
});
