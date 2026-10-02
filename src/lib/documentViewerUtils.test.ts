import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as XLSX from "xlsx";

import { MAX_XLSX_ROWS, parseSpreadsheet, readResponseWithLimit } from "./documentViewerUtils";

function makeWorkbookBuffer(rowCount: number): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const rows: unknown[][] = [["Name", "Value"]];
  for (let index = 1; index < rowCount; index += 1) rows.push([`Row ${index}`, index]);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "First");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Other"], ["Cell"]]), "Second");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("document viewer helpers", () => {
  it("preserves sheet names and exposes cell values as text without evaluating formulas", () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Input", "Cached result"], [2, null]]);
    sheet.B2 = { t: "n", f: "1+1", v: 2 };
    XLSX.utils.book_append_sheet(workbook, sheet, "Formulas");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Second sheet"]]), "Second");
    const parsed = parseSpreadsheet(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    assert.deepEqual(parsed.map((item) => item.name), ["Formulas", "Second"]);
    assert.deepEqual(parsed[0].rows, [["2", "2"]]);
  });

  it("caps spreadsheet rows across sheets at 20,000", () => {
    const parsed = parseSpreadsheet(makeWorkbookBuffer(MAX_XLSX_ROWS + 10));
    assert.equal(parsed.reduce((total, sheet) => total + sheet.rows.length, 0), MAX_XLSX_ROWS - 1);
    assert.equal(parsed[1].truncated, true);
  });

  it("rejects oversized response bodies before and during streaming", async () => {
    await assert.rejects(
      readResponseWithLimit(new Response(new Uint8Array(8), { headers: { "Content-Length": "8" } }), 4, "Workbook"),
      /Workbook is larger than the 0 MB preview limit/,
    );
    await assert.rejects(
      readResponseWithLimit(new Response(new Uint8Array(8)), 4, "Workbook"),
      /Workbook is larger than the 0 MB preview limit/,
    );
  });
});