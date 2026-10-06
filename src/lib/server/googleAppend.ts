import { buildPlanItem, makePlanItemId, type PlanItem } from "@/lib/sync/plan";
import type { PlanTokenItem } from "@/lib/server/planToken";
import type { SheetTabState } from "@/lib/server/googleSheets";

/**
 * PURE builders for the Docs / Sheets append flow (Z2). Nothing here touches Firestore or Google, so the
 * content that is previewed and the content that is written come from the same, testable code.
 */

export type GoogleDocAppendKind = "summary" | "notes" | "quiz_review";
/** Kept for older imports. */
export type GoogleStudioAppendContent = GoogleDocAppendKind;

export const DOC_APPEND_KINDS: readonly GoogleDocAppendKind[] = ["summary", "notes", "quiz_review"];
export const KIND_LABELS: Record<GoogleDocAppendKind, string> = {
  summary: "Summary",
  notes: "Notes",
  quiz_review: "Quiz review",
};

export const MAX_APPEND_CHARS = 20_000;
export const MAX_REVIEW_QUESTIONS = 20;
export const MAX_SHEET_ROWS = 200;
export const SHEET_HEADER: Array<string | number> = ["Date", "Material", "Quiz", "Score", "Out of", "Percent"];

/** Thrown when there is nothing worth writing; mapped to a 409, never written as placeholder text. */
export class NothingToAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToAppendError";
  }
}

export function isDocAppendKind(value: unknown): value is GoogleDocAppendKind {
  return typeof value === "string" && (DOC_APPEND_KINDS as readonly string[]).includes(value);
}

// ─── Text helpers ───────────────────────────────────────────────────────────

