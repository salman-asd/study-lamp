"use client";

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, FileSpreadsheet, Search, Table2, Copy } from "lucide-react";
import { toast } from "sonner";
import { MAX_XLSX_PREVIEW_BYTES, parseSpreadsheet, readResponseWithLimit, type SpreadsheetSheet } from "@/lib/documentViewerUtils";

const ROW_HEIGHT = 38;
const COLUMN_WIDTH = 180;

export function XlsxReader({
  title,
  sourceUrl,
  onDownload,
}: {
  title: string;
  sourceUrl: string | null;
  onDownload: () => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [sheets, setSheets] = React.useState<SpreadsheetSheet[]>([]);
  const [activeSheetIndex, setActiveSheetIndex] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [copying, setCopying] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setSheets([]);
    setActiveSheetIndex(0);
    setQuery("");
    if (!sourceUrl) return () => { active = false; };

    void (async () => {
      try {
        const response = await fetch(sourceUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error(response.status === 404 ? "This file is no longer available in Google Drive." : `Couldn't download this Excel workbook (${response.status}).`);
        const bytes = await readResponseWithLimit(response, MAX_XLSX_PREVIEW_BYTES, "This Excel workbook");
        const parsed = parseSpreadsheet(bytes);
        if (!active) return;
        setSheets(parsed);
        setLoading(false);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Couldn't read this Excel workbook.");
        setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [sourceUrl]);

  const activeSheet = sheets[activeSheetIndex];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows = React.useMemo(() => {
    if (!activeSheet) return [];
    if (!normalizedQuery) return activeSheet.rows;
    return activeSheet.rows.filter((row) => row.some((cell) => cell.toLocaleLowerCase().includes(normalizedQuery)));
  }, [activeSheet, normalizedQuery]);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const tableWidth = Math.max(activeSheet?.columns.length ?? 1, 1) * COLUMN_WIDTH;

  async function copyTsv() {
    if (!activeSheet) return;
    setCopying(true);
    try {
      const content = [activeSheet.columns, ...visibleRows].map((row) => row.join("\t")).join("\n");
      await navigator.clipboard.writeText(content);
      toast.success("Copied sheet as TSV.");
    } catch {
      toast.error("Clipboard access is unavailable in this browser.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card" aria-label={`${title} spreadsheet viewer`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 p-2">
        <label className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this sheet" aria-label="Search this sheet" className="pl-8" />
        </label>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void copyTsv()} disabled={!activeSheet || copying}>
          <Copy className="h-4 w-4" />Copy TSV
        </Button>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onDownload}><Download className="h-4 w-4" />Download</Button>
      </div>

      {sheets.length > 1 && (
        <div role="tablist" aria-label="Workbook sheets" className="flex max-w-full gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === activeSheetIndex}
              className={`shrink-0 rounded-sm px-3 py-1.5 text-sm ${index === activeSheetIndex ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
              onClick={() => { setActiveSheetIndex(index); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
            >{sheet.name}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2 p-4"><Skeleton className="h-9 w-full" /><Skeleton className="h-[58vh] w-full" /></div>
      ) : error ? (
        <div className="flex h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
          <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          <p className="max-w-md text-sm text-muted-foreground">{error}</p>
          <Button type="button" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>
        </div>
      ) : activeSheet ? (
        <div ref={scrollRef} className="h-[68vh] min-h-[26rem] overflow-auto" role="grid" aria-label={`${activeSheet.name} sheet`}>
          <div className="sticky top-0 z-10 grid border-b border-border bg-muted text-xs font-semibold" role="row" style={{ gridTemplateColumns: `repeat(${activeSheet.columns.length}, minmax(${COLUMN_WIDTH}px, 1fr))`, minWidth: tableWidth }}>
            {activeSheet.columns.map((column, index) => <div key={`${column}-${index}`} className="truncate border-r border-border px-3 py-2.5" role="columnheader" title={column}>{column}</div>)}
          </div>
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), minWidth: tableWidth, position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = visibleRows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  role="row"
                  className="absolute left-0 top-0 grid w-full border-b border-border/70 text-sm hover:bg-muted/40"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns: `repeat(${activeSheet.columns.length}, minmax(${COLUMN_WIDTH}px, 1fr))` }}
                >
                  {row.map((cell, cellIndex) => (
                    <div key={cellIndex} role="gridcell" className="overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/60 px-3 py-2" title={cell}>{cell}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Table2 className="h-6 w-6" />This workbook has no readable sheets.</div>
      )}
      {activeSheet?.truncated && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Preview limited to the first 20,000 rows across this workbook.</p>}
      {activeSheet && !loading && !error && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{visibleRows.length.toLocaleString()} rows · values shown as text</p>}
    </section>
  );
}
