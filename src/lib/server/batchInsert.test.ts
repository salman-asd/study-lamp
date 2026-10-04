import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchInsert, type InsertDb } from "./batchInsert";

function fakeDb(failOnCommit?: number) {
  const log: string[] = [];
  const batches: Array<{ sets: number; updates: number }> = [];
  let commits = 0;
  const db: InsertDb = {
    batch() {
      const current = { sets: 0, updates: 0 };
      return {
        set: () => { current.sets++; },
        update: () => { current.updates++; },
        commit: async () => {
          commits++;
          if (failOnCommit === commits) throw new Error("boom");
          batches.push(current);
        },
      };
    },
  };
  return { db, batches, log };
}
const makeRefs = (n: number, deleted: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ delete: async () => { deleted.push(i); } }));

describe("batchInsert", () => {
  it("splits into 400-write batches without a reserved slot when there is no last-batch update", async () => {
    const { db, batches } = fakeDb();
    await batchInsert(db, Array.from({ length: 850 }, (_, i) => i), makeRefs(850), (n) => ({ n }));
    assert.deepEqual(batches.map((b) => b.sets), [400, 400, 50]);
    assert.ok(batches.every((b) => b.updates === 0));
  });

  it("reserves one write per batch and puts the update only in the last batch", async () => {
    const { db, batches } = fakeDb();
    await batchInsert(db, Array.from({ length: 800 }, (_, i) => i), makeRefs(800), (n) => ({ n }), {
      lastBatchUpdate: { ref: {}, data: { x: 1 } },
    });
    assert.deepEqual(batches.map((b) => b.sets), [399, 399, 2]);
    assert.deepEqual(batches.map((b) => b.updates), [0, 0, 1]);
  });

  it("passes the item and its global index to toData", async () => {
    const { db } = fakeDb();
    const seen: Array<[string, number]> = [];
    await batchInsert(db, ["a", "b", "c"], makeRefs(3), (item, index) => { seen.push([item, index]); return {}; });
    assert.deepEqual(seen, [["a", 0], ["b", 1], ["c", 2]]);
  });

  it("with rollback, deletes only docs from batches that already committed, then rethrows", async () => {
    const { db } = fakeDb(2);
    const deleted: number[] = [];
    await assert.rejects(
      batchInsert(db, Array.from({ length: 900 }, (_, i) => i), makeRefs(900, deleted), () => ({}), { rollback: true }),
      /boom/,
    );
    assert.equal(deleted.length, 400);
    assert.equal(Math.max(...deleted), 399);
  });

  it("without rollback, leaves committed batches in place", async () => {
    const { db } = fakeDb(2);
    const deleted: number[] = [];
    await assert.rejects(batchInsert(db, Array.from({ length: 900 }, (_, i) => i), makeRefs(900, deleted), () => ({})), /boom/);
    assert.equal(deleted.length, 0);
  });

  it("rejects mismatched items and refs", async () => {
    const { db } = fakeDb();
    await assert.rejects(batchInsert(db, [1, 2], makeRefs(1), () => ({})), /one ref per item/);
  });
});
