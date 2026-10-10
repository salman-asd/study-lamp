import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RETRY_FAILED_BATCH,
  hasThumbnailsToFetch,
  limitRetryTargets,
  normalizeThumbnailStatus,
  shouldContinueThumbnailLoop,
  thumbnailStatusText,
} from "./driveThumbnailStatus";

describe("thumbnailStatusText", () => {
  it("shows missing and failed counts", () => {
    assert.equal(thumbnailStatusText({ missing: 3, failed: 1, legacy: 0 }), "Missing: 3 · Failed: 1");
    assert.equal(thumbnailStatusText({ missing: 0, failed: 0, legacy: 0 }), "Missing: 0 · Failed: 0");
  });

  it("mentions old-format thumbnails only when there are some", () => {
    assert.equal(thumbnailStatusText({ missing: 0, failed: 2, legacy: 4 }), "Missing: 0 · Failed: 2 · To migrate: 4");
  });
});

describe("normalizeThumbnailStatus", () => {
  it("accepts a valid payload", () => {
    assert.deepEqual(normalizeThumbnailStatus({ missing: 2, failed: 1, legacy: 0 }), { missing: 2, failed: 1, legacy: 0 });
  });

  it("turns junk into zeros instead of NaN or negatives", () => {
    assert.deepEqual(normalizeThumbnailStatus({ missing: "5", failed: -1, legacy: Number.NaN }), { missing: 0, failed: 0, legacy: 0 });
    assert.deepEqual(normalizeThumbnailStatus(null), { missing: 0, failed: 0, legacy: 0 });
    assert.deepEqual(normalizeThumbnailStatus({ missing: 2.9 }), { missing: 2, failed: 0, legacy: 0 });
  });
});

describe("hasThumbnailsToFetch", () => {
  it("counts missing and old-format items, not failed ones", () => {
    assert.equal(hasThumbnailsToFetch({ missing: 1, failed: 0, legacy: 0 }), true);
    assert.equal(hasThumbnailsToFetch({ missing: 0, failed: 0, legacy: 2 }), true);
    assert.equal(hasThumbnailsToFetch({ missing: 0, failed: 5, legacy: 0 }), false);
  });
});

describe("shouldContinueThumbnailLoop", () => {
  it("continues while work remains and progress was made", () => {
    assert.equal(shouldContinueThumbnailLoop({ processed: 25, remaining: 10 }), true);
  });

  it("stops when done, or when a round made no progress (never spins)", () => {
    assert.equal(shouldContinueThumbnailLoop({ processed: 25, remaining: 0 }), false);
    assert.equal(shouldContinueThumbnailLoop({ processed: 0, remaining: 10 }), false);
  });
});

describe("limitRetryTargets", () => {
  it("resets at most 50 items per call", () => {
    const many = Array.from({ length: 120 }, (_, index) => index);
    assert.equal(RETRY_FAILED_BATCH, 50);
    assert.equal(limitRetryTargets(many).length, 50);
    assert.equal(limitRetryTargets([1, 2, 3]).length, 3);
    assert.equal(limitRetryTargets(many, 0).length, 0);
  });
});
