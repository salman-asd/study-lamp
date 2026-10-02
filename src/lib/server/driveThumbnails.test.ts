import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInlineThumbnailDataUrl, resizeDriveThumbnailUrl } from "./driveThumbnails";

describe("Drive thumbnail helpers", () => {
  it("requests a 320px Google thumbnail while preserving query parameters", () => {
    assert.equal(resizeDriveThumbnailUrl("https://googleusercontent.test/thumb=s220"), "https://googleusercontent.test/thumb=s320");
    assert.equal(resizeDriveThumbnailUrl("https://googleusercontent.test/thumb?s=old"), "https://googleusercontent.test/thumb=s320?s=old");
  });

  it("only creates bounded inline data URLs for images", () => {
    assert.match(createInlineThumbnailDataUrl(Buffer.from("small"), "image/jpeg") || "", /^data:image\/jpeg;base64,/);
    assert.equal(createInlineThumbnailDataUrl(Buffer.from("small"), "application/octet-stream"), null);
    assert.equal(createInlineThumbnailDataUrl(Buffer.alloc(40 * 1024), "image/jpeg"), null);
  });
});