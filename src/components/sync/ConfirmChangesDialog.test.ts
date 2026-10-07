import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlanItem } from "@/lib/sync/plan";
import {
  buildApplyPayload,
  describeFieldChange,
  getDefaultResolutions,
  getDefaultSelectedItemIds,
  getDialogSummary,
  isSelectableItem,
  kindLabel,
  serviceNoun,
  unresolvedConflictItemIds,
} from "./ConfirmChangesDialog";

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

const conflictItem = () =>
  buildPlanItem({
    kind: "conflict",
    target: "goal:c",
    goalId: "c",
    title: "Conflicted goal",
    fields: [
      { name: "title", before: "A", after: "B", local: "A", remote: "B" },
      { name: "targetDate", before: "2026-10-14", after: "2026-10-12", local: "2026-10-14", remote: "2026-10-12" },
    ],
  });
const deletedItem = () => buildPlanItem({ kind: "remote_deleted", target: "goal:d", goalId: "d", title: "Deleted in Google", fields: [] });

describe("ConfirmChangesDialog Z4 helpers", () => {
  it("does not tick events deleted in Google, imports or attention items by default", () => {
    const items = [
      buildPlanItem({ kind: "push_update", target: "goal:1", goalId: "1", title: "P", fields: [] }),
      deletedItem(),
      buildPlanItem({ kind: "pull_create", target: "calendar-event:x", remoteId: "x", title: "Import", fields: [] }),
      buildPlanItem({ kind: "attention", target: "calendar-event:y", remoteId: "y", title: "Timed", fields: [], reason: "timed" }),
    ];
    assert.deepEqual([...getDefaultSelectedItemIds(items)], [items[0].itemId]);
  });

  it("defaults an event deleted in Google to 'unlink' (the safe choice)", () => {
    const item = deletedItem();
    assert.deepEqual(getDefaultResolutions([item]), { [item.itemId]: "unlink" });
  });

  it("a goal-linked attention item can't be ticked; an event-only one can (to hide it)", () => {
    const linked = buildPlanItem({ kind: "attention", target: "goal:1", goalId: "1", title: "G", fields: [], reason: "multi_day" });
    const eventOnly = buildPlanItem({ kind: "attention", target: "calendar-event:y", remoteId: "y", title: "E", fields: [], reason: "timed" });
    assert.equal(isSelectableItem(linked), false);
    assert.equal(isSelectableItem(eventOnly), true);
  });

  it("describes the direction in words", () => {
    assert.match(describeFieldChange({ name: "targetDate", before: "2026-10-10", after: "2026-10-12", direction: "google" }), /^Study Lamp will change: Due date 2026-10-10 → 2026-10-12$/);
    assert.match(describeFieldChange({ name: "completed", before: false, after: true, direction: "study_lamp" }), /^Google Calendar will change: Completed Not done → Done$/);
    assert.match(describeFieldChange({ name: "title", before: "A", after: "B", local: "A", remote: "B" }), /different in both places: Study Lamp has A, Google has B/);
  });

  it("a ticked conflict with every field on 'skip' blocks Apply and says why", () => {
    const item = conflictItem();
    const built = buildApplyPayload({ items: [item], selectedIds: new Set([item.itemId]), resolutions: {}, deleteAck: new Set() });
    assert.match(built.blockedReason ?? "", /Choose Study Lamp or Google/);
    assert.deepEqual(unresolvedConflictItemIds([item], new Set([item.itemId]), {}), [item.itemId]);
  });

  it("one resolved field is enough; the payload carries the per-field keys", () => {
    const item = conflictItem();
    const resolutions = { [`${item.itemId}:title`]: "use_google" as const };
    const built = buildApplyPayload({ items: [item], selectedIds: new Set([item.itemId]), resolutions, deleteAck: new Set() });
    assert.equal(built.blockedReason, null);
    assert.deepEqual(built.payload.resolutions, resolutions);
    assert.deepEqual(built.payload.confirmedDestructive, []);
  });

  it("a conflict whose other fields are already decided is not blocked even if every conflicting field is on skip", () => {
    const item = buildPlanItem({
      kind: "conflict",
      target: "goal:c",
      goalId: "c",
      title: "Mixed",
      fields: [
        { name: "title", before: "A", after: "B", local: "A", remote: "B" },
        { name: "completed", before: false, after: true, direction: "study_lamp" },
      ],
    });
    assert.equal(buildApplyPayload({ items: [item], selectedIds: new Set([item.itemId]), resolutions: {}, deleteAck: new Set() }).blockedReason, null);
  });

  it("'delete the goal' needs its own tick before it counts as confirmed", () => {
    const item = deletedItem();
    const selected = new Set([item.itemId]);
    const resolutions = { [item.itemId]: "delete_goal" as const };
    const blocked = buildApplyPayload({ items: [item], selectedIds: selected, resolutions, deleteAck: new Set() });
    assert.match(blocked.blockedReason ?? "", /confirm deleting/);
    assert.deepEqual(blocked.payload.confirmedDestructive, []);
    const ok = buildApplyPayload({ items: [item], selectedIds: selected, resolutions, deleteAck: new Set([item.itemId]) });
    assert.equal(ok.blockedReason, null);
    assert.deepEqual(ok.payload.confirmedDestructive, [item.itemId]);
    assert.equal(getDialogSummary([item], selected, resolutions).destructive, 1);
  });

  it("unlink and recreate are not destructive and need no extra tick", () => {
    const item = deletedItem();
    for (const choice of ["unlink", "recreate"] as const) {
      const built = buildApplyPayload({ items: [item], selectedIds: new Set([item.itemId]), resolutions: { [item.itemId]: choice }, deleteAck: new Set() });
      assert.equal(built.blockedReason, null);
      assert.deepEqual(built.payload.confirmedDestructive, []);
    }
  });

  it("ticking an event-only attention item sends the 'ignore' choice; unticked items send nothing", () => {
    const eventOnly = buildPlanItem({ kind: "attention", target: "calendar-event:y", remoteId: "y", title: "E", fields: [], reason: "timed" });
    const other = deletedItem();
    const built = buildApplyPayload({ items: [eventOnly, other], selectedIds: new Set([eventOnly.itemId]), resolutions: { [other.itemId]: "delete_goal" }, deleteAck: new Set() });
    assert.deepEqual(built.payload.resolutions, { [eventOnly.itemId]: "ignore" });
    assert.deepEqual(built.payload.accepted, [eventOnly.itemId]);
    assert.equal(built.blockedReason, null, "an unticked delete must not block anything");
  });
});

describe("ConfirmChangesDialog `service` prop (Google Tasks wording)", () => {
  it("serviceNoun says task for Tasks and event for Calendar (the default)", () => {
    assert.equal(serviceNoun("Google Tasks"), "task");
    assert.equal(serviceNoun("Google Calendar"), "event");
    assert.equal(serviceNoun(), "event");
  });

  it("names the right service in field sentences", () => {
    const field = { name: "completed", before: false, after: true, direction: "study_lamp" as const };
    assert.match(describeFieldChange(field, "Google Tasks"), /^Google Tasks will change:/);
    assert.match(describeFieldChange(field), /^Google Calendar will change:/);
  });

  it("uses Tasks labels for Tasks and never says Calendar for them", () => {
    for (const kind of ["push_create", "push_update", "remote_deleted", "pull_create"] as const) {
      assert.doesNotMatch(kindLabel(kind, "Google Tasks"), /calendar|event/i, kind);
    }
    assert.equal(kindLabel("push_create"), "Add to Google Calendar");
    assert.equal(kindLabel("conflict", "Google Tasks"), "Changed in both places");
  });
});
