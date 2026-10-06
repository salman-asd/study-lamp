export type DrivePickerKind = "video" | "pdf" | "docx" | "pptx" | "xlsx" | "gdoc" | "gsheet";

export const DRIVE_PICKER_MIME_BY_KIND: Record<DrivePickerKind, string> = {
  video: "video/*",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  gdoc: "application/vnd.google-apps.document",
  gsheet: "application/vnd.google-apps.spreadsheet",
};

export function nativeExportMime(mimeType: string): string | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "application/vnd.google-apps.spreadsheet":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return null;
  }
}

export function isGoogleNativeMime(mimeType: string): boolean {
  return nativeExportMime(mimeType) !== null;
}

export function buildPickerMimeTypes(kinds: DrivePickerKind[]): string[] {
  return kinds.map((kind) => DRIVE_PICKER_MIME_BY_KIND[kind]).filter(Boolean);
}