export function htmlToPlainText(value: string): string {
  const normalized = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ");
  return normalized.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "Study Lamp — YYYY-MM-DD" (UTC date). documentText.ts hides everything from this line on. */
export function formatGoogleDocHeading(date = new Date()): string {
  return `Study Lamp — ${date.toISOString().slice(0, 10)}`;
}

export function truncateText(value: string, max = MAX_APPEND_CHARS): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  let cut = value.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // never split a surrogate pair
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

// ─── Quiz data shapes (what the server reads from Firestore) ───────────────

export interface QuizAttemptRecord {
  id: string;
  score: number;
  totalQuestions: number;
  completedAt: Date | null;
  answers: Array<{ questionId: string; chosenOptionId: string; wasCorrect: boolean }>;
  quizTitle?: string;
}

export interface QuizQuestionRecord {
  id: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
}

function attemptTime(attempt: QuizAttemptRecord): number {
  return attempt.completedAt ? attempt.completedAt.getTime() : 0;
}

/** Chronological order (oldest first); ties broken by id so the order is stable. */
export function sortAttemptsOldestFirst(attempts: QuizAttemptRecord[]): QuizAttemptRecord[] {
  return [...attempts].sort((a, b) => attemptTime(a) - attemptTime(b) || a.id.localeCompare(b.id));
}

export function pickLatestAttempt(attempts: QuizAttemptRecord[]): QuizAttemptRecord | null {
  const sorted = sortAttemptsOldestFirst(attempts);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

function percentOf(score: number, total: number): number {
  return total > 0 ? Math.round((score / total) * 100) : 0;
}

/** Wrong questions (question, your answer, correct answer), capped at 20 questions. */
export function buildQuizReviewText(attempt: QuizAttemptRecord, questions: QuizQuestionRecord[]): string {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const optionText = (question: QuizQuestionRecord, optionId: string) =>
    question.options.find((option) => option.id === optionId)?.text ?? "";

  const wrong = attempt.answers.filter((answer) => answer.wasCorrect === false);
  const header = `Latest quiz result: ${attempt.score}/${attempt.totalQuestions} (${percentOf(attempt.score, attempt.totalQuestions)}%).`;
  if (wrong.length === 0) return `${header} No wrong answers.`;

  const blocks: string[] = [];
  let unavailable = 0;
  for (const answer of wrong) {
    const question = byId.get(answer.questionId);
    if (!question) {
      unavailable += 1; // the quiz was regenerated since this attempt
      continue;
    }
    if (blocks.length >= MAX_REVIEW_QUESTIONS) continue;
    blocks.push(
      [
        `${blocks.length + 1}. ${question.prompt}`,
        `Your answer: ${optionText(question, answer.chosenOptionId) || "(no answer)"}`,
        `Correct answer: ${optionText(question, question.correctOptionId) || "(unknown)"}`,
      ].join("\n"),
    );
  }

  const omitted = wrong.length - unavailable - blocks.length;
  const notes: string[] = [];
  if (omitted > 0) notes.push(`${omitted} more wrong answer${omitted === 1 ? "" : "s"} not shown.`);
  if (unavailable > 0) notes.push(`${unavailable} question${unavailable === 1 ? " is" : "s are"} no longer available.`);
  if (blocks.length === 0) return [header, ...notes].join("\n");
  return [header, "Questions to review:", blocks.join("\n\n"), ...notes].join("\n\n");
}

export interface DocAppendSourceData {
  summaryHtml?: string | null;
  note?: string | null;
  attempts?: QuizAttemptRecord[];
  questions?: QuizQuestionRecord[];
}

/** The body of the section appended to a Google Doc. Throws NothingToAppendError instead of writing a placeholder. */
export function buildDocAppendBody(kind: GoogleDocAppendKind, data: DocAppendSourceData): { body: string; truncated: boolean } {
  let raw: string;
  if (kind === "summary") {
    raw = htmlToPlainText(data.summaryHtml ?? "");
    if (!raw) throw new NothingToAppendError("There is no summary to add yet.");
  } else if (kind === "notes") {
    raw = (data.note ?? "").replace(/\r\n/g, "\n").trim();
    if (!raw) throw new NothingToAppendError("There are no notes to add yet.");
  } else {
    const latest = pickLatestAttempt(data.attempts ?? []);
    if (!latest) throw new NothingToAppendError("No quiz results are available yet.");
    raw = buildQuizReviewText(latest, data.questions ?? []);
  }
  const { text, truncated } = truncateText(raw);
  return { body: text, truncated };
}

// ─── Plan items and token binding ───────────────────────────────────────────

export function docsAppendTarget(documentId: string, kind: GoogleDocAppendKind): string {
  return `google-doc:${documentId}:${kind}`;
}

export function sheetsAppendTarget(documentId: string): string {
  return `google-sheet:${documentId}:quiz_results`;
}

export function buildDocsAppendPlanItem(input: {
  documentId: string;
  kind: GoogleDocAppendKind;
  documentTitle: string;
  heading: string;
  body: string;
  revisionId: string;
}): PlanItem {
  return buildPlanItem({
    kind: "append",
    target: docsAppendTarget(input.documentId, input.kind),
    title: `${input.documentTitle} — ${KIND_LABELS[input.kind]}`,
    fields: [{ name: "text", before: "", after: input.body.slice(0, 180) }],
    risk: "normal",
    // The FULL text and the revision both go into the fingerprint: change either and the plan is stale.
    remoteVersion: input.revisionId,
    localValue: `${input.heading}\n${input.body}`,
  });
}

/** The item id a Docs plan for (document, kind) has. Lets the apply route find the kind in the token. */
export function docsAppendItemId(documentId: string, kind: GoogleDocAppendKind): string {
  return makePlanItemId({ target: docsAppendTarget(documentId, kind), kind: "append" });
}

export function sheetsAppendItemId(documentId: string): string {
  return makePlanItemId({ target: sheetsAppendTarget(documentId), kind: "append" });
}

/** Finds which kind (if any) a token covers for THIS document. A token for another document matches nothing. */
export function findDocsAppendBinding(items: PlanTokenItem[], documentId: string): { itemId: string; kind: GoogleDocAppendKind } | null {
  if (items.length !== 1) return null;
  for (const kind of DOC_APPEND_KINDS) {
    const itemId = docsAppendItemId(documentId, kind);
    if (items[0].itemId === itemId) return { itemId, kind };
  }
  return null;
}

export function findSheetsAppendBinding(items: PlanTokenItem[], documentId: string): { itemId: string } | null {
  if (items.length !== 1) return null;
  const itemId = sheetsAppendItemId(documentId);
  return items[0].itemId === itemId ? { itemId } : null;
}

// ─── Sheets rows ────────────────────────────────────────────────────────────

export interface SheetExportPlan {
  /** Data rows only (no header). */
  rows: Array<Array<string | number>>;
  /** Exactly the attempts the rows were built from. These are the ids that get an export marker. */
  attemptIds: string[];
  /** Unexported attempts beyond the cap; they stay for the next export. */
  remaining: number;
}

/**
 * Rows come ONLY from attempts without an export marker, oldest first, capped at 200.
 * Row = [date, material title, quiz title, score, total, percent].
 */
export function buildSheetExportPlan(input: {
  attempts: QuizAttemptRecord[];
  exportedIds: ReadonlySet<string>;
  materialTitle: string;
  cap?: number;
}): SheetExportPlan {
  const cap = input.cap ?? MAX_SHEET_ROWS;
  const ordered = sortAttemptsOldestFirst(input.attempts);
  const material = input.materialTitle.slice(0, 200);

  const rows: Array<Array<string | number>> = [];
  const attemptIds: string[] = [];
  let remaining = 0;
  ordered.forEach((attempt, index) => {
    if (input.exportedIds.has(attempt.id)) return;
    if (rows.length >= cap) {
      remaining += 1;
      return;
    }
    rows.push([
      attempt.completedAt ? attempt.completedAt.toISOString().slice(0, 10) : "",
      material,
      (attempt.quizTitle || `Quiz attempt ${index + 1}`).slice(0, 200),
      attempt.score,
      attempt.totalQuestions,
      percentOf(attempt.score, attempt.totalQuestions),
    ]);
    attemptIds.push(attempt.id);
  });
  return { rows, attemptIds, remaining };
}

/** The header row is written only when the tab is new or empty. */
export function sheetValuesToAppend(plan: SheetExportPlan, tabState: SheetTabState): Array<Array<string | number>> {
  return tabState === "present_with_header" ? plan.rows : [SHEET_HEADER, ...plan.rows];
}

export function buildSheetsAppendPlanItem(input: {
  documentId: string;
  documentTitle: string;
  plan: SheetExportPlan;
  tabState: SheetTabState;
}): PlanItem {
  const values = sheetValuesToAppend(input.plan, input.tabState);
  return buildPlanItem({
    kind: "append",
    target: sheetsAppendTarget(input.documentId),
    title: `${input.documentTitle} — Quiz results`,
    fields: [{ name: "rows", before: "", after: `${input.plan.rows.length} row${input.plan.rows.length === 1 ? "" : "s"}` }],
    risk: "normal",
    // The attempt ids are in the fingerprint, so the export markers can only ever cover what the user saw.
    remoteVersion: `tab:${input.tabState}`,
    localValue: JSON.stringify({ ids: input.plan.attemptIds, values }),
  });
}
