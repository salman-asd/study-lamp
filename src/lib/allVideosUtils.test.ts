import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapWithConcurrency, shouldApplyCachedSnapshot, videoKey } from "./allVideosUtils";

describe("all-videos helpers", () => {
  it("loads items with bounded concurrency while preserving input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 1));
      active--;
      return value * 2;
    });

    assert.equal(peak, 2);
    assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);
  });

  it("only publishes a cached snapshot when it would change what is shown", () => {
    assert.equal(shouldApplyCachedSnapshot({ currentUid: "a", currentLoading: false, targetUid: "a" }), false);
    assert.equal(shouldApplyCachedSnapshot({ currentUid: "a", currentLoading: true, targetUid: "a" }), true);
    assert.equal(shouldApplyCachedSnapshot({ currentUid: "b", currentLoading: false, targetUid: "a" }), true);
    assert.equal(shouldApplyCachedSnapshot({ currentUid: undefined, currentLoading: false, targetUid: "a" }), true);
  });

  it("does not collide shared and personal video IDs", () => {
    assert.notEqual(
      videoKey({ source: "shared", playlistId: "playlist", id: "same-id" }),
      videoKey({ source: "personal", playlistId: "playlist", id: "same-id" }),
    );
    assert.equal(videoKey({ playlistId: "playlist", id: "same-id" }), "shared:playlist:same-id");
  });
});