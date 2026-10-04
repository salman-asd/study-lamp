/** Toast text for a bulk import: "Imported 3 videos, 2 documents (1 skipped/duplicate)". */
export function summarizeBulkImport(result: {
  addedVideos: number;
  addedDocuments: number;
  skipped: readonly unknown[];
  duplicates: number;
}): string {
  const parts: string[] = [];
  if (result.addedVideos) parts.push(`${result.addedVideos} video${result.addedVideos === 1 ? "" : "s"}`);
  if (result.addedDocuments) parts.push(`${result.addedDocuments} document${result.addedDocuments === 1 ? "" : "s"}`);
  const ignored = result.skipped.length + result.duplicates;
  const ignoredText = ignored ? ` (${ignored} skipped/duplicate${ignored === 1 ? "" : "s"})` : "";
  if (parts.length === 0) return ignored ? `Nothing new to import (${ignored} skipped/duplicate${ignored === 1 ? "" : "s"}).` : "Nothing to import.";
  return `Imported ${parts.join(", ")}${ignoredText}`;
}
