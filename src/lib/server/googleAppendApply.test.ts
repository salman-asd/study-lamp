import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { GoogleApiError } from "./googleApiError";
import {
  applyDocsAppend,
  applySheetsAppend,
  previewDocsAppend,
  previewSheetsAppend,
  type DocsApplyDeps,
  type PersonalDocumentRecord,
  type SheetsApplyDeps,
} from "./googleAppendApply";
import type { QuizAttemptRecord } from "./googleAppend";
import { signPlanToken } from "./planToken";
import type { SheetTabState } from "./googleSheets";

process.env.DRIVE_URL_SIGNING_SECRET = "test-append-secret";

const UID = "user-1";
const NOW = new Date("2026-10-06T10:00:00Z");

const records: Record<string, PersonalDocumentRecord> = {
  docA: { title: "Doc A", googleNative: true, fileType: "docx", driveFileId: "gdocA", driveConnectionId: "conn1" },
  docB: { title: "Doc B", googleNative: true, fileType: "docx", driveFileId: "gdocB", driveConnectionId: "conn1" },
  sheetA: { title: "Sheet A", googleNative: true, fileType: "xlsx", driveFileId: "gsheetA", driveConnectionId: "conn1" },
  sheetB: { title: "Sheet B", googleNative: true, fileType: "xlsx", driveFileId: "gsheetB", driveConnectionId: "conn1" },
  plainDoc: { title: "Uploaded", googleNative: false, fileType: "docx", driveFileId: "file1", driveConnectionId: "conn1" },
};

function attempt(id: string, day: number): QuizAttemptRecord {
  return { id, score: 3, totalQuestions: 5, completedAt: new Date(Date.UTC(2026, 9, day, 12)), answers: [] };
}

function makeDocs(over: Partial<DocsApplyDeps> = {}) {
  const calls: string[] = [];
  const written: Array<{ documentId: string; revisionId: string; heading: string; body: string }> = [];
  const logs: unknown[] = [];
  const used = new Set<string>();
  const state = { revisionId: "rev-1", summary: "<p>Hello world</p>" };
  const deps: DocsApplyDeps = {
    loadRecord: async (_uid, id) => records[id] ?? null,
    withAccessToken: async (_uid, _conn, op) => op("tok"),
    connectionErrorCode: () => null,
    now: () => NOW,
    getDocumentEnd: async () => ({ revisionId: state.revisionId, endIndex: 50 }),
    loadDocInputs: async () => ({ summaryHtml: state.summary, note: "my note" }),
    appendToDocument: async (_t, documentId, input) => {
      calls.push("write:appendToDocument");
      written.push({ documentId, revisionId: input.revisionId, heading: input.heading, body: input.body });
    },
    markTokenUsed: async (_uid, jti) => {
      calls.push("write:markTokenUsed");
      if (used.has(jti)) return false;
      used.add(jti);
      return true;
    },
    pruneUsedTokens: async () => 0,
    log: async (_uid, entry) => {
      calls.push("write:log");
      logs.push(entry);
    },
    ...over,
  };
  return { deps, calls, written, logs, state };
}

function makeSheets(over: Partial<SheetsApplyDeps> = {}) {
  const calls: string[] = [];
  const appended: Array<Array<Array<string | number>>> = [];
  const marked: string[][] = [];
  const used = new Set<string>();
  const state = {
    tab: "absent" as SheetTabState,
    attempts: [attempt("a1", 1), attempt("a2", 2), attempt("a3", 3)],
    exported: new Set<string>(["a1"]),
  };
  const deps: SheetsApplyDeps = {
    loadRecord: async (_uid, id) => records[id] ?? null,
    withAccessToken: async (_uid, _conn, op) => op("tok"),
    connectionErrorCode: () => null,
    now: () => NOW,
    getTabState: async () => state.tab,
    loadSheetAttempts: async () => ({ attempts: state.attempts, exportedIds: state.exported }),
    createSheet: async () => { calls.push("write:createSheet"); },
    appendRows: async (_t, _id, _tab, rows) => { calls.push("write:appendRows"); appended.push(rows); },
    markExported: async (_uid, _doc, ids) => { calls.push("write:markExported"); marked.push(ids); },
    markTokenUsed: async (_uid, jti) => {
      calls.push("write:markTokenUsed");
      if (used.has(jti)) return false;
      used.add(jti);
      return true;
    },
    pruneUsedTokens: async () => 0,
    log: async () => { calls.push("write:log"); },
    ...over,
  };
  return { deps, calls, appended, marked, state };
}

