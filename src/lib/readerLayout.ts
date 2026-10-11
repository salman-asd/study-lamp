/**
 * Layout decisions for the document page: where the study panel lives, how tall the reader is,
 * and which zoom a PDF opens with. Pure: no React.
 */
import type { ReaderZoomPref, StudyDock } from "@/lib/generalPrefs";

export type { StudyDock } from "@/lib/generalPrefs";
export type PdfZoomMode = "fit-width" | "fit-page" | number;

/** Below this width phones/tablets use the bottom-sheet study panel and the dock buttons are hidden. */
export const DOCK_MIN_WIDTH = 1024;
export const WIDE_DOCK_MIN_WIDTH = 1536;

/** saved wins; otherwise >=1536 -> right, 1024..1535 -> bottom, <1024 -> hidden (the mobile sheet is used there). */
export function resolveStudyDock(saved: StudyDock | null, viewportWidth: number): StudyDock {
  if (saved) return saved;
  if (viewportWidth >= WIDE_DOCK_MIN_WIDTH) return "right";
  if (viewportWidth >= DOCK_MIN_WIDTH) return "bottom";
  return "hidden";
}

/** Full class strings (kept literal so Tailwind sees them). */
export function readerHeightClass(dock: StudyDock, focus: boolean): string {
  if (focus) return "h-[68dvh] min-h-[28rem] lg:h-[calc(100dvh-9rem)] lg:min-h-[30rem]";
  if (dock === "bottom") return "h-[68dvh] min-h-[28rem] lg:h-[70dvh] lg:min-h-[30rem]";
  if (dock === "hidden") return "h-[68dvh] min-h-[28rem] lg:h-[calc(100dvh-12rem)] lg:min-h-[30rem]";
  return "h-[68vh] min-h-[28rem] lg:h-[calc(100vh-15rem)] lg:min-h-[35rem]";
}

export function pageGridClass(dock: StudyDock): string {
  return dock === "right" ? "lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]" : "grid-cols-1";
}

/**
 * Zoom a PDF opens with. A saved zoom counts only when the person zoomed by hand in this
 * browser (`manualZoom`); every other saved value (old documents, other devices) is ignored,
 * so a zoom saved on a wide monitor can no longer cause a horizontal scroll bar.
 */
export function decideInitialZoom(pref: ReaderZoomPref, manualZoom: number | null): PdfZoomMode {
  if (manualZoom !== null && Number.isFinite(manualZoom) && manualZoom >= 0.1 && manualZoom <= 10) return manualZoom;
  if (pref === "actual") return 1;
  return pref;
}

/** Fit modes follow the container size; a number does not. */
export function followsContainer(mode: PdfZoomMode): mode is "fit-width" | "fit-page" {
  return mode === "fit-width" || mode === "fit-page";
}

export function clampZoom(value: number): number {
  return Math.min(5, Math.max(0.25, Math.round(value * 100) / 100));
}

const manualKey = (documentKey: string) => `sl.pdfZoom.${documentKey}`;

export function readManualZoom(storage: Pick<Storage, "getItem"> | null, documentKey: string): number | null {
  try {
    const raw = storage?.getItem(manualKey(documentKey));
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeManualZoom(storage: Pick<Storage, "setItem" | "removeItem"> | null, documentKey: string, zoom: number | null): void {
  try {
    if (!storage) return;
    if (zoom === null) storage.removeItem(manualKey(documentKey));
    else storage.setItem(manualKey(documentKey), String(zoom));
  } catch {
    // ignore
  }
}
