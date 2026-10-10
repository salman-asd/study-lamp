import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitChipsForDisplay, tagFilterSummary } from "./tagFilterSummary";

describe("tagFilterSummary", () => {
  it("says All tags when nothing is selected", () => {
    assert.equal(tagFilterSummary([]), "All tags");
  });

  it("shows the tag name when exactly one is selected", () => {
    assert.equal(tagFilterSummary(["Physics"]), "Physics");
  });

  it("shows a count when several are selected so the control never grows", () => {
    assert.equal(tagFilterSummary(["Physics", "Math"]), "2 tags");
    assert.equal(tagFilterSummary(["a", "b", "c", "d", "e"]), "5 tags");
  });
});

describe("splitChipsForDisplay", () => {
  it("shows everything when the chips fit", () => {
    assert.deepEqual(splitChipsForDisplay(4, 6, false), { visible: 4, hidden: 0 });
    assert.deepEqual(splitChipsForDisplay(6, 6, false), { visible: 6, hidden: 0 });
  });

  it("collapses the overflow behind +N more", () => {
    assert.deepEqual(splitChipsForDisplay(9, 6, false), { visible: 6, hidden: 3 });
  });

  it("shows everything when expanded", () => {
    assert.deepEqual(splitChipsForDisplay(9, 6, true), { visible: 9, hidden: 0 });
  });
});
