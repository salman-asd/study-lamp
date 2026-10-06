import { DriveConnectionError, withDriveAccessToken } from "@/lib/server/driveConnections";
import { appendToDocument, getDocumentEnd } from "@/lib/server/googleDocs";
import { loadDocAppendInputs, loadDocumentAttempts, loadExportedAttemptIds, loadPersonalDocumentRecord, markAttemptsExported } from "@/lib/server/googleAppendData";
import type { DocsApplyDeps, SheetsApplyDeps } from "@/lib/server/googleAppendApply";
import { appendRows, createSheet, getSheetTabState } from "@/lib/server/googleSheets";
import { saveSyncLogEntry } from "@/lib/server/googleSyncLog";
import { markTokenUsed, pruneUsedTokens } from "@/lib/server/googleUsedTokens";

/** Real wiring for the append routes. Kept out of googleAppendApply.ts so that module stays testable with fakes. */

const common = {
  loadRecord: loadPersonalDocumentRecord,
  withAccessToken: withDriveAccessToken,
  connectionErrorCode: (error: unknown) => (error instanceof DriveConnectionError ? error.code : null),
  now: () => new Date(),
  markTokenUsed,
  pruneUsedTokens: (uid: string) => pruneUsedTokens(uid),
  log: saveSyncLogEntry,
};

export const realDocsDeps: DocsApplyDeps = {
  ...common,
  getDocumentEnd,
  loadDocInputs: loadDocAppendInputs,
  appendToDocument,
};

export const realSheetsDeps: SheetsApplyDeps = {
  ...common,
  getTabState: (accessToken, spreadsheetId) => getSheetTabState(accessToken, spreadsheetId),
  async loadSheetAttempts(uid, documentId) {
    const attempts = await loadDocumentAttempts(uid, documentId);
    const exportedIds = await loadExportedAttemptIds(uid, documentId, attempts.map((attempt) => attempt.id));
    return { attempts, exportedIds };
  },
  createSheet,
  appendRows,
  markExported: markAttemptsExported,
};
