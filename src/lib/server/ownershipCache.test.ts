import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OwnershipCache, chunkItems, groupBy } from "./ownershipCache";

describe("OwnershipCache", () => {
  it("remembers a positive answer until the TTL passes", () => {
    const cache = new OwnershipCache(60_000);
    const key = OwnershipCache.key("uid", "conn", "file");
    assert.equal(cache.has(key, 1_000), false);
    cache.add(key, 1_000);
    assert.equal(cache.has(key, 30_000), true);
    assert.equal(cache.has(key, 61_000), false);
    assert.equal(cache.size, 0, "expired entries are dropped on lookup");
  });

  it("keys by uid so one user's cache entry never answers for another", () => {
    const cache = new OwnershipCache();
    cache.add(OwnershipCache.key("uid-a", "conn", "file"), 0);
    assert.equal(cache.has(OwnershipCache.key("uid-b", "conn", "file"), 1), false);
    assert.equal(cache.has(OwnershipCache.key("uid-a", "conn", "file"), 1), true);
  });

  it("evicts the oldest entries beyond maxEntries", () => {
    const cache = new OwnershipCache(60_000, 2);
    cache.add("a", 0);
    cache.add("b", 0);
    cache.add("c", 0);
    assert.equal(cache.has("a", 1), false);
    assert.equal(cache.has("b", 1), true);
    assert.equal(cache.has("c", 1), true);
  });

  it("can drop an entry explicitly", () => {
    const cache = new OwnershipCache();
    cache.add("a", 0);
    cache.delete("a");
    assert.equal(cache.has("a", 1), false);
  });
});

describe("batch helpers", () => {
  it("chunks into groups of at most the given size (Firestore `in` limit)", () => {
    const ids = Array.from({ length: 65 }, (_, index) => `f${index}`);
    const chunks = chunkItems(ids, 30);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [30, 30, 5]);
    assert.deepEqual(chunks.flat(), ids);
    assert.deepEqual(chunkItems([], 30), []);
  });

  it("groups by key preserving order", () => {
    const groups = groupBy(
      [{ c: "x", f: 1 }, { c: "y", f: 2 }, { c: "x", f: 3 }],
      (item) => item.c,
    );
    assert.deepEqual(Array.from(groups.keys()), ["x", "y"]);
    assert.deepEqual(groups.get("x")?.map((item) => item.f), [1, 3]);
  });
});