const writes = (calls: string[]) => calls.filter((call) => call.startsWith("write:"));

async function docsPreview(deps: DocsApplyDeps, documentId = "docA", content = "summary") {
  const res = await previewDocsAppend(deps, { uid: UID, documentId, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { planToken: string; item: { itemId: string }; preview: { text: string; heading: string } };
}

describe("Docs preview", () => {
  it("shows the exact text and performs ZERO writes", async () => {
    const { deps, calls } = makeDocs();
    const body = await docsPreview(deps);
    assert.equal(body.preview.text, "Hello world");
    assert.equal(body.preview.heading, "Study Lamp — 2026-10-06");
    assert.deepEqual(writes(calls), []);
  });

  it("rejects a bad kind, a non-Google document and a missing document without touching Google", async () => {
    const { deps, calls } = makeDocs({ getDocumentEnd: async () => { calls.push("read:end"); throw new Error("must not be called"); } });
    assert.equal((await previewDocsAppend(deps, { uid: UID, documentId: "docA", content: "everything" })).status, 400);
    assert.equal((await previewDocsAppend(deps, { uid: UID, documentId: "plainDoc", content: "summary" })).status, 400);
    assert.equal((await previewDocsAppend(deps, { uid: UID, documentId: "nope", content: "summary" })).status, 404);
    assert.equal((await previewDocsAppend(deps, { uid: UID, documentId: "../x", content: "summary" })).status, 400);
    assert.deepEqual(calls, []);
  });

  it("answers 409 when there is nothing to add (no placeholder is ever written)", async () => {
    const { deps } = makeDocs({ loadDocInputs: async () => ({ summaryHtml: "" }) });
    const res = await previewDocsAppend(deps, { uid: UID, documentId: "docA", content: "summary" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "nothing_to_add");
  });
});

describe("Docs apply", () => {
  let ctx: ReturnType<typeof makeDocs>;
  beforeEach(() => { ctx = makeDocs(); });

  it("appends once, with server-built text and the revision read at apply time", async () => {
    const preview = await docsPreview(ctx.deps);
    const res = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(ctx.written, [{ documentId: "gdocA", revisionId: "rev-1", heading: "Study Lamp — 2026-10-06", body: "Hello world" }]);
  });

  it("logs a result without any document text", async () => {
    const preview = await docsPreview(ctx.deps);
    await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(ctx.logs.length, 1);
    assert.ok(!JSON.stringify(ctx.logs[0]).includes("Hello world"));
    assert.equal((ctx.logs[0] as { result: string }).result, "applied");
  });

  it("ignores text, heading and revisionId in the request body", async () => {
    const preview = await docsPreview(ctx.deps);
    const hostile = { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA", text: "EVIL", heading: "EVIL", revisionId: "EVIL" };
    await applyDocsAppend(ctx.deps, hostile);
    assert.equal(ctx.written.length, 1);
    assert.equal(ctx.written[0].body, "Hello world");
    assert.equal(ctx.written[0].revisionId, "rev-1");
    assert.ok(!ctx.written[0].heading.includes("EVIL"));
  });

  it("writes nothing when the item id is not in `accepted`, and does not burn the token", async () => {
    const preview = await docsPreview(ctx.deps);
    const empty = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [], documentId: "docA" });
    const other = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: ["some-other-id"], documentId: "docA" });
    assert.equal(empty.status, 400);
    assert.equal(other.status, 400);
    assert.deepEqual(writes(ctx.calls), []);
  });

  it("rejects a token for document A applied to document B", async () => {
    const preview = await docsPreview(ctx.deps, "docA");
    const res = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docB" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "wrong_document");
    assert.deepEqual(writes(ctx.calls), []);
  });

  it("takes the kind from the token, not from the request", async () => {
    const preview = await docsPreview(ctx.deps, "docA", "notes");
    const res = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.status, 200);
    assert.equal(ctx.written[0].body, "my note");
  });

  it("rejects a replayed token with 409 and writes nothing the second time", async () => {
    const preview = await docsPreview(ctx.deps);
    const input = { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" };
    assert.equal((await applyDocsAppend(ctx.deps, input)).status, 200);
    const replay = await applyDocsAppend(ctx.deps, input);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, "plan_already_applied");
    assert.equal(ctx.written.length, 1);
  });

  it("is stale (nothing written) when the document was edited after the preview", async () => {
    const preview = await docsPreview(ctx.deps);
    ctx.state.revisionId = "rev-2";
    const res = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "stale");
    assert.deepEqual(ctx.written, []);
  });

  it("is stale when the Study Lamp summary changed after the preview", async () => {
    const preview = await docsPreview(ctx.deps);
    ctx.state.summary = "<p>Edited since</p>";
    const res = await applyDocsAppend(ctx.deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.body.code, "stale");
    assert.deepEqual(ctx.written, []);
  });

  it("maps Google's 'revision changed' during the write to stale", async () => {
    const { deps } = makeDocs({ appendToDocument: async () => { throw new GoogleApiError("revision_changed", 400); } });
    const preview = await docsPreview(deps);
    const res = await applyDocsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "stale");
  });

  it("returns a fixed permission message, never Google's text", async () => {
    const { deps } = makeDocs({ appendToDocument: async () => { throw new GoogleApiError("permission", 403); } });
    const preview = await docsPreview(deps);
    const res = await applyDocsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "permission");
  });

  it("answers 404 for a trashed/deleted file and never reports success", async () => {
    const { deps, calls } = makeDocs({ getDocumentEnd: async () => { throw new GoogleApiError("not_found", 404); } });
    const preview = await previewDocsAppend(makeDocs().deps, { uid: UID, documentId: "docA", content: "summary" });
    const res = await applyDocsAppend(deps, { uid: UID, planToken: String(preview.body.planToken), accepted: [(preview.body.item as { itemId: string }).itemId], documentId: "docA" });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "not_found");
    assert.deepEqual(calls.filter((c) => c === "write:appendToDocument"), []);
  });

  it("maps a lost Drive connection to a reconnect message", async () => {
    const { deps } = makeDocs({ connectionErrorCode: (error) => (error instanceof Error && error.message === "conn" ? "invalid" : null), withAccessToken: async () => { throw new Error("conn"); } });
    const preview = await previewDocsAppend(makeDocs().deps, { uid: UID, documentId: "docA", content: "summary" });
    const res = await applyDocsAppend(deps, { uid: UID, planToken: String(preview.body.planToken), accepted: [(preview.body.item as { itemId: string }).itemId], documentId: "docA" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "reconnect");
  });

  it("rejects a token for another user and a token of the wrong scope", async () => {
    const preview = await docsPreview(ctx.deps);
    assert.equal((await applyDocsAppend(ctx.deps, { uid: "someone-else", planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "docA" })).status, 401);
    const wrongScope = signPlanToken({ uid: UID, scope: "sheets_append", items: [{ itemId: preview.item.itemId, fingerprint: "x" }] });
    assert.equal((await applyDocsAppend(ctx.deps, { uid: UID, planToken: wrongScope, accepted: [preview.item.itemId], documentId: "docA" })).status, 401);
    assert.deepEqual(writes(ctx.calls), []);
  });
});

