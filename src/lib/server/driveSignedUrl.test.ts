import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { signDriveUrl, verifyDriveUrl, type DriveSignedUrlInput } from "./driveSignedUrl";

const originalSecret = process.env.DRIVE_URL_SIGNING_SECRET;
const now = 1_800_000_000_000;
const base: DriveSignedUrlInput = {
  uid: "user-123",
  fileId: "0123456789_fileABC",
  connectionId: "0123456789connection",
  purpose: "stream",
};

before(() => {
  process.env.DRIVE_URL_SIGNING_SECRET = "test-drive-url-signing-secret";
});

after(() => {
  if (originalSecret === undefined) delete process.env.DRIVE_URL_SIGNING_SECRET;
  else process.env.DRIVE_URL_SIGNING_SECRET = originalSecret;
});

describe("signed Drive URLs", () => {
  it("accepts a valid signature", () => {
    const signed = signDriveUrl(base, now);
    assert.equal(verifyDriveUrl({ ...base, ...signed }, now), true);
  });

  it("rejects expired URLs", () => {
    const signed = signDriveUrl(base, now);
    assert.equal(verifyDriveUrl({ ...base, ...signed }, now + 6 * 60 * 60 * 1000), false);
  });

  it("rejects tampered signatures", () => {
    const signed = signDriveUrl(base, now);
    assert.equal(verifyDriveUrl({ ...base, ...signed, sig: `${signed.sig}x` }, now), false);
  });

  it("rejects a signature used for a different purpose", () => {
    const signed = signDriveUrl(base, now);
    assert.equal(verifyDriveUrl({ ...base, ...signed, purpose: "download" }, now), false);
  });

  it("rejects a signature used by another user", () => {
    const signed = signDriveUrl(base, now);
    assert.equal(verifyDriveUrl({ ...base, ...signed, uid: "user-456" }, now), false);
  });
});

describe("signed Drive URLs for Google exports", () => {
  const exportInput: DriveSignedUrlInput = { ...base, purpose: "export" };

  it("accepts a valid export signature", () => {
    const signed = signDriveUrl(exportInput, now);
    assert.equal(verifyDriveUrl({ ...exportInput, ...signed }, now), true);
  });

  it("rejects an export signature presented for the wrong purpose", () => {
    const signed = signDriveUrl(exportInput, now);
    for (const purpose of ["stream", "download", "export_download"] as const) {
      assert.equal(verifyDriveUrl({ ...exportInput, ...signed, purpose }, now), false);
    }
  });

  it("rejects tampered and expired export URLs", () => {
    const signed = signDriveUrl(exportInput, now);
    assert.equal(verifyDriveUrl({ ...exportInput, ...signed, sig: `${signed.sig}x` }, now), false);
    assert.equal(verifyDriveUrl({ ...exportInput, ...signed, fileId: "0123456789_otherFile" }, now), false);
    assert.equal(verifyDriveUrl({ ...exportInput, ...signed }, now + 30 * 60 * 1000), false);
    const download = signDriveUrl({ ...exportInput, purpose: "export_download" }, now);
    assert.equal(verifyDriveUrl({ ...exportInput, purpose: "export_download", ...download }, now + 10 * 60 * 1000), false);
  });
});
