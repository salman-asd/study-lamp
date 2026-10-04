import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { driveRevisionKey, isSameDriveRevision } from "./documentContentUtils";

describe("document cache revision checks", () => {
  it("prefers Drive's checksum and invalidates changed content", () => {
    assert.equal(isSameDriveRevision({ md5Checksum: "old", modifiedTime: "same" }, { md5Checksum: "new", modifiedTime: "same" }), false);
    assert.equal(isSameDriveRevision({ md5Checksum: "same" }, { md5Checksum: "same" }), true);
  });

  it("uses modifiedTime when Drive does not provide a checksum", () => {
    assert.equal(driveRevisionKey({ modifiedTime: "2026-10-03T12:00:00Z" }), "modified:2026-10-03T12:00:00Z");
    assert.equal(isSameDriveRevision({ modifiedTime: "v1" }, { modifiedTime: "v1" }), true);
    assert.equal(isSameDriveRevision({}, {}), false);
  });
});