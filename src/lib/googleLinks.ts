const FILE_ID = /^[A-Za-z0-9_-]{10,128}$/;

/** "Open in Google" URL for a native Google Doc/Sheet, or null when the type or id is not valid. */
export function googleOpenUrl(mimeType: string | undefined, fileId: string): string | null {
  if (!FILE_ID.test(fileId)) return null;
  if (mimeType === "application/vnd.google-apps.document") return `https://docs.google.com/document/d/${fileId}/edit`;
  if (mimeType === "application/vnd.google-apps.spreadsheet") return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  return null;
}

export function googleNativeLabel(mimeType: string | undefined): "Google Doc" | "Google Sheet" | null {
  if (mimeType === "application/vnd.google-apps.document") return "Google Doc";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "Google Sheet";
  return null;
}

/** Formats an ISO modifiedTime for display; null when missing or invalid. */
export function formatGoogleModified(modifiedTime: string | null | undefined): string | null {
  if (!modifiedTime) return null;
  const date = new Date(modifiedTime);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const SIZE_PLACEHOLDER = "—";
