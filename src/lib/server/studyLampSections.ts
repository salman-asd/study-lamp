/**
 * Helpers that hide the text Study Lamp itself appended to a Google Doc / Sheet, so the next AI
 * summary or quiz is not built from our own earlier output (Z2 item 6). Pure; no xlsx dependency.
 */

/** Name of the tab Study Lamp creates in a Google Sheet. */
export const STUDY_LAMP_SHEET_TAB = "Study Lamp log";

/** Heading pattern written by formatGoogleDocHeading: "Study Lamp — YYYY-MM-DD". */
const STUDY_LAMP_HEADING = /^Study Lamp\s*—\s*/i;

/** Drops everything from the first "Study Lamp — " line to the end of the text. */
export function stripStudyLampDocText(value: string): string {
  const lines = value.split(/\r?\n/);
  const index = lines.findIndex((line) => STUDY_LAMP_HEADING.test(line.trim()));
  if (index < 0) return value.trim();
  return lines.slice(0, index).join("\n").trim();
}

/** Drops the "Sheet: Study Lamp log" section from extracted workbook text. */
export function stripStudyLampSheetNames(value: string): string {
  return value
    .split(/\n\n/)
    .filter((section) => !section.startsWith(`Sheet: ${STUDY_LAMP_SHEET_TAB}`))
    .join("\n\n")
    .trim();
}
