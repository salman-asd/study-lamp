import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkRateLimit } from "./rateLimit";

describe("checkRateLimit", () => {
  it("limits requests by uid and scope within a sliding window", () => {
    const options = { scope: "test-window-a", limit: 2, windowMs: 1000, now: 10_000 };
    assert.equal(checkRateLimit("uid-a", options), true);
    assert.equal(checkRateLimit("uid-a", options), true);
    assert.equal(checkRateLimit("uid-a", options), false);
    assert.equal(checkRateLimit("uid-b", options), true);
    assert.equal(checkRateLimit("uid-a", { ...options, now: 11_001 }), true);
  });

  it("defaults to 60 requests per minute", () => {
    const options = { scope: "test-default-b", now: 20_000 };
    for (let index = 0; index < 60; index++) assert.equal(checkRateLimit("uid", options), true);
    assert.equal(checkRateLimit("uid", options), false);
  });
});