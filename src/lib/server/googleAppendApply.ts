import { applyConfirmed, type ApplyDecision } from "@/lib/server/applyGate";
import { GoogleApiError } from "@/lib/server/googleApiError";
import {
  KIND_LABELS,
  NothingToAppendError,
  buildDocAppendBody,
  buildDocsAppendPlanItem,
  buildSheetExportPlan,
  buildSheetsAppendPlanItem,
  findDocsAppendBinding,
  findSheetsAppendBinding,
  formatGoogleDocHeading,
  isDocAppendKind,
  sheetValuesToAppend,
  type DocAppendSourceData,
  type GoogleDocAppendKind,
  type QuizAttemptRecord,
  SHEET_HEADER,
} from "@/lib/server/googleAppend";
import type { DocAppendInput, DocumentEndInfo } from "@/lib/server/googleDocs";
import type { SheetTabState } from "@/lib/server/googleSheets";
import { SHEET_TAB } from "@/lib/server/googleSheets";
import type { GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import { logServerError } from "@/lib/server/logError";
import { PlanTokenVerificationError, signPlanToken, verifyPlanToken, type VerifiedPlanToken } from "@/lib/server/planToken";

/**
 * Preview + apply orchestration for "Add to Google Doc / Sheet" (Z2).
 *
 * Every I/O dependency is injected, so the tests can use recording fakes and prove that:
 *  - a preview performs ZERO writes (Rule 15), and
 *  - an apply writes only inside the confirmation gate, with content built HERE from stored data (Rule 16).
 *
 * The apply input has no text, heading or revision field on purpose: the client says only which plan
 * it confirmed ({planToken, accepted, documentId}).
 */

export interface PersonalDocumentRecord {
  title: string;
  googleNative?: boolean;
  fileType?: string;
  driveFileId?: string;
  driveConnectionId?: string;
}

export type ConnectionErrorCode = "not_found" | "invalid" | "network";

export interface AppendResponse {
  status: number;
  body: Record<string, unknown>;
}

interface ReadDeps {
  loadRecord(uid: string, documentId: string): Promise<PersonalDocumentRecord | null>;
  withAccessToken<T>(uid: string, connectionId: string, operation: (accessToken: string) => Promise<T>): Promise<T>;
  /** Returns the code when `error` is a Drive connection failure, otherwise null. */
  connectionErrorCode(error: unknown): ConnectionErrorCode | null;
  now(): Date;
}

interface WriteDeps {
  /** One-time token claim (Z3). false = already used. */
  markTokenUsed(uid: string, jti: string, exp: number): Promise<boolean>;
  pruneUsedTokens(uid: string): Promise<unknown>;
  log(uid: string, entry: GoogleSyncLogEntry): Promise<void>;
}

export interface DocsReadDeps extends ReadDeps {
  getDocumentEnd(accessToken: string, documentId: string): Promise<DocumentEndInfo>;
  loadDocInputs(uid: string, documentId: string, kind: GoogleDocAppendKind): Promise<DocAppendSourceData>;
}
export interface DocsApplyDeps extends DocsReadDeps, WriteDeps {
  appendToDocument(accessToken: string, documentId: string, input: DocAppendInput): Promise<void>;
}

export interface SheetsReadDeps extends ReadDeps {
  getTabState(accessToken: string, spreadsheetId: string): Promise<SheetTabState>;
  loadSheetAttempts(uid: string, documentId: string): Promise<{ attempts: QuizAttemptRecord[]; exportedIds: Set<string> }>;
}
export interface SheetsApplyDeps extends SheetsReadDeps, WriteDeps {
  createSheet(accessToken: string, spreadsheetId: string, title: string): Promise<void>;
  appendRows(accessToken: string, spreadsheetId: string, tab: string, rows: Array<Array<string | number>>): Promise<void>;
  markExported(uid: string, documentId: string, attemptIds: string[]): Promise<void>;
}

// ─── Responses (fixed, generic messages: never a library or Google message) ─────────────────

const MESSAGES = {
  stale: "This file changed since the preview. Preview again.",
  reconnect: "This Google Drive connection needs to be reconnected.",
  permission: "Study Lamp doesn't have permission to edit this file in Google. Reopen it from Drive or reconnect Google Drive.",
  notFound: "This file wasn't found in Google. It may have been deleted or moved to the trash.",
  unavailable: "Google couldn't be reached. Please try again shortly.",
  rateLimited: "Google is limiting requests right now. Please try again in a minute.",
  internal: "Couldn't complete the request.",
} as const;

function respond(status: number, body: Record<string, unknown>): AppendResponse {
  return { status, body };
}

function fail(status: number, error: string, code: string): AppendResponse {
  return respond(status, { error, code });
}

export function mapAppendFailure(error: unknown, deps: Pick<ReadDeps, "connectionErrorCode">, label: string): AppendResponse {
  if (error instanceof NothingToAppendError) return fail(409, error.message, "nothing_to_add");

  const connectionCode = deps.connectionErrorCode(error);
  if (connectionCode === "network") return fail(502, MESSAGES.unavailable, "unavailable");
  if (connectionCode) return fail(409, MESSAGES.reconnect, "reconnect");

  if (error instanceof GoogleApiError) {
    switch (error.kind) {
      case "auth": return fail(409, MESSAGES.reconnect, "reconnect");
      case "permission": return fail(403, MESSAGES.permission, "permission");
      case "not_found": return fail(404, MESSAGES.notFound, "not_found");
      case "revision_changed": return fail(409, MESSAGES.stale, "stale");
      case "rate_limited": return fail(429, MESSAGES.rateLimited, "rate_limited");
      default:
        logServerError(label, error);
        return fail(502, MESSAGES.unavailable, "unavailable");
    }
  }
  logServerError(label, error);
  return fail(500, MESSAGES.internal, "internal");
}

function responseForDecision(
  decision: ApplyDecision | undefined,
  writeError: unknown,
  deps: Pick<ReadDeps, "connectionErrorCode">,
  label: string,
  warnings: string[],
): AppendResponse {
  if (!decision) return fail(500, MESSAGES.internal, "internal");
  switch (decision.status) {
    case "applied":
      return respond(200, { ok: true, status: "applied", ...(warnings.length > 0 ? { warnings } : {}) });
    case "stale":
      return fail(409, MESSAGES.stale, "stale");
    case "skipped":
      if (decision.code === "revision_changed") return fail(409, MESSAGES.stale, "stale");
      return fail(409, "Nothing was written.", decision.code ?? "skipped");
    case "failed":
      return writeError ? mapAppendFailure(writeError, deps, label) : fail(500, MESSAGES.internal, "internal");
    default:
      return fail(500, MESSAGES.internal, "internal");
  }
}

// ─── Shared validation ─────────────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function validateRecord(record: PersonalDocumentRecord | null, fileType: "docx" | "xlsx"): AppendResponse | null {
  if (!record) return fail(404, "Document not found.", "document_not_found");
  if (!record.googleNative || record.fileType !== fileType || !record.driveFileId || !record.driveConnectionId || !SAFE_ID.test(record.driveFileId)) {
    return fail(
      400,
      fileType === "docx" ? "Only Google Docs can be appended to." : "Only Google Sheets can be appended to.",
      "not_google_native",
    );
  }
  return null;
}

