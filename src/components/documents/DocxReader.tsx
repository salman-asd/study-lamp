"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, FileText, Minus, Plus, Printer, Type, ZoomIn } from "lucide-react";
import { MAX_DOCX_PREVIEW_BYTES, readResponseWithLimit } from "@/lib/documentViewerUtils";

export function DocxReader({
  title,
  sourceUrl,
  onDownload,
  onPlainText,
}: {
  title: string;
  sourceUrl: string | null;
  onDownload: () => void;
  onPlainText: () => Promise<string>;
}) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const documentBytes = React.useRef<ArrayBuffer | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [zoom, setZoom] = React.useState(100);
  const [fitWidth, setFitWidth] = React.useState(true);
  const [plainText, setPlainText] = React.useState<string | null>(null);
  const [loadingText, setLoadingText] = React.useState(false);
  const layoutSettings = React.useRef({ fitWidth, zoom });
  layoutSettings.current = { fitWidth, zoom };

  const renderDocument = React.useCallback(async (bytes: ArrayBuffer, fit: boolean, zoomPct: number) => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    frameDocument.open();
    frameDocument.write("<!doctype html><html><head><meta charset=\"utf-8\"></head><body><main id=\"docx-reader-root\"></main></body></html>");
    frameDocument.close();

    const stylesheet = frameDocument.createElement("style");
    stylesheet.textContent = `
      html, body { margin: 0; min-height: 100%; background: #f1f3f5; color: #1c2024; }
      body { overflow: auto; zoom: ${zoomPct}%; }
      #docx-reader-root { min-height: 100vh; }
      .docx-wrapper { min-height: 100vh; padding: 20px 12px; background: #f1f3f5 !important; }
      .docx { margin: 0 auto 16px !important; box-shadow: 0 1px 6px rgba(0,0,0,.16); }
      ${fit ? ".docx { max-width: calc(100vw - 32px) !important; }" : ""}
      @media print { .docx-wrapper { padding: 0; background: white !important; } .docx { box-shadow: none; } }
    `;
    frameDocument.head.appendChild(stylesheet);

    const { renderAsync } = await import("docx-preview");
    await renderAsync(bytes, frameDocument.getElementById("docx-reader-root")!, frameDocument.head, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: fit,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      useBase64URL: true,
      renderAltChunks: false,
      renderChanges: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    });
  }, []);

  React.useEffect(() => {
    let active = true;
    documentBytes.current = null;
    setPlainText(null);
    setError(null);
    setLoading(true);
    if (!sourceUrl) return () => { active = false; };

    void (async () => {
      try {
        const response = await fetch(sourceUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error(response.status === 404 ? "This file is no longer available in Google Drive." : `Couldn't download this Word document (${response.status}).`);
        const bytes = await readResponseWithLimit(response, MAX_DOCX_PREVIEW_BYTES, "This Word document");
        if (!active) return;
        documentBytes.current = bytes;
        await renderDocument(bytes, layoutSettings.current.fitWidth, layoutSettings.current.zoom);
        if (active) setLoading(false);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Couldn't render this Word document.");
        setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [sourceUrl, renderDocument]);

  async function updateLayout(nextFit: boolean, nextZoom: number) {
    setFitWidth(nextFit);
    setZoom(nextZoom);
    if (!documentBytes.current) return;
    setLoading(true);
    try {
      await renderDocument(documentBytes.current, nextFit, nextZoom);
      setLoading(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't update the Word preview.");
      setLoading(false);
    }
  }

  async function showPlainText() {
    setLoadingText(true);
    try {
      setPlainText(await onPlainText());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't load the plain text view.");
    } finally {
      setLoadingText(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card" aria-label={`${title} Word document viewer`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 p-2">
        <Button type="button" variant={fitWidth ? "secondary" : "ghost"} size="sm" className="gap-1.5" aria-pressed={fitWidth} onClick={() => void updateLayout(!fitWidth, zoom)}>
          <ZoomIn className="h-4 w-4" />{fitWidth ? "Fit width" : "Page width"}
        </Button>
        <Button type="button" variant="ghost" size="icon" title="Zoom out" aria-label="Zoom out" disabled={zoom <= 60} onClick={() => void updateLayout(fitWidth, Math.max(60, zoom - 10))}><Minus className="h-4 w-4" /></Button>
        <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{zoom}%</span>
        <Button type="button" variant="ghost" size="icon" title="Zoom in" aria-label="Zoom in" disabled={zoom >= 160} onClick={() => void updateLayout(fitWidth, Math.min(160, zoom + 10))}><Plus className="h-4 w-4" /></Button>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => void showPlainText()} loading={loadingText} loadingText="Loading…"><Type className="h-4 w-4" />Plain text</Button>
        <Button type="button" variant="ghost" size="icon" title="Print" aria-label="Print document" onClick={() => iframeRef.current?.contentWindow?.print()}><Printer className="h-4 w-4" /></Button>
        <Button type="button" variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={onDownload}><Download className="h-4 w-4" />Download</Button>
      </div>

      {plainText !== null ? (
        <div className="h-[68vh] overflow-auto bg-background p-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6">{plainText}</pre>
        </div>
      ) : error ? (
        <div className="flex h-[68vh] flex-col items-center justify-center gap-3 p-6 text-center">
          <FileText className="h-8 w-8 text-muted-foreground" />
          <p className="max-w-lg text-sm text-muted-foreground">{error}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void showPlainText()} loading={loadingText} loadingText="Loading…"><Type className="mr-1.5 h-4 w-4" />Plain text</Button>
            <Button type="button" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
          </div>
        </div>
      ) : (
        <div className="relative h-[68vh] min-h-[28rem]">
          {loading && <div className="absolute inset-0 z-10 space-y-3 bg-background p-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-full w-full" /></div>}
          <iframe
            ref={iframeRef}
            title={`${title} Word document`}
            sandbox="allow-same-origin"
            className="h-full w-full border-0"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </section>
  );
}
