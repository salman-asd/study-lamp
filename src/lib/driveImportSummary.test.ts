import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeBulkImport } from "./driveImportSummary";

describe("summarizeBulkImport", () => {
  it("lists added videos and documents with the skipped/duplicate count", () => {
    assert.equal(summarizeBulkImport({ addedVideos: 3, addedDocuments: 2, skipped: [{}], duplicates: 4 }), "Imported 3 videos, 2 documents (5 skipped/duplicates)");
    assert.equal(summarizeBulkImport({ addedVideos: 1, addedDocuments: 0, skipped: [], duplicates: 0 }), "Imported 1 video");
  });
  it("explains an import that added nothing", () => {
    assert.equal(summarizeBulkImport({ addedVideos: 0, addedDocuments: 0, skipped: [], duplicates: 30 }), "Nothing new to import (30 skipped/duplicates).");
    assert.equal(summarizeBulkImport({ addedVideos: 0, addedDocuments: 0, skipped: [], duplicates: 0 }), "Nothing to import.");
  });
});