function openUrlFor(fileType: "docx" | "xlsx", driveFileId: string): string {
  return fileType === "docx"
    ? `https://docs.google.com/document/d/${driveFileId}/edit`
    : `https://docs.google.com/spreadsheets/d/${driveFileId}/edit`;
}

function logEntry(
  deps: Pick<ReadDeps, "now">,
  scope: "docs_append" | "sheets_append",
  title: string,
  result: GoogleSyncLogEntry["result"],
): GoogleSyncLogEntry {
  // Goal-style fields only: a title and a result. Never document text, tokens or row contents (Z3 item 4).
  return {
    at: deps.now().toISOString(),
    scope,
    direction: "study_lamp_to_google",
    itemKind: "append",
    titleSnapshot: title,
    fields: [],
    result,
  };
}

async function recordResult(deps: ReadDeps & WriteDeps, uid: string, entry: GoogleSyncLogEntry): Promise<void> {
  // The log is bookkeeping about a write that already happened (or was refused); it must not change the outcome.
  try {
    await deps.log(uid, entry);
  } catch (error) {
    logServerError("Failed to write the Google append log", error);
  }
  void deps.pruneUsedTokens(uid)?.catch?.(() => undefined);
}

// ─── Docs: preview ──────────────────────────────────────────────────────────

export async function previewDocsAppend(
  deps: DocsReadDeps,
  input: { uid: string; documentId: string; content: string },
): Promise<AppendResponse> {
  const documentId = input.documentId.trim();
  if (!SAFE_ID.test(documentId) || !isDocAppendKind(input.content)) {
    return fail(400, "documentId and content are required.", "invalid_request");
  }
  const kind = input.content;

  try {
    const record = await deps.loadRecord(input.uid, documentId);
    const invalid = validateRecord(record, "docx");
    if (invalid) return invalid;
    const doc = record!;

    return await deps.withAccessToken(input.uid, doc.driveConnectionId!, async (accessToken) => {
      // Read-only calls only. Nothing below writes to Google, Firestore or a goal.
      const end = await deps.getDocumentEnd(accessToken, doc.driveFileId!);
      const sources = await deps.loadDocInputs(input.uid, documentId, kind);
      const { body, truncated } = buildDocAppendBody(kind, sources);
      const heading = formatGoogleDocHeading(deps.now());
      const item = buildDocsAppendPlanItem({ documentId, kind, documentTitle: doc.title, heading, body, revisionId: end.revisionId });
      const planToken = signPlanToken({ uid: input.uid, scope: "docs_append", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }] });
      return respond(200, {
        planToken,
        item,
        preview: {
          documentTitle: doc.title,
          openUrl: openUrlFor("docx", doc.driveFileId!),
          kind,
          kindLabel: KIND_LABELS[kind],
          heading,
          text: body,
          truncated,
        },
      });
    });
  } catch (error) {
    return mapAppendFailure(error, deps, "Google Docs append preview failed");
  }
}

