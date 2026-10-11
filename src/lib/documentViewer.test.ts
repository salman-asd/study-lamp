import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GENERAL_PREFS } from "./generalPrefs";
import { previewUrl, readViewerOverride, resolveViewer, viewerOptionsFor, writeViewerOverride, type ViewerDoc } from "./documentViewer";

const ID = "1AbCdEfGhIjKlMnOpQ";
const pdf: ViewerDoc = { fileType: "pdf", mimeType: "application/pdf", driveFileId: ID };
const gdoc: ViewerDoc = { fileType: "docx", mimeType: "application/vnd.google-apps.document", googleNative: true, driveFileId: ID };
const gsheet: ViewerDoc = { fileType: "xlsx", mimeType: "application/vnd.google-apps.spreadsheet", googleNative: true, driveFileId: ID };
const docx: ViewerDoc = { fileType: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", driveFileId: ID };
const pptx: ViewerDoc = { fileType: "pptx", driveFileId: ID };

describe("resolveViewer", () => {
  it("defaults to the reader", () => {
    for (const doc of [pdf, gdoc, gsheet, docx]) assert.equal(resolveViewer(doc, DEFAULT_GENERAL_PREFS), "reader");
  });
  it("follows the per-type preference", () => {
    assert.equal(resolveViewer(pdf, { ...DEFAULT_GENERAL_PREFS, viewerPdf: "drive-preview" }), "drive-preview");
    assert.equal(resolveViewer(gdoc, { ...DEFAULT_GENERAL_PREFS, viewerGoogleDoc: "google-preview" }), "google-preview");
    assert.equal(resolveViewer(gsheet, { ...DEFAULT_GENERAL_PREFS, viewerGoogleSheet: "google-preview" }), "google-preview");
    assert.equal(resolveViewer(docx, { ...DEFAULT_GENERAL_PREFS, viewerOffice: "drive-preview" }), "drive-preview");
  });
  it("does not mix types", () => {
    assert.equal(resolveViewer(pdf, { ...DEFAULT_GENERAL_PREFS, viewerGoogleDoc: "google-preview" }), "reader");
  });
  it("override wins when valid, ignored when not", () => {
    assert.equal(resolveViewer(pdf, DEFAULT_GENERAL_PREFS, "drive-preview"), "drive-preview");
    assert.equal(resolveViewer(pdf, DEFAULT_GENERAL_PREFS, "google-preview"), "reader");
    assert.equal(resolveViewer(gdoc, { ...DEFAULT_GENERAL_PREFS, viewerGoogleDoc: "google-preview" }, "reader"), "reader");
  });
  it("pptx is always the drive preview with no menu", () => {
    assert.equal(resolveViewer(pptx, DEFAULT_GENERAL_PREFS, "reader"), "drive-preview");
    assert.deepEqual(viewerOptionsFor(pptx), []);
  });
});

describe("previewUrl", () => {
  it("builds only the embeddable preview URLs", () => {
    assert.equal(previewUrl(pdf, "drive-preview"), `https://drive.google.com/file/d/${ID}/preview`);
    assert.equal(previewUrl(gdoc, "google-preview"), `https://docs.google.com/document/d/${ID}/preview`);
    assert.equal(previewUrl(gsheet, "google-preview"), `https://docs.google.com/spreadsheets/d/${ID}/preview`);
    assert.equal(previewUrl(pdf, "reader"), null);
  });
  it("rejects bad ids and never uses the viewer service or signed URLs", () => {
    assert.equal(previewUrl({ ...pdf, driveFileId: "../x?y=1" }, "drive-preview"), null);
    for (const doc of [pdf, gdoc, gsheet, docx, pptx]) for (const kind of ["drive-preview", "google-preview"] as const) {
      const url = previewUrl(doc, kind);
      if (url) assert.ok(!url.includes("/viewer") && !url.includes("/api/drive/stream") && !url.includes("sig="));
    }
  });
});

describe("viewer override storage", () => {
  it("round-trips", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    assert.equal(readViewerOverride(storage, "d1"), null);
    writeViewerOverride(storage, "d1", "drive-preview");
    assert.equal(readViewerOverride(storage, "d1"), "drive-preview");
    writeViewerOverride(storage, "d1", null);
    assert.equal(readViewerOverride(storage, "d1"), null);
  });
});