describe("Sheets preview", () => {
  it("lists only unexported attempts, adds a header for a new tab, and performs ZERO writes", async () => {
    const { deps, calls } = makeSheets();
    const res = await previewSheetsAppend(deps, { uid: UID, documentId: "sheetA" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const preview = res.body.preview as { rows: unknown[][]; header: unknown[] | null; willCreateTab: boolean };
    assert.equal(preview.rows.length, 2);
    assert.equal(preview.willCreateTab, true);
    assert.ok(preview.header);
    assert.deepEqual(writes(calls), []);
  });

  it("answers 409 when every attempt was already exported", async () => {
    const { deps, state } = makeSheets();
    state.exported = new Set(["a1", "a2", "a3"]);
    const res = await previewSheetsAppend(deps, { uid: UID, documentId: "sheetA" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "nothing_to_add");
  });
});

describe("Sheets apply", () => {
  async function sheetsPreview(deps: SheetsApplyDeps, documentId = "sheetA") {
    const res = await previewSheetsAppend(deps, { uid: UID, documentId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as { planToken: string; item: { itemId: string } };
  }

  it("creates the tab, writes header + rows once, and marks exactly the previewed attempts", async () => {
    const { deps, calls, appended, marked } = makeSheets();
    const preview = await sheetsPreview(deps);
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(writes(calls).filter((c) => c !== "write:markTokenUsed" && c !== "write:log"), ["write:createSheet", "write:appendRows", "write:markExported"]);
    assert.equal(appended[0][0][0], "Date");
    assert.equal(appended[0].length, 3); // header + 2 rows
    assert.deepEqual(marked, [["a2", "a3"]]);
  });

  it("does not create the tab or repeat the header when the tab already has one", async () => {
    const { deps, calls, appended, state } = makeSheets();
    state.tab = "present_with_header";
    const preview = await sheetsPreview(deps);
    await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.ok(!calls.includes("write:createSheet"));
    assert.equal(appended[0].length, 2);
    assert.notEqual(appended[0][0][0], "Date");
  });

  it("is stale and marks nothing when a NEW attempt arrived after the preview", async () => {
    const { deps, calls, marked, state } = makeSheets();
    const preview = await sheetsPreview(deps);
    state.attempts.push(attempt("a4", 4));
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.body.code, "stale");
    assert.ok(!calls.includes("write:appendRows"));
    assert.deepEqual(marked, []);
  });

  it("is stale when the tab appeared after the preview (the header decision changed)", async () => {
    const { deps, calls, state } = makeSheets();
    const preview = await sheetsPreview(deps);
    state.tab = "present_with_header";
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.body.code, "stale");
    assert.ok(!calls.includes("write:appendRows"));
  });

  it("rejects a token for sheet A applied to sheet B, and a replay", async () => {
    const { deps, calls } = makeSheets();
    const preview = await sheetsPreview(deps, "sheetA");
    const wrong = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetB" });
    assert.equal(wrong.body.code, "wrong_document");
    assert.deepEqual(writes(calls), []);

    const input = { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" };
    assert.equal((await applySheetsAppend(deps, input)).status, 200);
    assert.equal((await applySheetsAppend(deps, input)).status, 409);
    assert.equal(calls.filter((c) => c === "write:appendRows").length, 1);
  });

  it("marks nothing when the append to Google fails", async () => {
    const { deps, marked } = makeSheets({ appendRows: async () => { throw new GoogleApiError("permission", 403); } });
    const preview = await sheetsPreview(deps);
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.status, 403);
    assert.deepEqual(marked, []);
  });

  it("still reports success (with a warning) when only the export marker write fails", async () => {
    const { deps } = makeSheets({ markExported: async () => { throw new Error("firestore down"); } });
    const preview = await sheetsPreview(deps);
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.warnings, ["export_marker_failed"]);
  });

  it("refuses a Docs token on the Sheets route (wrong scope)", async () => {
    const docs = makeDocs();
    const preview = await docsPreview(docs.deps);
    const { deps, calls } = makeSheets();
    const res = await applySheetsAppend(deps, { uid: UID, planToken: preview.planToken, accepted: [preview.item.itemId], documentId: "sheetA" });
    assert.equal(res.status, 401);
    assert.deepEqual(writes(calls), []);
  });
});