// ─── Docs: apply ────────────────────────────────────────────────────────────

export async function applyDocsAppend(
  deps: DocsApplyDeps,
  input: { uid: string; planToken: string; accepted: string[]; documentId: string },
): Promise<AppendResponse> {
  const documentId = input.documentId.trim();
  if (!input.planToken || !SAFE_ID.test(documentId)) return fail(400, "planToken and documentId are required.", "invalid_request");

  // (a) verify the token
  let verified: VerifiedPlanToken;
  try {
    verified = verifyPlanToken(input.planToken, input.uid, "docs_append");
  } catch (error) {
    if (error instanceof PlanTokenVerificationError) return fail(401, "Invalid or expired plan token.", "invalid_token");
    return mapAppendFailure(error, deps, "Google Docs append token check failed");
  }

  // The token must be for THIS document. The kind is read from the token (by item id), never from the request.
  const binding = findDocsAppendBinding(verified.items, documentId);
  if (!binding) return fail(400, "This plan does not match this document.", "wrong_document");
  if (!input.accepted.includes(binding.itemId)) return fail(400, "The change was not accepted.", "not_accepted");

  try {
    // One-time token: claimed BEFORE anything is read from Google or written.
    const claimed = await deps.markTokenUsed(input.uid, verified.jti, verified.exp);
    if (!claimed) return fail(409, "This plan was already applied. Preview again.", "plan_already_applied");

    const record = await deps.loadRecord(input.uid, documentId);
    const invalid = validateRecord(record, "docx");
    if (invalid) return invalid;
    const doc = record!;

    const holder: { error: unknown; warnings: string[] } = { error: null, warnings: [] };
    const response = await deps.withAccessToken(input.uid, doc.driveConnectionId!, async (accessToken) => {
      // (b) re-read CURRENT state: the revision from Google, the content rebuilt from stored data.
      const end = await deps.getDocumentEnd(accessToken, doc.driveFileId!);
      const sources = await deps.loadDocInputs(input.uid, documentId, binding.kind);
      const { body } = buildDocAppendBody(binding.kind, sources);
      const heading = formatGoogleDocHeading(deps.now());
      // (c) recompute the plan item (same builder as the preview)
      const fresh = buildDocsAppendPlanItem({ documentId, kind: binding.kind, documentTitle: doc.title, heading, body, revisionId: end.revisionId });

      // (d) the gate compares fingerprints and only then calls the writer
      const decisions = await applyConfirmed({
        token: verified,
        accepted: [binding.itemId],
        freshPlan: [fresh],
        writers: {
          [fresh.itemId]: async () => {
            try {
              await deps.appendToDocument(accessToken, doc.driveFileId!, { revisionId: end.revisionId, endIndex: end.endIndex, heading, body });
            } catch (error) {
              if (error instanceof GoogleApiError && error.kind === "revision_changed") return { skipped: "revision_changed" };
              holder.error = error;
              throw error;
            }
          },
        },
        expectedUser: input.uid,
        expectedScope: "docs_append",
      });

      const decision = decisions.find((entry) => entry.itemId === fresh.itemId) ?? decisions[0];
      await recordResult(deps, input.uid, logEntry(deps, "docs_append", fresh.title, decision?.status ?? "failed"));
      return responseForDecision(decision, holder.error, deps, "Google Docs append failed", holder.warnings);
    });
    return response;
  } catch (error) {
    return mapAppendFailure(error, deps, "Google Docs append apply failed");
  }
}

// ─── Sheets: preview ────────────────────────────────────────────────────────

