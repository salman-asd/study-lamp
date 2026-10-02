import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DriveTokenCache } from "./driveTokenCache";

describe("DriveTokenCache", () => {
  it("serves unexpired tokens without invoking the refresh loader again", async () => {
    const cache = new DriveTokenCache();
    let loads = 0;
    const load = async () => {
      loads++;
      return { token: "access-1", expiresAt: 200_000 };
    };

    assert.equal(await cache.get("uid:connection", load, 100_000), "access-1");
    assert.equal(await cache.get("uid:connection", load, 110_000), "access-1");
    assert.equal(loads, 1);
  });

  it("shares one in-flight refresh for concurrent requests", async () => {
    const cache = new DriveTokenCache();
    let loads = 0;
    let resolveLoad!: (value: { token: string; expiresAt: number }) => void;
    const load = () => {
      loads++;
      return new Promise<{ token: string; expiresAt: number }>((resolve) => { resolveLoad = resolve; });
    };

    const first = cache.get("uid:connection", load, 100_000);
    const second = cache.get("uid:connection", load, 100_000);
    resolveLoad({ token: "shared-access", expiresAt: 200_000 });
    assert.deepEqual(await Promise.all([first, second]), ["shared-access", "shared-access"]);
    assert.equal(loads, 1);
  });

  it("refreshes inside the expiry safety margin and after invalidation", async () => {
    const cache = new DriveTokenCache(500, 60_000);
    let loads = 0;
    const load = async () => ({ token: `access-${++loads}`, expiresAt: 200_000 });

    assert.equal(await cache.get("uid:connection", load, 100_000), "access-1");
    assert.equal(await cache.get("uid:connection", load, 140_001), "access-2");
    cache.invalidate("uid:connection");
    assert.equal(await cache.get("uid:connection", load, 140_002), "access-3");
  });

  it("evicts the least recently used token when capacity is exceeded", async () => {
    const cache = new DriveTokenCache(2, 0);
    let loads = 0;
    const load = async () => ({ token: `access-${++loads}`, expiresAt: 500_000 });

    await cache.get("a", load, 100_000);
    await cache.get("b", load, 100_000);
    await cache.get("a", load, 100_001);
    await cache.get("c", load, 100_002);
    await cache.get("a", load, 100_003);
    assert.equal(loads, 3);
    await cache.get("b", load, 100_004);
    assert.equal(loads, 4);
  });
});