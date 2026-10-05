export interface SheetRowSet {
  title: string;
  rows: Array<Array<string | number>>;
}

export interface SpreadsheetEndInfo {
  revisionId: string;
  spreadsheetId: string;
}

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

export async function getSpreadsheetEnd(accessToken: string, spreadsheetId: string): Promise<SpreadsheetEndInfo> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,revisionId`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to read this Google Sheet (${res.status}).`);
  }
  const data = await res.json();
  return {
    spreadsheetId: String(data?.spreadsheetId ?? spreadsheetId),
    revisionId: String(data?.revisionId ?? ""),
  };
}

export async function listSheetTitles(accessToken: string, spreadsheetId: string): Promise<string[]> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title))`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to read this Google Sheet (${res.status}).`);
  }
  const data = await res.json();
  return Array.isArray(data?.sheets) ? data.sheets.map((sheet: any) => String(sheet?.properties?.title || "")).filter(Boolean) : [];
}

export async function createSheet(accessToken: string, spreadsheetId: string, title: string): Promise<void> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to create the Google Sheet tab (${res.status}).`);
  }
}

export async function appendRows(accessToken: string, spreadsheetId: string, tab: string, rows: Array<Array<string | number>>): Promise<void> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      values: rows,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to append rows to the Google Sheet (${res.status}).`);
  }
}

export async function appendToSpreadsheet(accessToken: string, spreadsheetId: string, input: { revisionId: string; text: string; heading: string }): Promise<void> {
  const tab = "Study Lamp log";
  const titles = await listSheetTitles(accessToken, spreadsheetId);
  const exists = titles.includes(tab);
  if (!exists) {
    await createSheet(accessToken, spreadsheetId, tab);
  }

  const row = [
    new Date().toISOString().slice(0, 10),
    input.heading || "Study Lamp",
    input.text.slice(0, 2400),
    input.revisionId || "",
  ];
  await appendRows(accessToken, spreadsheetId, tab, [row]);
}
