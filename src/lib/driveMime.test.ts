import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPickerMimeTypes, type DrivePickerKind } from "./driveMime";

describe("Drive picker MIME helpers", () => {
  it("maps typed picker kinds to Google Picker mime filters", () => {
    const types = buildPickerMimeTypes(["video", "pdf", "docx", "pptx", "xlsx"]);
    assert.deepEqual(types, [
      "video/*",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
  });

  it("accepts a subset of kinds without adding unsupported values", () => {
    const kinds: DrivePickerKind[] = ["video", "xlsx"];
    assert.deepEqual(buildPickerMimeTypes(kinds), ["video/*", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
  });
});
