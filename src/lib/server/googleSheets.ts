import { googleApiErrorFromResponse } from "@/lib/server/googleApiError";
import { STUDY_LAMP_SHEET_TAB } from "@/lib/server/studyLampSections";

export const SHEET_TAB = STUDY_LAMP_SHEET_TAB;

/**
 * What the preview and the apply compare. The Sheets API has no document revision id, so the
 * remote version is the state that actually changes what we write: does the tab exist, and does it
 * already have a header row.
 */
export type SheetTabState = "absent" | "present_with_header" | "present_empty";

export function assertAllowedSheetRequests(requests: unknown): void {
  if (!Array.isArray(requests)) throw new Error("Sheet requests must be an array.");
  for (const request of requests) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Each sheet request must be an object.");
    }
    const keys = Object.keys(request as Record<string, unknown>);
    const invalid = keys.filter((key) => key !== "addSheet");
    if (invalid.length > 0) {
      throw new Error(`Blocking unsupported Google Sheet request type: ${invalid[0]}`);
    }
  }
}

/** A1 notation needs single quotes around a tab name that contains spaces. */
export function quoteSheetTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export async function getSheetTabState(accessToken: string, spreadsheetId: string, tab = SHEET_TAB): Promise<SheetTabState> {
  const id = encodeURIComponent(spreadsheetId);
  const headers = { Authorization: `Bearer ${accessToken}` };

  const listRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets(properties(title))`, { headers });
  if (!listRes.ok) throw await googleApiErrorFromResponse(listRes);
  const list = await listRes.json();
  const titles: string[] = Array.isArray(list?.sheets)
    ? list.sheets.map((sheet: { properties?: { title?: unknown } }) => String(sheet?.properties?.title ?? ""))
    : [];
  if (!titles.includes(tab)) return "absent";

  const range = encodeURIComponent(`${quoteSheetTab(tab)}!A1`);
  const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`, { headers });
  if (!valuesRes.ok) throw await googleApiErrorFromResponse(valuesRes);
  const values = await valuesRes.json();
  return Array.isArray(values?.values) && values.values.length > 0 ? "present_with_header" : "present_empty";
}

export async function createSheet(accessToken: string, spreadsheetId: string, title: string): Promise<void> {
  const requests = [{ addSheet: { properties: { title } } }];
  assertAllowedSheetRequests(requests);

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw await googleApiErrorFromResponse(res);
}

/** values.append with RAW (no formula parsing) and INSERT_ROWS (never overwrites existing cells). */
export async function appendRows(
  accessToken: string,
  spreadsheetId: string,
  tab: string,
  rows: Array<Array<string | number>>,
): Promise<void> {
  const range = encodeURIComponent(`${quoteSheetTab(tab)}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) throw await googleApiErrorFromResponse(res);
}
