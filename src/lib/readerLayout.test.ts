import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideInitialZoom, followsContainer, readerHeightClass, readManualZoom, resolveStudyDock, writeManualZoom } from "./readerLayout";

describe("resolveStudyDock", () => {
  it("saved wins", () => {
    assert.equal(resolveStudyDock("hidden", 1800), "hidden");
    assert.equal(resolveStudyDock("right", 1100), "right");
  });
  it("auto by width", () => {
    assert.equal(resolveStudyDock(null, 1536), "right");
    assert.equal(resolveStudyDock(null, 1535), "bottom");
    assert.equal(resolveStudyDock(null, 1024), "bottom");
    assert.equal(resolveStudyDock(null, 1023), "hidden");
  });
});

describe("readerHeightClass", () => {
  it("differs per mode", () => {
    const classes = new Set([readerHeightClass("right", false), readerHeightClass("bottom", false), readerHeightClass("hidden", false), readerHeightClass("right", true)]);
    assert.equal(classes.size, 4);
    assert.equal(readerHeightClass("bottom", true), readerHeightClass("right", true));
  });
});

describe("decideInitialZoom", () => {
  it("uses a hand-set zoom only", () => {
    assert.equal(decideInitialZoom("fit-width", 1.8), 1.8);
    assert.equal(decideInitialZoom("fit-width", null), "fit-width");
    assert.equal(decideInitialZoom("fit-page", null), "fit-page");
    assert.equal(decideInitialZoom("actual", null), 1);
  });
  it("ignores an invalid manual zoom", () => {
    assert.equal(decideInitialZoom("fit-width", 99), "fit-width");
    assert.equal(decideInitialZoom("fit-width", Number.NaN), "fit-width");
  });
  it("fit modes follow the container, numbers do not", () => {
    assert.equal(followsContainer("fit-width"), true);
    assert.equal(followsContainer(1.2), false);
  });
});

describe("manual zoom storage", () => {
  it("round-trips and clears", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    assert.equal(readManualZoom(storage, "d1"), null);
    writeManualZoom(storage, "d1", 1.5);
    assert.equal(readManualZoom(storage, "d1"), 1.5);
    writeManualZoom(storage, "d1", null);
    assert.equal(readManualZoom(storage, "d1"), null);
  });
});
