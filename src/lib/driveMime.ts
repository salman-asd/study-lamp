export type DrivePickerKind = "video" | "pdf" | "docx" | "pptx" | "xlsx";

export const DRIVE_PICKER_MIME_BY_KIND: Record<DrivePickerKind, string> = {
  video: "video/*",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function buildPickerMimeTypes(kinds: DrivePickerKind[]): string[] {
  return kinds.map((kind) => DRIVE_PICKER_MIME_BY_KIND[kind]).filter(Boolean);
}
