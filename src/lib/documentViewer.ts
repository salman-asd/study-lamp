/**
 * Which viewer shows a study document, and the Google preview URLs.
 * Pure: no React, no Firebase. Never builds docs.google.com/viewer?url= and never puts a
 * Study Lamp signed URL into a Google URL (decision D22).
 */
import type { GeneralPrefs } from "@/lib/generalPrefs";
import { isDriveFileId } from "@/lib/googleLinks";

export type ViewerKind = "reader" | "drive-preview" | "google-preview";
export type ViewerPrefKey = "viewerPdf" | "viewerGoogleDoc" | "viewerGoogleSheet" | "viewerOffice";

export interface ViewerDoc {
  id?: string;
  fileType: "pdf" | "docx" | "xlsx" | "pptx";
  mimeType?: string;
  googleNative?: boolean;
  driveFileId: string;
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";

/** Which Settings -> General key controls this document, or null when there is no choice (PowerPoint). */
export function viewerPrefKey(doc: ViewerDoc): ViewerPrefKey | null {
  if (doc.fileType === "pptx") return null;
  if (doc.mimeType === GOOGLE_DOC) return "viewerGoogleDoc";
  if (doc.mimeType === GOOGLE_SHEET) return "viewerGoogleSheet";
  if (doc.fileType === "pdf") return "viewerPdf";
  return "viewerOffice";
}

/** The preview kind this document can use besides the reader. */
export function previewKindFor(doc: ViewerDoc): Exclude<ViewerKind, "reader"> {
  return doc.mimeType === GOOGLE_DOC || doc.mimeType === GOOGLE_SHEET ? "google-preview" : "drive-preview";
}

/** Options that exist for this file type (empty for PowerPoint: it always uses the Drive preview). */
export function viewerOptionsFor(doc: ViewerDoc): ViewerKind[] {
  return viewerPrefKey(doc) === null ? [] : ["reader", previewKindFor(doc)];
}

export function typeLabelPlural(doc: ViewerDoc): string {
  if (doc.mimeType === GOOGLE_DOC) return "Google Docs";
  if (doc.mimeType === GOOGLE_SHEET) return "Google Sheets";
  if (doc.fileType === "pdf") return "PDFs";
  if (doc.fileType === "pptx") return "PowerPoint files";
  return "Word and Excel files";
}

export function resolveViewer(doc: ViewerDoc, prefs: Pick<GeneralPrefs, ViewerPrefKey>, override?: ViewerKind | null): ViewerKind {
  const key = viewerPrefKey(doc);
  if (key === null) return "drive-preview";
  const options = viewerOptionsFor(doc);
  if (override && options.includes(override)) return override;
  const value: ViewerKind = prefs[key];
  return options.includes(value) ? value : "reader";
}

/** Embeddable preview URL, or null for the in-app reader or an invalid file id. */
export function previewUrl(doc: ViewerDoc, kind: ViewerKind): string | null {
  if (kind === "reader" || !isDriveFileId(doc.driveFileId)) return null;
  const id = doc.driveFileId;
  if (kind === "drive-preview") return `https://drive.google.com/file/d/${id}/preview`;
  if (doc.mimeType === GOOGLE_DOC) return `https://docs.google.com/document/d/${id}/preview`;
  if (doc.mimeType === GOOGLE_SHEET) return `https://docs.google.com/spreadsheets/d/${id}/preview`;
  return null;
}

export const VIEWER_LABELS: Record<ViewerKind, string> = {
  reader: "Study Lamp reader",
  "drive-preview": "Drive preview",
  "google-preview": "Google preview",
};

/** One shared text for Settings -> General and the viewing-page menu. */
export const VIEWER_COPY: Record<"reader" | "preview", { pros: string; cons: string }> = {
  reader: {
    pros: "Annotations, last page, zoom memory, Explain this page; works without a Google sign-in in this browser.",
    cons: "Google Docs and Sheets show an exported copy (a note shows when they last changed in Google).",
  },
  preview: {
    pros: "Always the live, current Google version, native look, formulas and tabs intact.",
    cons: "No annotations, progress or page tools; this browser must be signed in to the same Google account and may show a sign-in page when third-party cookies are blocked.",
  },
};

export function viewerCopy(kind: ViewerKind) {
  return kind === "reader" ? VIEWER_COPY.reader : VIEWER_COPY.preview;
}

/** Per-document choice kept only for this browser tab (never written to Firestore). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const overrideKey = (documentId: string) => `sl.viewer.${documentId}`;

export function readViewerOverride(storage: StorageLike | null, documentId: string): ViewerKind | null {
  try {
    const value = storage?.getItem(overrideKey(documentId));
    return value === "reader" || value === "drive-preview" || value === "google-preview" ? value : null;
  } catch {
    return null;
  }
}

export function writeViewerOverride(storage: StorageLike | null, documentId: string, kind: ViewerKind | null): void {
  try {
    if (!storage) return;
    if (kind === null) storage.removeItem(overrideKey(documentId));
    else storage.setItem(overrideKey(documentId), kind);
  } catch {
    // Storage unavailable: the choice then lasts until the page reloads.
  }
}
