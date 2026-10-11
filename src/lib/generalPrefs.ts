/**
 * General (cross-device) preferences: one small map stored at users/{uid}.generalPrefs.
 * Pure: no React, no Firebase. Shared by the API route, the client store and the pages.
 */

export type StudyDock = "right" | "bottom" | "hidden";
export type ReaderZoomPref = "fit-width" | "fit-page" | "actual";

export interface GeneralPrefs {
  studyViewMode: "grid" | "list";
  studySort: "recent" | "title" | "size";
  /** null = automatic by screen width. */
  studyDock: StudyDock | null;
  readerZoom: ReaderZoomPref;
  viewerPdf: "reader" | "drive-preview";
  viewerGoogleDoc: "reader" | "google-preview";
  viewerGoogleSheet: "reader" | "google-preview";
  /** Word and Excel files. */
  viewerOffice: "reader" | "drive-preview";
}

export const DEFAULT_GENERAL_PREFS: GeneralPrefs = {
  studyViewMode: "grid",
  studySort: "recent",
  studyDock: null,
  readerZoom: "fit-width",
  viewerPdf: "reader",
  viewerGoogleDoc: "reader",
  viewerGoogleSheet: "reader",
  viewerOffice: "reader",
};

export const GENERAL_PREF_KEYS = Object.keys(DEFAULT_GENERAL_PREFS) as Array<keyof GeneralPrefs>;

export const MAX_GENERAL_PREFS_BYTES = 1024;

const ALLOWED: { [K in keyof GeneralPrefs]: ReadonlyArray<GeneralPrefs[K]> } = {
  studyViewMode: ["grid", "list"],
  studySort: ["recent", "title", "size"],
  studyDock: ["right", "bottom", "hidden", null],
  readerZoom: ["fit-width", "fit-page", "actual"],
  viewerPdf: ["reader", "drive-preview"],
  viewerGoogleDoc: ["reader", "google-preview"],
  viewerGoogleSheet: ["reader", "google-preview"],
  viewerOffice: ["reader", "drive-preview"],
};

export function isValidGeneralPref<K extends keyof GeneralPrefs>(key: K, value: unknown): value is GeneralPrefs[K] {
  return (ALLOWED[key] as ReadonlyArray<unknown>).includes(value);
}

/** Keeps only known keys with valid values; everything else is dropped. Never throws. */
export function sanitizePartialPrefs(input: unknown): Partial<GeneralPrefs> {
  const result: Record<string, unknown> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result as Partial<GeneralPrefs>;
  const source = input as Record<string, unknown>;
  for (const key of GENERAL_PREF_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (isValidGeneralPref(key, source[key])) result[key] = source[key];
  }
  return result as Partial<GeneralPrefs>;
}

/** A complete, valid prefs object: invalid or missing values fall back to the defaults. */
export function sanitizeGeneralPrefs(input: unknown): GeneralPrefs {
  return { ...DEFAULT_GENERAL_PREFS, ...sanitizePartialPrefs(input) };
}

/** Merge a validated partial into the stored map. Only changed keys differ from `current`. */
export function mergeGeneralPrefs(current: unknown, partial: Partial<GeneralPrefs>): GeneralPrefs {
  return { ...sanitizeGeneralPrefs(current), ...sanitizePartialPrefs(partial) };
}

export function generalPrefsSize(prefs: GeneralPrefs): number {
  return new TextEncoder().encode(JSON.stringify(prefs)).length;
}