export async function previewSheetsAppend(
  deps: SheetsReadDeps,
  input: { uid: string; documentId: string },
): Promise<AppendResponse> {
  const documentId = input.documentId.trim();
  if (!SAFE_ID.test(documentId)) return fail(400, "documentId is required.", "invalid_request");

  try {
    const record = await deps.loadRecord(input.uid, documentId);
    const invalid = validateRecord(record, "xlsx");
    if (invalid) return invalid;
    const doc = record!;

    return await deps.withAccessToken(input.uid, doc.driveConnectionId!, async (accessToken) => {
      const tabState = await deps.getTabState(accessToken, doc.driveFileId!);
      const { attempts, exportedIds } = await deps.loadSheetAttempts(input.uid, documentId);
      const plan = buildSheetExportPlan({ attempts, exportedIds, materialTitle: doc.title });
      if (plan.rows.length === 0) throw new NothingToAppendError("There are no new quiz results to add.");

      const item = buildSheetsAppendPlanItem({ documentId, documentTitle: doc.title, plan, tabState });
      const planToken = signPlanToken({ uid: input.uid, scope: "sheets_append", items: [{ itemId: item.itemId, fingerprint: item.fingerprint }] });
      return respond(200, {
        planToken,
        item,
        preview: {
          documentTitle: doc.title,
          openUrl: openUrlFor("xlsx", doc.driveFileId!),
          tab: SHEET_TAB,
          willCreateTab: tabState === "absent",
          header: tabState === "present_with_header" ? null : SHEET_HEADER,
          rows: plan.rows,
          remaining: plan.remaining,
        },
      });
    });
  } catch (error) {
    return mapAppendFailure(error, deps, "Google Sheets append preview failed");
  }
}

// ─── Sheets: apply ──────────────────────────────────────────────────────────

export async function applySheetsAppend(
  deps: SheetsApplyDeps,
  input: { uid: string; planToken: string; accepted: string[]; documentId: string },
): Promise<AppendResponse> {
  const documentId = input.documentId.trim();
  if (!input.planToken || !SAFE_ID.test(documentId)) return fail(400, "planToken and documentId are required.", "invalid_request");

  let verified: VerifiedPlanToken;
  try {
    verified = verifyPlanToken(input.planToken, input.uid, "sheets_append");
  } catch (error) {
    if (error instanceof PlanTokenVerificationError) return fail(401, "Invalid or expired plan token.", "invalid_token");
    return mapAppendFailure(error, deps, "Google Sheets append token check failed");
  }

  const binding = findSheetsAppendBinding(verified.items, documentId);
  if (!binding) return fail(400, "This plan does not match this document.", "wrong_document");
  if (!input.accepted.includes(binding.itemId)) return fail(400, "The change was not accepted.", "not_accepted");

  try {
    const claimed = await deps.markTokenUsed(input.uid, verified.jti, verified.exp);
    if (!claimed) return fail(409, "This plan was already applied. Preview again.", "plan_already_applied");

    const record = await deps.loadRecord(input.uid, documentId);
    const invalid = validateRecord(record, "xlsx");
    if (invalid) return invalid;
    const doc = record!;

    const holder: { error: unknown; warnings: string[] } = { error: null, warnings: [] };
    return await deps.withAccessToken(input.uid, doc.driveConnectionId!, async (accessToken) => {
      const tabState = await deps.getTabState(accessToken, doc.driveFileId!);
      const { attempts, exportedIds } = await deps.loadSheetAttempts(input.uid, documentId);
      const plan = buildSheetExportPlan({ attempts, exportedIds, materialTitle: doc.title });
      if (plan.rows.length === 0) throw new NothingToAppendError("There are no new quiz results to add.");
      const fresh = buildSheetsAppendPlanItem({ documentId, documentTitle: doc.title, plan, tabState });

      const decisions = await applyConfirmed({
        token: verified,
        accepted: [binding.itemId],
        freshPlan: [fresh],
        writers: {
          [fresh.itemId]: async () => {
            try {
              if (tabState === "absent") await deps.createSheet(accessToken, doc.driveFileId!, SHEET_TAB);
              await deps.appendRows(accessToken, doc.driveFileId!, SHEET_TAB, sheetValuesToAppend(plan, tabState));
            } catch (error) {
              holder.error = error;
              throw error;
            }
            // Mark ONLY the attempts that are in the confirmed plan (their ids are part of the fingerprint).
            try {
              await deps.markExported(input.uid, documentId, plan.attemptIds);
            } catch (error) {
              logServerError("Failed to mark quiz attempts as exported", error);
              holder.warnings.push("export_marker_failed");
            }
          },
        },
        expectedUser: input.uid,
        expectedScope: "sheets_append",
      });

      const decision = decisions.find((entry) => entry.itemId === fresh.itemId) ?? decisions[0];
      await recordResult(deps, input.uid, logEntry(deps, "sheets_append", fresh.title, decision?.status ?? "failed"));
      return responseForDecision(decision, holder.error, deps, "Google Sheets append failed", holder.warnings);
    });
  } catch (error) {
    return mapAppendFailure(error, deps, "Google Sheets append apply failed");
  }
}
