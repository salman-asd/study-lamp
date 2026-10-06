import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIRESTORE_BATCH_LIMIT, assignDriveVideoOrders, chunkForBatches, dedupeDriveItems,
  importableDocumentType, partitionDriveFiles, uniqueIds,
} from "./driveImportUtils";

describe("Drive bulk import preparation", () => {
  it("filters existing and repeated files while preserving selection order", () => {
    const items = [
      { driveFileId: "existing", title: "Existing" },
      { driveFileId: "new-a", title: "A" },
      { driveFileId: "new-a", title: "Duplicate A" },
      { driveFileId: "new-b", title: "B" },
    ];

    assert.deepEqual(dedupeDriveItems(items, ["existing"]), [items[1], items[3]]);
  });

  it("assigns consecutive order values from the playlist count", () => {
    const items = [{ title: "A" }, { title: "B" }, { title: "C" }];

    assert.deepEqual(assignDriveVideoOrders(items, 12), [
      { item: items[0], order: 12 },
      { item: items[1], order: 13 },
      { item: items[2], order: 14 },
    ]);
  });
});

describe("partitionDriveFiles", () => {
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  it("splits videos, documents and skipped files in selection order", () => {
    const files = [
      { id: "v1", mimeType: "video/mp4" },
      { id: "d1", mimeType: "application/pdf" },
      { id: "x1", mimeType: xlsx },
      { id: "s1", mimeType: "image/png" },
      { id: "v2", mimeType: "video/quicktime" },
      { id: "w1", mimeType: docx },
      { id: "f1", mimeType: "application/vnd.google-apps.folder" },
    ];
    const result = partitionDriveFiles(files);
    assert.deepEqual(result.videos.map((file) => file.id), ["v1", "v2"]);
    assert.deepEqual(result.documents.map(({ file, fileType }) => [file.id, fileType]), [["d1", "pdf"], ["x1", "xlsx"], ["w1", "docx"]]);
    assert.deepEqual(result.skipped, [{ fileId: "s1", reason: "unsupported_type" }, { fileId: "f1", reason: "folder" }]);
  });

  it("never imports PowerPoint files", () => {
    assert.equal(importableDocumentType(pptx), null);
    assert.deepEqual(partitionDriveFiles([{ id: "p1", mimeType: pptx }]).skipped, [{ fileId: "p1", reason: "unsupported_type" }]);
  });

  it("removes repeated ids while keeping order", () => {
    assert.deepEqual(uniqueIds(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
  });
});

describe("chunkForBatches", () => {
  it("reserves one write per batch for the playlist update", () => {
    assert.equal(chunkForBatches(Array.from({ length: 399 }, (_, i) => i)).length, 1);
    const chunks = chunkForBatches(Array.from({ length: 450 }, (_, i) => i));
    assert.deepEqual(chunks.map((chunk) => chunk.length), [399, 51]);
    assert.ok(chunks.every((chunk) => chunk.length + 1 <= FIRESTORE_BATCH_LIMIT));
    assert.equal(chunkForBatches(Array.from({ length: 400 }, (_, i) => i)).length, 2);
  });

  it("returns no chunks for no items and rejects an impossible reservation", () => {
    assert.deepEqual(chunkForBatches([]), []);
    assert.throws(() => chunkForBatches([1], 1, 1));
  });
});

describe("partitionDriveFiles with Google-native files", () => {
  it("imports native Docs and Sheets as docx/xlsx with googleNative set, and skips Slides", () => {
    const result = partitionDriveFiles([
      { id: "gd1", mimeType: "application/vnd.google-apps.document" },
      { id: "gs1", mimeType: "application/vnd.google-apps.spreadsheet" },
      { id: "gp1", mimeType: "application/vnd.google-apps.presentation" },
      { id: "p1", mimeType: "application/pdf" },
    ]);
    assert.deepEqual(result.documents.map(({ file, fileType, googleNative }) => [file.id, fileType, googleNative]), [
      ["gd1", "docx", true],
      ["gs1", "xlsx", true],
      ["p1", "pdf", false],
    ]);
    assert.deepEqual(result.skipped, [{ fileId: "gp1", reason: "unsupported_type" }]);
  });
});
