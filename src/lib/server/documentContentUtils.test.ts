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

describe("Google-native revision keys (no md5Checksum)", () => {
  it("treats a null md5 with a changed modifiedTime as a new revision", () => {
    const cached = { md5Checksum: null, modifiedTime: "2026-10-03T12:00:00.000Z" };
    assert.equal(isSameDriveRevision(cached, { md5Checksum: null, modifiedTime: "2026-10-04T08:30:00.000Z" }), false);
  });

  it("reuses the cache when the modifiedTime is unchanged", () => {
    const cached = { md5Checksum: null, modifiedTime: "2026-10-03T12:00:00.000Z" };
    assert.equal(isSameDriveRevision(cached, { md5Checksum: null, modifiedTime: "2026-10-03T12:00:00.000Z" }), true);
  });

  it("never reuses the cache when neither side has a revision", () => {
    assert.equal(isSameDriveRevision({ md5Checksum: null, modifiedTime: null }, { md5Checksum: null, modifiedTime: null }), false);
  });
});
