import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideField } from "./threeWay";

describe("decideField", () => {
  it("reports unchanged and converged states correctly", () => {
    assert.equal(decideField({ base: "same", local: "same", remote: "same" }), "unchanged");
    assert.equal(decideField({ base: "base", local: "remote", remote: "remote" }), "converged");
  });

  it("detects push and pull directions without a winner", () => {
    assert.equal(decideField({ base: "base", local: "new", remote: "base" }), "push");
    assert.equal(decideField({ base: "base", local: "base", remote: "new" }), "pull");
  });

  it("treats a first link with diverging values as a conflict", () => {
    assert.equal(decideField({ base: undefined, local: "a", remote: "b" }), "conflict");
  });

  it("flags simultaneous edits as a conflict", () => {
    assert.equal(decideField({ base: "base", local: "local", remote: "remote" }), "conflict");
  });
});
