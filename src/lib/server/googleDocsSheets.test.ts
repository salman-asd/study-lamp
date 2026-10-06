import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { GoogleApiError } from "./googleApiError";
import { appendToDocument, assertAllowedDocumentRequests, buildDocAppendRequests, getDocumentEnd } from "./googleDocs";
import { SHEET_TAB, appendRows, assertAllowedSheetRequests, createSheet, getSheetTabState, quoteSheetTab } from "./googleSheets";

type Call = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;

function stubFetch(responses: Array<{ status?: number; body?: unknown }>): Call[] {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Docs append request", () => {
  it("inserts the heading ONCE and styles only the heading paragraph", () => {
    const heading = "Study Lamp — 2026-10-06";
    const requests = buildDocAppendRequests({ endIndex: 50, heading, body: "Body text" }) as Array<Record<string, any>>;
    assert.equal(requests.length, 2);
    assert.equal(requests[0].insertText.location.index, 49);
    assert.equal(requests[0].insertText.text, `\n\n${heading}\nBody text`);
    assert.equal((requests[0].insertText.text.match(/Study Lamp —/g) ?? []).length, 1);

    const range = requests[1].updateParagraphStyle.range;
    assert.equal(range.startIndex, 49 + 2);
    assert.equal(range.endIndex, range.startIndex + heading.length + 1);
    assert.ok(range.endIndex > range.startIndex, "the range must not be zero-length");
    assert.equal(requests[1].updateParagraphStyle.paragraphStyle.namedStyleType, "HEADING_2");
  });

  it("strips control characters and newlines from the heading", () => {
    const [insert] = buildDocAppendRequests({ endIndex: 2, heading: "A\nB", body: "x\u0000y" }) as Array<Record<string, any>>;
    assert.equal(insert.insertText.text, "\n\nA B\nxy");
  });

  it("sends writeControl.requiredRevisionId and only allowed request types", async () => {
    const calls = stubFetch([{ status: 200 }]);
    await appendToDocument("tok", "doc1", { revisionId: "rev-9", endIndex: 10, heading: "H", body: "B" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /documents\/doc1:batchUpdate$/);
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.equal(sent.writeControl.requiredRevisionId, "rev-9");
    assert.doesNotThrow(() => assertAllowedDocumentRequests(sent.requests));
  });

  it("rejects request types other than insertText / updateParagraphStyle", () => {
    assert.throws(() => assertAllowedDocumentRequests([{ deleteContentRange: {} }]), /unsupported/);
    assert.throws(() => assertAllowedDocumentRequests([{ replaceAllText: {} }]), /unsupported/);
    assert.throws(() => assertAllowedDocumentRequests("nope"));
  });

  it("reads the end index and revision, and refuses a document without a revision id", async () => {
    stubFetch([{ body: { revisionId: "r1", body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } } }]);
    assert.deepEqual(await getDocumentEnd("tok", "d"), { revisionId: "r1", endIndex: 42 });
    stubFetch([{ body: { body: { content: [{ endIndex: 42 }] } } }]);
    await assert.rejects(() => getDocumentEnd("tok", "d"), GoogleApiError);
  });
});

describe("Google API errors never leak the response body", () => {
  it("maps statuses to kinds and drops Google's message", async () => {
    stubFetch([{ status: 403, body: { error: { message: "SECRET internal detail", status: "PERMISSION_DENIED" } } }]);
    await assert.rejects(
      () => getDocumentEnd("tok", "d"),
      (error: unknown) => error instanceof GoogleApiError && error.kind === "permission" && !error.message.includes("SECRET"),
    );
    stubFetch([{ status: 404 }]);
    await assert.rejects(() => getDocumentEnd("tok", "d"), (e: unknown) => e instanceof GoogleApiError && e.kind === "not_found");
  });

  it("treats a failed writeControl precondition as revision_changed", async () => {
    stubFetch([{ status: 400, body: { error: { status: "FAILED_PRECONDITION", message: "revision mismatch" } } }]);
    await assert.rejects(
      () => appendToDocument("tok", "d", { revisionId: "old", endIndex: 5, heading: "H", body: "B" }),
      (e: unknown) => e instanceof GoogleApiError && e.kind === "revision_changed",
    );
  });

  it("exposes `status` so a 401 triggers the one token refresh in runWithDriveToken", async () => {
    stubFetch([{ status: 401 }]);
    await assert.rejects(() => getDocumentEnd("tok", "d"), (e: unknown) => (e as { status?: number }).status === 401);
  });
});

describe("Sheets requests", () => {
  it("quotes the tab name in A1 notation (the old code sent it unquoted)", () => {
    assert.equal(quoteSheetTab("Study Lamp log"), "'Study Lamp log'");
    assert.equal(quoteSheetTab("Bob's"), "'Bob''s'");
  });

  it("appends with RAW + INSERT_ROWS to the quoted tab", async () => {
    const calls = stubFetch([{ status: 200 }]);
    await appendRows("tok", "sheet1", SHEET_TAB, [["a", 1]]);
    const url = decodeURIComponent(calls[0].url);
    assert.match(url, /values\/'Study Lamp log'!A1:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { values: [["a", 1]] });
  });

  it("createSheet sends only addSheet (and the allowlist rejects anything else)", async () => {
    const calls = stubFetch([{ status: 200 }]);
    await createSheet("tok", "sheet1", SHEET_TAB);
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(sent.requests, [{ addSheet: { properties: { title: SHEET_TAB } } }]);
    assert.doesNotThrow(() => assertAllowedSheetRequests(sent.requests));
    assert.throws(() => assertAllowedSheetRequests([{ deleteSheet: { sheetId: 1 } }]), /unsupported/);
    assert.throws(() => assertAllowedSheetRequests([{ updateCells: {} }]), /unsupported/);
  });

  it("reports the tab state: absent / empty / with header", async () => {
    stubFetch([{ body: { sheets: [{ properties: { title: "Sheet1" } }] } }]);
    assert.equal(await getSheetTabState("tok", "s"), "absent");

    stubFetch([{ body: { sheets: [{ properties: { title: SHEET_TAB } }] } }, { body: {} }]);
    assert.equal(await getSheetTabState("tok", "s"), "present_empty");

    stubFetch([{ body: { sheets: [{ properties: { title: SHEET_TAB } }] } }, { body: { values: [["Date"]] } }]);
    assert.equal(await getSheetTabState("tok", "s"), "present_with_header");
  });

  it("never asks the Sheets API for a revisionId field", async () => {
    const calls = stubFetch([{ body: { sheets: [] } }]);
    await getSheetTabState("tok", "s");
    assert.ok(!calls.some((call) => call.url.includes("revisionId")));
  });
});
