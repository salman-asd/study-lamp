import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  isSupportedUploadMimeType,
  isValidDriveConnectionId,
  isValidDriveId,
  sanitizeDriveFileName,
  signDriveState,
  verifyDriveState,
} from "./googleDrive";

const originalSecret = process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET;
const now = 1_800_000_000_000;
const nonce = Buffer.alloc(32, 7).toString("base64url");

before(() => {
  process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET = "test-drive-oauth-state-secret";
});

after(() => {
  if (originalSecret === undefined) delete process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET;
  else process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET = originalSecret;
});

describe("Drive identifiers", () => {
  it("accepts only bounded Drive and connection IDs", () => {
    assert.equal(isValidDriveId("0123456789_abcdefghij"), true);
    assert.equal(isValidDriveId("../private"), false);
    assert.equal(isValidDriveId("short"), false);
    assert.equal(isValidDriveConnectionId("AbCd0123456789xyzXYZ"), true);
    assert.equal(isValidDriveConnectionId("../connection"), false);
  });

  it("accepts only supported upload MIME types and sanitizes filenames", () => {
    assert.equal(isSupportedUploadMimeType("video/mp4"), true);
    assert.equal(isSupportedUploadMimeType("application/pdf"), true);
    assert.equal(isSupportedUploadMimeType("application/octet-stream"), false);
    assert.equal(sanitizeDriveFileName("../folder\\video\u0000.mp4"), "..foldervideo.mp4");
    assert.equal(sanitizeDriveFileName("n".repeat(220)).length, 200);
  });
});

describe("Drive OAuth state", () => {
  it("verifies a valid signed state bound to its nonce", () => {
    const state = signDriveState("user-123", nonce, now);
    assert.deepEqual(verifyDriveState(state, nonce, now), { uid: "user-123", nonce });
  });

  it("rejects expired state", () => {
    const state = signDriveState("user-123", nonce, now - 600_001);
    assert.equal(verifyDriveState(state, nonce, now), null);
  });

  it("rejects tampered state", () => {
    const state = signDriveState("user-123", nonce, now);
    const decoded = Buffer.from(state, "base64url").toString("utf8").replace("user-123", "user-456");
    assert.equal(verifyDriveState(Buffer.from(decoded).toString("base64url"), nonce, now), null);
  });

  it("rejects a state replayed with a different browser nonce", () => {
    const state = signDriveState("user-123", nonce, now);
    const wrongNonce = Buffer.alloc(32, 8).toString("base64url");
    assert.equal(verifyDriveState(state, wrongNonce, now), null);
  });
});