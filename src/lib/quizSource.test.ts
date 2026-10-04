import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildVideoSourceHash, hashDocumentText } from "./quizSource";

describe("buildVideoSourceHash", () => {
  it("changes when the transcript changes, even if title/description/summary don't (Phase 5)", () => {
    const a = buildVideoSourceHash("Intro to plants", "desc", null, "Plants use chlorophyll.");
    const b = buildVideoSourceHash("Intro to plants", "desc", null, "Plants use chlorophyll and roots absorb water.");
    assert.notEqual(a, b);
  });

  it("changes when extracted document text changes", () => {
    const oldText = buildVideoSourceHash("Notes", null, null, hashDocumentText("first document revision"));
    const newText = buildVideoSourceHash("Notes", null, null, hashDocumentText("updated document revision"));
    assert.notEqual(oldText, newText);
  });

  it("stays backward compatible when transcript is omitted", () => {
    const withoutParam = buildVideoSourceHash("Intro to plants", "desc", "summary text");
    const withUndefined = buildVideoSourceHash("Intro to plants", "desc", "summary text", undefined);
    assert.equal(withoutParam, withUndefined);
  });

  it("is stable for the same inputs", () => {
    const a = buildVideoSourceHash("Title", "Description", "Summary", "Transcript");
    const b = buildVideoSourceHash("Title", "Description", "Summary", "Transcript");
    assert.equal(a, b);
  });
});
