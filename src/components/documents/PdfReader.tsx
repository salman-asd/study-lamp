"use client";

import * as React from "react";
import Link from "next/link";
import { PDFViewer, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpenText, Download, ExternalLink, HardDrive, RotateCw } from "lucide-react";
import { toast } from "sonner";

const PDF_DOCUMENT_ID = "study-material-pdf";

interface PdfReaderProps {
  documentTitle: string;
  sourceUrl: string | null;
  initialError?: string | null;
  driveViewUrl: string;
  onDownload: () => void;
  refreshSourceUrl: () => Promise<string>;
  initialPage?: number;
  initialZoom?: number;
  requestedPage?: number | null;
  savedAnnotations?: unknown[];
  onPageJumpHandled?: () => void;
  onProgress?: (progress: { lastPage: number; zoom: number }) => void;
  onAnnotationsChange?: (annotations: unknown[]) => void;
  onExplainPage?: (pageNumber: number, text: string) => Promise<void>;
  explainingPage?: boolean;
}

export function PdfReader({
  documentTitle,
  sourceUrl,
  initialError,
  driveViewUrl,
  onDownload,
  refreshSourceUrl,
  initialPage = 1,
  initialZoom = 1,
  requestedPage = null,
  savedAnnotations = [],
  onPageJumpHandled,
  onProgress,
  onAnnotationsChange,
  onExplainPage,
  explainingPage = false,
}: PdfReaderProps) {
  const [readerError, setReaderError] = React.useState<string | null>(initialError ?? null);
  const [activeSourceUrl, setActiveSourceUrl] = React.useState(sourceUrl);
  const [reloading, setReloading] = React.useState(false);
  const [documentReady, setDocumentReady] = React.useState(false);
  const [slowLoad, setSlowLoad] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(Math.max(1, initialPage));
  const latestUrl = React.useRef(activeSourceUrl);
  const latestRefresh = React.useRef(refreshSourceUrl);
  const latestProgress = React.useRef(onProgress);
  const latestAnnotationChange = React.useRef(onAnnotationsChange);
  const latestSavedAnnotations = React.useRef(savedAnnotations);
  const latestExplainPage = React.useRef(onExplainPage);
  const pageNumber = React.useRef(Math.max(1, initialPage));
  const zoomLevel = React.useRef(initialZoom);
  const restoringInitialPosition = React.useRef(true);
  const annotationExportTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retrying = React.useRef(false);
  const retriedUrl = React.useRef<string | null>(null);
  const registry = React.useRef<PluginRegistry | null>(null);
  const eventUnsubscribers = React.useRef<Array<() => void>>([]);
  const config = React.useMemo(() => ({
    documentManager: activeSourceUrl ? {
      initialDocuments: [{
        url: activeSourceUrl,
        documentId: PDF_DOCUMENT_ID,
        name: documentTitle,
        mode: "range-request" as const,
        scale: initialZoom,
      }],
    } : undefined,
    wasmUrl: "/wasm/pdfium.wasm",
    worker: true,
    fontFallback: null,
    fonts: { ui: null, signature: null },
    theme: {
      preference: "system" as const,
      light: { accent: { primary: "hsl(var(--primary))" } },
      dark: { accent: { primary: "hsl(var(--primary))" } },
    },
    tabBar: "never" as const,
  }), [activeSourceUrl, documentTitle, initialZoom]);

  latestUrl.current = activeSourceUrl;
  latestRefresh.current = refreshSourceUrl;
  latestProgress.current = onProgress;
  latestAnnotationChange.current = onAnnotationsChange;
  latestSavedAnnotations.current = savedAnnotations;
  latestExplainPage.current = onExplainPage;

  React.useEffect(() => {
    pageNumber.current = Math.max(1, initialPage);
    setCurrentPage(Math.max(1, initialPage));
    zoomLevel.current = Math.max(0.1, initialZoom);
    restoringInitialPosition.current = true;
  }, [initialPage, initialZoom]);

  React.useEffect(() => {
    setReaderError(initialError ?? null);
  }, [initialError]);

  React.useEffect(() => {
    setActiveSourceUrl(sourceUrl);
    if (sourceUrl) setReaderError(null);
  }, [sourceUrl]);

  React.useEffect(() => () => {
    eventUnsubscribers.current.forEach((unsubscribe) => unsubscribe());
    if (annotationExportTimer.current) clearTimeout(annotationExportTimer.current);
    registry.current = null;
  }, []);

  // Never leave the person staring at a skeleton with no explanation: after 20 s
  // without the document opening, show a hint with ways out. Nothing is torn down,
  // so a slow-but-working load still completes normally.
  React.useEffect(() => {
    setSlowLoad(false);
    if (documentReady || !activeSourceUrl || readerError) return;
    const timer = setTimeout(() => setSlowLoad(true), 20_000);
    return () => clearTimeout(timer);
  }, [documentReady, activeSourceUrl, readerError]);

  React.useEffect(() => {
    if (!requestedPage || !documentReady || !registry.current) return;
    const scroll = registry.current.getPlugin("scroll")?.provides?.();
    if (!scroll) return;
    const totalPages = scroll.forDocument(PDF_DOCUMENT_ID).getTotalPages();
    scroll.forDocument(PDF_DOCUMENT_ID).scrollToPage({
      pageNumber: Math.max(1, Math.min(requestedPage, totalPages || requestedPage)),
      behavior: "smooth",
    });
    onPageJumpHandled?.();
  }, [requestedPage, documentReady, onPageJumpHandled]);

  async function retryAtCurrentPage(): Promise<void> {
    if (retrying.current) return;
    retrying.current = true;
    setReloading(true);
    setReaderError(null);
    let removeLayoutListener: (() => void) | undefined;
    try {
      const freshUrl = await latestRefresh.current();
      const currentRegistry = registry.current;
      if (!currentRegistry) {
        setActiveSourceUrl(freshUrl);
        retriedUrl.current = null;
        setDocumentReady(false);
        return;
      }
      const manager = currentRegistry.getPlugin("document-manager")?.provides?.();
      const scroll = currentRegistry.getPlugin("scroll")?.provides?.();
      if (!manager || !scroll) throw new Error("The PDF reader could not reconnect to the document.");

      await manager.closeDocument(PDF_DOCUMENT_ID).toPromise().catch(() => undefined);
      const restoredLayout = new Promise<void>((resolve) => {
        removeLayoutListener = scroll.onLayoutReady((event: { documentId: string; isInitial: boolean; totalPages: number }) => {
          if (event.documentId !== PDF_DOCUMENT_ID || !event.isInitial) return;
          scroll.forDocument(PDF_DOCUMENT_ID).scrollToPage({
            pageNumber: Math.max(1, Math.min(pageNumber.current, event.totalPages)),
            behavior: "instant",
          });
          removeLayoutListener?.();
          resolve();
        });
      });

      const opened = await manager.openDocumentUrl({
        url: freshUrl,
        documentId: PDF_DOCUMENT_ID,
        name: documentTitle,
        mode: "range-request",
        scale: zoomLevel.current,
        autoActivate: true,
      }).toPromise();
      await opened.task.toPromise();
      await restoredLayout;
      latestUrl.current = freshUrl;
      retriedUrl.current = null;
      setDocumentReady(true);
    } catch (error) {
      setReaderError(friendlyPdfError(error, false));
    } finally {
      removeLayoutListener?.();
      retrying.current = false;
      setReloading(false);
    }
  }

  function handleViewerReady(readyRegistry: PluginRegistry) {
    eventUnsubscribers.current.forEach((unsubscribe) => unsubscribe());
    eventUnsubscribers.current = [];
    registry.current = readyRegistry;
    setDocumentReady(false);
    const manager = readyRegistry.getPlugin("document-manager")?.provides?.();
    const scroll = readyRegistry.getPlugin("scroll")?.provides?.();
    const zoom = readyRegistry.getPlugin("zoom")?.provides?.();
    const annotations = readyRegistry.getPlugin("annotation")?.provides?.();
    const onOpened = manager?.onDocumentOpened((document: { id: string }) => {
      if (document.id !== PDF_DOCUMENT_ID) return;
      setDocumentReady(true);
      if (latestSavedAnnotations.current.length > 0) {
        annotations?.importAnnotations(latestSavedAnnotations.current as never[]);
      }
    });
    const onError = manager?.onDocumentError((event: { documentId: string; message: string; code?: number; reason?: { code?: number; message?: string } }) => {
      if (event.documentId !== PDF_DOCUMENT_ID || retrying.current) return;
      const failure = event.reason ?? { code: event.code, message: event.message };
      const message = `${event.message} ${failure.message || ""}`.trim();
      // Browser console only; URLs are stripped because the Drive link carries a signature.
      console.warn("PDF reader error", { code: failure.code, message: message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) });
      const code = failure.code;
      if (code === 4 || /password/i.test(message)) {
        setReaderError("This PDF is password-protected. Open it in Drive to unlock or download it.");
        return;
      }
      if (code === 3 || /corrupt|invalid pdf|wrong format/i.test(message)) {
        setReaderError("This PDF appears to be damaged or uses an unsupported format.");
        return;
      }
      if (code === 2 || /404|file (was )?removed|not found/i.test(message)) {
        setReaderError("This file is no longer available in Google Drive.");
        return;
      }
      if (/409|connection|reconnect|refresh token|drive account/i.test(message)) {
        setReaderError("Your Google Drive connection needs attention.");
        return;
      }
      if ((/401|unauthorized|expired/i.test(message) || code === 1) && latestUrl.current && retriedUrl.current !== latestUrl.current) {
        retriedUrl.current = latestUrl.current;
        void retryAtCurrentPage();
        return;
      }
      setReaderError("The PDF could not be opened. Check the Drive connection or use the browser viewer.");
    });
    const onPageChange = scroll?.onPageChange((event: { documentId: string; pageNumber: number }) => {
      if (event.documentId !== PDF_DOCUMENT_ID) return;
      pageNumber.current = event.pageNumber;
      setCurrentPage(event.pageNumber);
      if (!restoringInitialPosition.current) latestProgress.current?.({ lastPage: event.pageNumber, zoom: zoomLevel.current });
    });
    const onLayoutReady = scroll?.onLayoutReady((event: { documentId: string; isInitial: boolean; totalPages: number }) => {
      if (event.documentId !== PDF_DOCUMENT_ID || !event.isInitial) return;
      const scope = scroll.forDocument(PDF_DOCUMENT_ID);
      const restorePage = Math.max(1, Math.min(initialPage, event.totalPages));
      pageNumber.current = restorePage;
      setCurrentPage(restorePage);
      if (restorePage !== 1) scope.scrollToPage({ pageNumber: restorePage, behavior: "instant" });
      const zoomScope = zoom?.forDocument(PDF_DOCUMENT_ID);
      if (initialZoom > 0 && Math.abs(initialZoom - 1) > 0.01) zoomScope?.requestZoom(initialZoom);
      restoringInitialPosition.current = false;
    });
    const onZoomChange = zoom?.forDocument(PDF_DOCUMENT_ID).onStateChange((state: { currentZoomLevel: number }) => {
      if (!Number.isFinite(state.currentZoomLevel) || state.currentZoomLevel <= 0) return;
      zoomLevel.current = state.currentZoomLevel;
      if (!restoringInitialPosition.current) latestProgress.current?.({ lastPage: pageNumber.current, zoom: state.currentZoomLevel });
    });
    const onAnnotationChange = annotations?.onAnnotationEvent((event: { documentId: string }) => {
      if (event.documentId !== PDF_DOCUMENT_ID || !annotations) return;
      if (annotationExportTimer.current) clearTimeout(annotationExportTimer.current);
      annotationExportTimer.current = setTimeout(() => {
        void annotations.exportAnnotations(undefined, PDF_DOCUMENT_ID).toPromise().then((items: Array<{ annotation: { type: number } }>) => {
          const serializable = items
            .filter((item) => item.annotation.type !== 13 && item.annotation.type !== 17)
            .map((item) => ({ annotation: item.annotation }));
          latestAnnotationChange.current?.(serializable);
        }).catch(() => {});
      }, 500);
    });
    eventUnsubscribers.current = [onOpened, onError, onPageChange, onLayoutReady, onZoomChange, onAnnotationChange]
      .filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
  }

  async function explainCurrentPage() {
    const currentRegistry = registry.current;
    if (!currentRegistry || !latestExplainPage.current) return;
    const documentManager = currentRegistry.getPlugin("document-manager")?.provides?.();
    const document = documentManager?.getDocument(PDF_DOCUMENT_ID);
    const page = document?.pages.find((item: { index: number }) => item.index === pageNumber.current - 1);
    if (!document || !page) throw new Error("The current page is still loading.");
    const pageText = await currentRegistry.getEngine().extractText(document, [page.index]).toPromise();
    const boundedText = pageText.trim().slice(0, 8000);
    if (!boundedText) throw new Error("No selectable text was found on this PDF page.");
    await latestExplainPage.current(pageNumber.current, boundedText);
  }

  if (readerError) {
    return (
      <ReaderFallback message={readerError} driveViewUrl={driveViewUrl} onDownload={onDownload} onRetry={retryAtCurrentPage} reloading={reloading} />
    );
  }

  if (!activeSourceUrl) {
    return (
      <div className="space-y-3 rounded-md border border-border p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-xs text-muted-foreground">Page {currentPage}</p>
        {onExplainPage && <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => void explainCurrentPage().catch((error) => toast.error(error instanceof Error ? error.message : "Couldn't read this page."))} loading={explainingPage} loadingText="Explaining…"><BookOpenText className="h-4 w-4" />Explain this page</Button>}
      </div>
      <div className="relative h-[68vh] min-h-[28rem] overflow-hidden bg-muted lg:h-[calc(100vh-15rem)] lg:min-h-[35rem]">
      {!documentReady && !reloading && (
        <div className="absolute inset-0 z-10 space-y-3 bg-background p-4">
          <Skeleton className="h-10 w-full" />
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Loading PDF">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
          <Skeleton className="mx-auto h-[calc(80%-1rem)] w-4/5" />
          {slowLoad && (
            <div className="absolute inset-x-4 bottom-4 flex flex-col items-center gap-2 rounded-md border border-border bg-card p-3 text-center text-sm text-muted-foreground shadow-sm">
              <p>Still loading. Large files can take a minute to come from Drive. If nothing appears, open it another way.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
                <Button asChild size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in browser viewer</a></Button>
              </div>
            </div>
          )}
        </div>
      )}
      {reloading && (
        <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-background/95 px-3 py-2 text-xs text-muted-foreground">
          <RotateCw className="h-3.5 w-3.5 animate-spin" /> Reconnecting to Drive and restoring page {pageNumber.current}…
        </div>
      )}
      <PDFViewer config={config} onReady={handleViewerReady} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

function ReaderFallback({
  message,
  driveViewUrl,
  onDownload,
  onRetry,
  reloading = false,
}: {
  message: string;
  driveViewUrl: string;
  onDownload: () => void;
  onRetry?: () => void;
  reloading?: boolean;
}) {
  return (
    <div className="flex min-h-[24rem] flex-col items-center justify-center gap-4 rounded-md border border-border bg-card p-6 text-center">
      <HardDrive className="h-8 w-8 text-muted-foreground" />
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {message.toLowerCase().includes("connection") && (
        <Button asChild variant="outline" size="sm"><Link href="/settings/drive">Reconnect Google Drive</Link></Button>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={reloading}><RotateCw className="mr-1.5 h-4 w-4" />Try again</Button>}
        <Button type="button" variant="outline" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
        <Button asChild size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in browser viewer</a></Button>
      </div>
    </div>
  );
}

function friendlyPdfError(error: unknown, isConnectionError: boolean): string {
  const errorValue = error as { message?: string; reason?: { message?: string } } | null;
  const message = `${errorValue?.message || ""} ${errorValue?.reason?.message || ""}`.trim() || String(error || "");
  if (isConnectionError || /401|403|409|unauthorized|connection|reconnect|refresh token|drive account/i.test(message)) {
    return "Your Google Drive connection needs attention.";
  }
  if (/password/i.test(message)) return "This PDF is password-protected. Open it in Drive to unlock or download it.";
  if (/404|file (was )?removed|not found/i.test(message)) return "This file is no longer available in Google Drive.";
  if (/corrupt|invalid pdf|wrong format/i.test(message)) return "This PDF appears to be damaged or uses an unsupported format.";
  return "The PDF reader could not start. Open the file in your browser or download it instead.";
}