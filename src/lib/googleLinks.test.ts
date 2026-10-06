import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatGoogleModified, googleNativeLabel, googleOpenUrl } from "./googleLinks";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789";

describe("Open in Google link", () => {
  it("builds Doc and Sheet URLs from a valid id", () => {
    assert.equal(googleOpenUrl(DOC, id), `https://docs.google.com/document/d/${id}/edit`);
    assert.equal(googleOpenUrl(SHEET, id), `https://docs.google.com/spreadsheets/d/${id}/edit`);
  });

  it("rejects invalid ids and non-native types", () => {
    assert.equal(googleOpenUrl(DOC, "../evil"), null);
    assert.equal(googleOpenUrl(DOC, "short"), null);
    assert.equal(googleOpenUrl(DOC, `${id}?x=1`), null);
    assert.equal(googleOpenUrl("application/pdf", id), null);
    assert.equal(googleOpenUrl(undefined, id), null);
  });
});

describe("Google badge and last-changed text", () => {
  it("labels native types only", () => {
    assert.equal(googleNativeLabel(DOC), "Google Doc");
    assert.equal(googleNativeLabel(SHEET), "Google Sheet");
    assert.equal(googleNativeLabel("application/pdf"), null);
  });

  it("formats valid times and hides missing or invalid ones", () => {
    assert.ok(formatGoogleModified("2026-10-03T12:00:00.000Z"));
    assert.equal(formatGoogleModified(null), null);
    assert.equal(formatGoogleModified("not a date"), null);
  });
});
