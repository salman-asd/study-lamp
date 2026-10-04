import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { needsThumbnailAttemptField } from "./driveThumbnails";

describe("needsThumbnailAttemptField", () => {
  it("is true only for Drive items where the key is missing", () => {
    assert.equal(needsThumbnailAttemptField({ driveFileId: "abc1234567" }), true);
    assert.equal(needsThumbnailAttemptField({ driveFileId: "abc1234567", thumbnailUrl: "/x" }), true);
  });
  it("is false when the key exists (null or a timestamp) or the item is not Drive-backed", () => {
    assert.equal(needsThumbnailAttemptField({ driveFileId: "abc1234567", thumbnailAttemptedAt: null }), false);
    assert.equal(needsThumbnailAttemptField({ driveFileId: "abc1234567", thumbnailAttemptedAt: new Date() }), false);
    assert.equal(needsThumbnailAttemptField({ title: "YouTube video" }), false);
    assert.equal(needsThumbnailAttemptField(undefined), false);
  });
});
