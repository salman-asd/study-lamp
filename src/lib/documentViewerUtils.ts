import * as XLSX from "xlsx";

export const MAX_DOCX_PREVIEW_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_ROWS = 20_000;

export interface SpreadsheetSheet {
  name: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export async function readResponseWithLimit(response: Response, maxBytes: number, label: string): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(`${label} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function parseSpreadsheet(buffer: ArrayBuffer): SpreadsheetSheet[] {
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellText: true,
    cellDates: false,
  });
  let remainingRows = MAX_XLSX_ROWS;

  return workbook.SheetNames.map((name) => {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      blankrows: false,
    });
    const cappedRows = matrix.slice(0, remainingRows);
    remainingRows -= cappedRows.length;
    const hasHeader = cappedRows.length > 0;
    const headerCells = hasHeader ? cappedRows[0] : [];
    const columnCount = Math.max(1, ...cappedRows.map((row) => row.length));
    const columns = Array.from({ length: columnCount }, (_, index) => {
      const value = headerCells[index];
      return value == null || String(value).trim() === "" ? `Column ${index + 1}` : String(value);
    });
    const rows = (hasHeader ? cappedRows.slice(1) : cappedRows).map((row) => (
      columns.map((_, index) => String(row[index] ?? ""))
    ));

    return {
      name,
      columns,
      rows,
      truncated: matrix.length > cappedRows.length,
    };
  });
}