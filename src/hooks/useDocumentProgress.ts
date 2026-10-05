import * as React from "react";
import { toast } from "sonner";
import { mergeReaderProgress, type ReaderProgressInput } from "@/lib/readerProgress";
import {
  savePersonalDocumentAnnotations,
  updatePersonalDocumentReadingProgress,
} from "@/lib/firestore/personalDocuments";
import type { PersonalDocument } from "@/types";

/**
 * Debounced saving of the reading position and PDF annotations for one document.
 * Reading progress is flushed on timer, when the tab is hidden or the page closes, and on unmount.
 */
export function useDocumentProgress(user: { uid: string } | null, doc: PersonalDocument | null) {
  const [annotations, setAnnotations] = React.useState<unknown[]>([]);
  const progressSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgress = React.useRef<ReaderProgressInput | null>(null);
  const pendingAnnotations = React.useRef<unknown[] | null>(null);

  // Sends the pending reading position right now (debounce timer, tab hidden, page closing, unmount).
  const flushReaderProgress = React.useCallback(() => {
    if (progressSaveTimer.current) {
      clearTimeout(progressSaveTimer.current);
      progressSaveTimer.current = null;
    }
    const pending = pendingProgress.current;
    pendingProgress.current = null;
    if (!pending || !user || !doc) return;
    void updatePersonalDocumentReadingProgress(user.uid, doc.id, pending, doc.fileType).catch((error) => {
      toast.error(error?.message || "Couldn't save reading progress.");
    });
  }, [user, doc]);

  React.useEffect(() => () => {
    flushReaderProgress();
    if (annotationSaveTimer.current) {
      clearTimeout(annotationSaveTimer.current);
      if (user && doc && pendingAnnotations.current) {
        void savePersonalDocumentAnnotations(user.uid, doc.id, pendingAnnotations.current).catch(() => {});
      }
    }
  }, [user, doc, flushReaderProgress]);

  // The 2 s debounce would lose the last position when the tab is closed or backgrounded, so flush on those events.
  React.useEffect(() => {
    const onPageHide = () => flushReaderProgress();
    const onVisibility = () => { if (window.document.visibilityState === "hidden") flushReaderProgress(); };
    window.addEventListener("pagehide", onPageHide);
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushReaderProgress]);

  /** Shared by the PDF, Word and Excel readers; each reports only the fields that belong to its type. */
  function queueReaderProgress(progress: ReaderProgressInput) {
    if (!user || !doc) return;
    pendingProgress.current = mergeReaderProgress(pendingProgress.current, progress);
    if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current);
    progressSaveTimer.current = setTimeout(flushReaderProgress, 2_000);
  }

  function queueAnnotationSave(nextAnnotations: unknown[]) {
    if (!user || !doc) return;
    pendingAnnotations.current = nextAnnotations;
    setAnnotations(nextAnnotations);
    if (annotationSaveTimer.current) clearTimeout(annotationSaveTimer.current);
    annotationSaveTimer.current = setTimeout(() => {
      annotationSaveTimer.current = null;
      const pending = pendingAnnotations.current;
      pendingAnnotations.current = null;
      if (pending) void savePersonalDocumentAnnotations(user.uid, doc.id, pending).catch((error) => {
        toast.error(error?.message || "Couldn't save PDF annotations.");
      });
    }, 2_000);
  }

  return { annotations, setAnnotations, queueReaderProgress, queueAnnotationSave };
}
