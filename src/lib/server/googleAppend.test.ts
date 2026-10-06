import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_APPEND_CHARS,
  MAX_REVIEW_QUESTIONS,
  MAX_SHEET_ROWS,
  NothingToAppendError,
  SHEET_HEADER,
  buildDocAppendBody,
  buildDocsAppendPlanItem,
  buildQuizReviewText,
  buildSheetExportPlan,
  buildSheetsAppendPlanItem,
  docsAppendItemId,
  findDocsAppendBinding,
  findSheetsAppendBinding,
  formatGoogleDocHeading,
  sheetValuesToAppend,
  sheetsAppendItemId,
  truncateText,
  type QuizAttemptRecord,
  type QuizQuestionRecord,
} from "./googleAppend";
import { stripStudyLampDocText, stripStudyLampSheetNames } from "./studyLampSections";

function attempt(id: string, day: number, score = 3, total = 5, answers: QuizAttemptRecord["answers"] = []): QuizAttemptRecord {
  return { id, score, totalQuestions: total, completedAt: new Date(Date.UTC(2026, 9, day, 12)), answers };
}

const questions: QuizQuestionRecord[] = [
  { id: "q1", prompt: "What is 2+2?", options: [{ id: "a", text: "3" }, { id: "b", text: "4" }], correctOptionId: "b" },
  { id: "q2", prompt: "Capital of France?", options: [{ id: "a", text: "Paris" }, { id: "b", text: "Rome" }], correctOptionId: "a" },
];

describe("doc append text", () => {
  it("builds the heading once, from the date", () => {
    assert.equal(formatGoogleDocHeading(new Date("2026-10-06T10:00:00Z")), "Study Lamp — 2026-10-06");
  });

  it("throws NothingToAppendError instead of writing placeholder text", () => {
    assert.throws(() => buildDocAppendBody("summary", { summaryHtml: "  " }), NothingToAppendError);
    assert.throws(() => buildDocAppendBody("notes", { note: "" }), NothingToAppendError);
    assert.throws(() => buildDocAppendBody("quiz_review", { attempts: [] }), NothingToAppendError);
  });

  it("converts a summary from HTML to plain text", () => {
    const { body } = buildDocAppendBody("summary", { summaryHtml: "<p>One &amp; two</p><ul><li>a</li><li>b</li></ul>" });
    assert.equal(body, "One & two\na\nb");
  });

  it("truncates to 20,000 characters without splitting a surrogate pair", () => {
    const text = `${"x".repeat(MAX_APPEND_CHARS - 2)}😀😀`;
    const out = truncateText(text);
    assert.equal(out.truncated, true);
    assert.ok(out.text.length <= MAX_APPEND_CHARS);
    assert.ok(!/[\ud800-\udbff]$/.test(out.text.slice(0, -1)));
    assert.equal(truncateText("short").truncated, false);
  });
});

describe("quiz review", () => {
  it("lists the wrong questions with your answer and the correct answer", () => {
    const text = buildQuizReviewText(
      attempt("a1", 1, 1, 2, [
        { questionId: "q1", chosenOptionId: "a", wasCorrect: false },
        { questionId: "q2", chosenOptionId: "a", wasCorrect: true },
      ]),
      questions,
    );
    assert.match(text, /Latest quiz result: 1\/2 \(50%\)/);
    assert.match(text, /1\. What is 2\+2\?/);
    assert.match(text, /Your answer: 3/);
    assert.match(text, /Correct answer: 4/);
    assert.doesNotMatch(text, /Capital of France/);
  });

  it("caps the review at 20 questions and says how many were left out", () => {
    const many: QuizQuestionRecord[] = Array.from({ length: 30 }, (_, i) => ({
      id: `q${i}`, prompt: `Question ${i}`, options: [{ id: "a", text: "x" }, { id: "b", text: "y" }], correctOptionId: "b",
    }));
    const answers = many.map((q) => ({ questionId: q.id, chosenOptionId: "a", wasCorrect: false }));
    const text = buildQuizReviewText(attempt("a1", 1, 0, 30, answers), many);
    assert.equal((text.match(/Your answer:/g) ?? []).length, MAX_REVIEW_QUESTIONS);
    assert.match(text, /10 more wrong answers not shown/);
  });

  it("reports questions that no longer exist instead of inventing them", () => {
    const text = buildQuizReviewText(attempt("a1", 1, 0, 1, [{ questionId: "gone", chosenOptionId: "a", wasCorrect: false }]), questions);
    assert.match(text, /1 question is no longer available/);
  });

  it("uses the NEWEST attempt", () => {
    const { body } = buildDocAppendBody("quiz_review", { attempts: [attempt("old", 1, 1, 5), attempt("new", 9, 4, 5)], questions });
    assert.match(body, /4\/5/);
  });
});

