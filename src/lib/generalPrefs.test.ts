import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_GENERAL_PREFS, generalPrefsSize, MAX_GENERAL_PREFS_BYTES, mergeGeneralPrefs, sanitizeGeneralPrefs, sanitizePartialPrefs,
} from "./generalPrefs";

describe("generalPrefs", () => {
  it("drops unknown keys and bad enum values", () => {
    assert.deepEqual(sanitizePartialPrefs({ studyViewMode: "list", evil: 1, viewerPdf: "viewer?url=", studyDock: "left" }), { studyViewMode: "list" });
  });
  it("rejects non-objects", () => {
    assert.deepEqual(sanitizePartialPrefs(null), {});
    assert.deepEqual(sanitizePartialPrefs([1]), {});
    assert.deepEqual(sanitizePartialPrefs("x"), {});
  });
  it("accepts null for studyDock", () => {
    assert.deepEqual(sanitizePartialPrefs({ studyDock: null }), { studyDock: null });
  });
  it("falls back to defaults", () => {
    assert.deepEqual(sanitizeGeneralPrefs({ readerZoom: "huge" }), DEFAULT_GENERAL_PREFS);
    assert.deepEqual(sanitizeGeneralPrefs(undefined), DEFAULT_GENERAL_PREFS);
  });
  it("merges only the sent keys", () => {
    const stored = { studyViewMode: "list", viewerPdf: "drive-preview" };
    assert.deepEqual(mergeGeneralPrefs(stored, { studySort: "title" }), {
      ...DEFAULT_GENERAL_PREFS, studyViewMode: "list", viewerPdf: "drive-preview", studySort: "title",
    });
  });
  it("stays well under 1 KB", () => {
    const biggest = sanitizeGeneralPrefs({ studyViewMode: "list", studySort: "title", studyDock: "bottom", readerZoom: "fit-page", viewerPdf: "drive-preview", viewerGoogleDoc: "google-preview", viewerGoogleSheet: "google-preview", viewerOffice: "drive-preview" });
    assert.ok(generalPrefsSize(biggest) < MAX_GENERAL_PREFS_BYTES);
  });
});
