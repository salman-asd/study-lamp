import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWithDriveToken } from "./driveRequest";

describe("runWithDriveToken", () => {
  it("invalidates and retries a Google 401 exactly once", async () => {
    const tokens = ["expired-token", "fresh-token"];
    const usedTokens: string[] = [];
    let invalidations = 0;

    const result = await runWithDriveToken(
      async () => tokens.shift()!,
      () => { invalidations++; },
      async (token) => {
        usedTokens.push(token);
        return new Response(null, { status: token === "expired-token" ? 401 : 200 });
      },
    );

    assert.equal(result.status, 200);
    assert.deepEqual(usedTokens, ["expired-token", "fresh-token"]);
    assert.equal(invalidations, 1);
  });

  it("does not retry a second 401", async () => {
    let calls = 0;
    let invalidations = 0;

    const result = await runWithDriveToken(
      async () => `token-${calls}`,
      () => { invalidations++; },
      async () => {
        calls++;
        return new Response(null, { status: 401 });
      },
    );

    assert.equal(result.status, 401);
    assert.equal(calls, 2);
    assert.equal(invalidations, 2);
  });

  it("retries status-bearing Drive errors", async () => {
    let calls = 0;
    const result = await runWithDriveToken(
      async () => "fresh-token",
      () => undefined,
      async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("unauthorized"), { status: 401 });
        return "ok";
      },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });
});