describe("plan items and token binding", () => {
  const base = { documentId: "docA", kind: "summary" as const, documentTitle: "Notes", heading: "Study Lamp — 2026-10-06", body: "Hello", revisionId: "rev-1" };

  it("changes the fingerprint when the text OR the revision changes", () => {
    const a = buildDocsAppendPlanItem(base);
    assert.equal(a.fingerprint, buildDocsAppendPlanItem(base).fingerprint);
    assert.notEqual(a.fingerprint, buildDocsAppendPlanItem({ ...base, body: "Hello!" }).fingerprint);
    assert.notEqual(a.fingerprint, buildDocsAppendPlanItem({ ...base, revisionId: "rev-2" }).fingerprint);
  });

  it("binds a token to ONE document and ONE kind", () => {
    const item = buildDocsAppendPlanItem(base);
    assert.deepEqual(findDocsAppendBinding([{ itemId: item.itemId, fingerprint: item.fingerprint }], "docA"), { itemId: item.itemId, kind: "summary" });
    assert.equal(findDocsAppendBinding([{ itemId: item.itemId, fingerprint: item.fingerprint }], "docB"), null);
    assert.notEqual(docsAppendItemId("docA", "summary"), docsAppendItemId("docA", "notes"));
    assert.equal(findDocsAppendBinding([], "docA"), null);
  });

  it("keeps docs and sheets item ids apart", () => {
    assert.notEqual(sheetsAppendItemId("docA"), docsAppendItemId("docA", "summary"));
    assert.equal(findSheetsAppendBinding([{ itemId: sheetsAppendItemId("docA"), fingerprint: "x" }], "docB"), null);
  });
});

describe("sheet export rows", () => {
  it("uses only attempts without an export marker, oldest first", () => {
    const plan = buildSheetExportPlan({
      attempts: [attempt("c", 3), attempt("a", 1), attempt("b", 2)],
      exportedIds: new Set(["a"]),
      materialTitle: "Maths",
    });
    assert.deepEqual(plan.attemptIds, ["b", "c"]);
    assert.deepEqual(plan.rows[0], ["2026-10-02", "Maths", "Quiz attempt 2", 3, 5, 60]);
    assert.equal(plan.remaining, 0);
  });

  it("caps at 200 rows and reports the rest", () => {
    const attempts = Array.from({ length: 230 }, (_, i) => attempt(`a${String(i).padStart(3, "0")}`, 1 + (i % 28)));
    const plan = buildSheetExportPlan({ attempts, exportedIds: new Set(), materialTitle: "Maths" });
    assert.equal(plan.rows.length, MAX_SHEET_ROWS);
    assert.equal(plan.attemptIds.length, MAX_SHEET_ROWS);
    assert.equal(plan.remaining, 30);
  });

  it("writes the header only when the tab is new or empty", () => {
    const plan = buildSheetExportPlan({ attempts: [attempt("a", 1)], exportedIds: new Set(), materialTitle: "Maths" });
    assert.deepEqual(sheetValuesToAppend(plan, "absent")[0], SHEET_HEADER);
    assert.deepEqual(sheetValuesToAppend(plan, "present_empty")[0], SHEET_HEADER);
    assert.equal(sheetValuesToAppend(plan, "present_with_header").length, 1);
  });

  it("puts the attempt ids and the tab state in the fingerprint", () => {
    const one = buildSheetExportPlan({ attempts: [attempt("a", 1)], exportedIds: new Set(), materialTitle: "M" });
    const two = buildSheetExportPlan({ attempts: [attempt("a", 1), attempt("b", 2)], exportedIds: new Set(), materialTitle: "M" });
    const f = (plan: typeof one, tabState: "absent" | "present_with_header") =>
      buildSheetsAppendPlanItem({ documentId: "s1", documentTitle: "M", plan, tabState }).fingerprint;
    assert.notEqual(f(one, "absent"), f(two, "absent"));
    assert.notEqual(f(one, "absent"), f(one, "present_with_header"));
  });
});

describe("hiding Study Lamp's own output from AI extraction", () => {
  it("drops the doc text from the first 'Study Lamp — ' heading on", () => {
    assert.equal(stripStudyLampDocText("Intro\n\nReal content\n\nStudy Lamp — 2026-10-06\nSummary text\nMore"), "Intro\n\nReal content");
    assert.equal(stripStudyLampDocText("No marker here"), "No marker here");
  });

  it("drops the 'Study Lamp log' sheet section only", () => {
    const text = "Sheet: Data\na\tb\n\nSheet: Study Lamp log\nDate\tMaterial\n\nSheet: Other\nc";
    assert.equal(stripStudyLampSheetNames(text), "Sheet: Data\na\tb\n\nSheet: Other\nc");
  });
});
