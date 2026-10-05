import { chunkForBatches } from "@/lib/server/driveImportUtils";

/** The slice of a Firestore write batch that batchInsert uses (keeps the helper testable without Firebase). */
export interface InsertBatch {
  set(ref: any, data: Record<string, unknown>): unknown;
  update(ref: any, data: Record<string, unknown>): unknown;
  commit(): Promise<unknown>;
}
export interface InsertDb {
  batch(): InsertBatch;
}
export interface InsertRef {
  delete(): Promise<unknown>;
}

export interface BatchInsertOptions {
  /** Written with batch.update() in the LAST batch; one write per batch is reserved for it. */
  lastBatchUpdate?: { ref: any; data: Record<string, unknown> };
  /** On a failed commit, delete the docs earlier batches already committed (best effort), then rethrow. */
  rollback?: boolean;
  /** Maximum writes per batch. Default 400. */
  maxOps?: number;
}

/**
 * Inserts items[i] -> refs[i] in sequential Firestore batches (400 writes each, minus one reserved
 * when `lastBatchUpdate` is given). Data for each doc comes from `toData`. Batches are committed in
 * order, so a failure leaves earlier batches committed unless `rollback` is set.
 */
export async function batchInsert<T>(
  db: InsertDb,
  items: readonly T[],
  refs: readonly (InsertRef & object)[],
  toData: (item: T, index: number) => Record<string, unknown>,
  options: BatchInsertOptions = {},
): Promise<void> {
  if (items.length !== refs.length) throw new Error("batchInsert needs one ref per item.");
  const chunks = chunkForBatches(items, options.maxOps ?? 400, options.lastBatchUpdate ? 1 : 0);
  const committed: InsertRef[] = [];
  let offset = 0;
  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const batch = db.batch();
      const chunk = chunks[chunkIndex];
      chunk.forEach((item, index) => batch.set(refs[offset + index], toData(item, offset + index)));
      if (options.lastBatchUpdate && chunkIndex === chunks.length - 1) {
        batch.update(options.lastBatchUpdate.ref, options.lastBatchUpdate.data);
      }
      await batch.commit();
      committed.push(...refs.slice(offset, offset + chunk.length));
      offset += chunk.length;
    }
  } catch (error) {
    if (options.rollback) await Promise.allSettled(committed.map((ref) => ref.delete()));
    throw error;
  }
}
