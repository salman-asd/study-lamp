import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeHistoryEntry } from "./syncHistoryFormat";

describe("describeHistoryEntry", () => {
  it("writes direction, kind and result in words and shows field changes", () => {
    const line = describeHistoryEntry({
      at: "2026-10-07T10:00:00.000Z",
      scope: "tasks",
      direction: "google_to_study_lamp",
      itemKind: "pull_update",
      titleSnapshot: "Read chapter 3",
      fields: [{ name: "Target date", before: "2026-10-10", after: null }, { name: "Completed", before: false, after: true }],
      result: "applied",
    });
    assert.equal(line.title, "Read chapter 3");
    assert.match(line.meta, /Tasks/);
    assert.match(line.meta, /Google → Study Lamp/);
    assert.match(line.meta, /Updated here from Google/);
    assert.match(line.meta, /Applied/);
    assert.deepEqual(line.changes, ["Target date: 2026-10-10 → (none)", "Completed: no → yes"]);
  });

  it("copes with an unknown kind, a bad date and an empty title", () => {
    const line = describeHistoryEntry({ at: "nope", scope: "calendar", direction: "x", itemKind: "weird", titleSnapshot: "", fields: [], result: "failed" });
    assert.equal(line.title, "(untitled goal)");
    assert.match(line.meta, /Change/);
    assert.match(line.meta, /Failed/);
  });

  it("describes a removal as Study Lamp → Google", () => {
    const line = describeHistoryEntry({ at: "2026-10-07T10:00:00.000Z", scope: "calendar", direction: "study_lamp_to_google", itemKind: "remove", titleSnapshot: "Goal", fields: [], result: "applied" });
    assert.match(line.meta, /Removed from Google/);
    assert.match(line.meta, /Study Lamp → Google/);
  });
});
