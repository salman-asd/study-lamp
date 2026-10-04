import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeReaderProgress, isMeaningfulProgress, mergeReaderProgress, normalizeReaderProgress } from "./readerProgress";
import { createThrottle } from "./throttle";

describe("normalizeReaderProgress", () => {
  it("keeps a PDF document exactly { lastPage, zoom } and clamps both", () => {
    assert.deepEqual(normalizeReaderProgress({ lastPage: 12, zoom: 1.25 }, "pdf"), { lastPage: 12, zoom: 1.25 });
    assert.deepEqual(normalizeReaderProgress({ lastPage: 0, zoom: 99 }, "pdf"), { lastPage: 1, zoom: 10 });
    assert.deepEqual(normalizeReaderProgress({ lastPage: 3.6, zoom: 0.01 }, "pdf"), { lastPage: 4, zoom: 0.1 });
    assert.deepEqual(normalizeReaderProgress({ lastPage: 5, scrollRatio: 0.5, sheetIndex: 2 }, "pdf"), { lastPage: 5, zoom: 1 }, "other types' fields never leak into a PDF");
  });

  it("DOCX: lastPage is 1, scrollRatio is clamped to 0..1", () => {
    assert.deepEqual(normalizeReaderProgress({ lastPage: 9, scrollRatio: 1.7, zoom: 1.2 }, "docx"), { lastPage: 1, zoom: 1.2, scrollRatio: 1 });
    assert.deepEqual(normalizeReaderProgress({ scrollRatio: -3 }, "docx"), { lastPage: 1, zoom: 1, scrollRatio: 0 });
    assert.equal("scrollRatio" in normalizeReaderProgress({}, "docx"), false);
    assert.equal("scrollRatio" in normalizeReaderProgress({ scrollRatio: Number.NaN }, "docx"), false);
  });

  it("XLSX: sheetIndex 0..200 and rowIndex 0..1,000,000 as integers", () => {
    assert.deepEqual(normalizeReaderProgress({ sheetIndex: 1, rowIndex: 299 }, "xlsx"), { lastPage: 1, zoom: 1, sheetIndex: 1, rowIndex: 299 });
    assert.deepEqual(normalizeReaderProgress({ sheetIndex: 999, rowIndex: 5_000_000 }, "xlsx"), { lastPage: 1, zoom: 1, sheetIndex: 200, rowIndex: 1_000_000 });
    assert.deepEqual(normalizeReaderProgress({ sheetIndex: -4, rowIndex: 7.4 }, "xlsx"), { lastPage: 1, zoom: 1, sheetIndex: 0, rowIndex: 7 });
  });

  it("never produces undefined values (Firestore rejects them) and tolerates null/garbage", () => {
    for (const type of ["pdf", "docx", "xlsx"] as const) {
      const result = normalizeReaderProgress(null, type);
      assert.ok(Object.values(result).every((value) => value !== undefined));
      assert.deepEqual(normalizeReaderProgress({ lastPage: "x" as never, zoom: Infinity }, type).zoom, 1);
    }
  });
});

describe("mergeReaderProgress", () => {
  it("overrides with defined fields and keeps the rest", () => {
    assert.deepEqual(mergeReaderProgress({ lastPage: 3, zoom: 1 }, { lastPage: 8 }), { lastPage: 8, zoom: 1 });
    assert.deepEqual(mergeReaderProgress({ sheetIndex: 1, rowIndex: 40 }, { rowIndex: 80, sheetIndex: undefined }), { sheetIndex: 1, rowIndex: 80 });
    assert.deepEqual(mergeReaderProgress(null, { scrollRatio: 0.3 }), { scrollRatio: 0.3 });
    assert.deepEqual(mergeReaderProgress(undefined, undefined), {});
  });
});

describe("isMeaningfulProgress", () => {
  it("ignores 'page 1, top, first row'", () => {
    assert.equal(isMeaningfulProgress(null), false);
    assert.equal(isMeaningfulProgress({ lastPage: 1, zoom: 1 }), false);
    assert.equal(isMeaningfulProgress({ lastPage: 1, zoom: 1, scrollRatio: 0.005 }), false);
    assert.equal(isMeaningfulProgress({ sheetIndex: 0, rowIndex: 0 }), false);
  });
  it("accepts real positions, including old PDF-only objects", () => {
    assert.equal(isMeaningfulProgress({ lastPage: 5, zoom: 1 }), true);
    assert.equal(isMeaningfulProgress({ lastPage: 1, zoom: 1, scrollRatio: 0.45 }), true);
    assert.equal(isMeaningfulProgress({ sheetIndex: 1, rowIndex: 0 }), true);
    assert.equal(isMeaningfulProgress({ sheetIndex: 0, rowIndex: 300 }), true);
  });
});

describe("describeReaderProgress", () => {
  it("describes each file type", () => {
    assert.equal(describeReaderProgress({ lastPage: 12, zoom: 1 }, "pdf"), "Page 12");
    assert.equal(describeReaderProgress({ scrollRatio: 0.45 }, "docx"), "45% through");
    assert.equal(describeReaderProgress({ sheetIndex: 1, rowIndex: 299 }, "xlsx"), "Sheet 2, row 300");
    assert.equal(describeReaderProgress({ sheetIndex: 2, rowIndex: 0 }, "xlsx"), "Sheet 3");
  });
  it("handles old PDF-only objects and missing fields", () => {
    assert.equal(describeReaderProgress({ lastPage: 7, zoom: 1.5 }, "pdf"), "Page 7");
    assert.equal(describeReaderProgress({ lastPage: 7, zoom: 1.5 }, "docx"), "In progress");
    assert.equal(describeReaderProgress({ lastPage: 7, zoom: 1.5 }, "xlsx"), "Sheet 1");
  });
});

describe("createThrottle", () => {
  function harness(intervalMs: number) {
    let time = 0;
    const timers: Array<{ at: number; run: () => void; id: number }> = [];
    let nextId = 0;
    const calls: number[] = [];
    const throttle = createThrottle<number>((value) => calls.push(value), intervalMs, {
      now: () => time,
      setTimer: (run, ms) => { const id = nextId++; timers.push({ at: time + ms, run, id }); return id; },
      clearTimer: (handle) => { const index = timers.findIndex((timer) => timer.id === handle); if (index >= 0) timers.splice(index, 1); },
    });
    const advance = (ms: number) => {
      time += ms;
      for (const timer of timers.filter((entry) => entry.at <= time)) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
    };
    return { throttle, calls, advance };
  }

  it("runs the first call immediately and collapses a burst into one trailing call with the latest value", () => {
    const { throttle, calls, advance } = harness(1000);
    throttle.call(1); throttle.call(2); throttle.call(3);
    assert.deepEqual(calls, [1]);
    advance(999); assert.deepEqual(calls, [1]);
    advance(1); assert.deepEqual(calls, [1, 3]);
  });

  it("flush delivers the pending value now; cancel drops it", () => {
    const a = harness(1000);
    a.throttle.call(1); a.throttle.call(2); a.throttle.flush();
    assert.deepEqual(a.calls, [1, 2]);
    a.advance(5000); assert.deepEqual(a.calls, [1, 2]);

    const b = harness(1000);
    b.throttle.call(1); b.throttle.call(2); b.throttle.cancel(); b.advance(5000);
    assert.deepEqual(b.calls, [1]);
  });
});
