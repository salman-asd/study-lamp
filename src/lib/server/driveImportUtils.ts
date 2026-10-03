export function dedupeDriveItems<T extends { driveFileId: string }>(
  items: T[],
  existingFileIds: Iterable<string>,
): T[] {
  const seen = new Set(existingFileIds);
  return items.filter((item) => {
    if (seen.has(item.driveFileId)) return false;
    seen.add(item.driveFileId);
    return true;
  });
}

export function assignDriveVideoOrders<T>(items: T[], startingOrder: number): Array<{ item: T; order: number }> {
  return items.map((item, index) => ({ item, order: startingOrder + index }));
}

// ── Multi-file import (POST /api/drive/import/files) ────────────────────────
export type ImportableDocumentType = "pdf" | "docx" | "xlsx";

/** PowerPoint is intentionally NOT importable (product decision), so .pptx is skipped. */
export function importableDocumentType(mimeType: string): ImportableDocumentType | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("wordprocessingml")) return "docx";
  if (mimeType.includes("spreadsheetml")) return "xlsx";
  return null;
}

export type DriveSkipReason = "folder" | "unsupported_type" | "inaccessible" | "not_a_document" | "not_a_video";

export interface PartitionedDriveFiles<T> {
  videos: T[];
  documents: Array<{ file: T; fileType: ImportableDocumentType }>;
  skipped: Array<{ fileId: string; reason: DriveSkipReason }>;
}

/** Splits fetched Drive metadata into videos, importable documents and skipped files, keeping selection order. */
export function partitionDriveFiles<T extends { id: string; mimeType: string }>(files: readonly T[]): PartitionedDriveFiles<T> {
  const result: PartitionedDriveFiles<T> = { videos: [], documents: [], skipped: [] };
  for (const file of files) {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      result.skipped.push({ fileId: file.id, reason: "folder" });
    } else if (file.mimeType.startsWith("video/")) {
      result.videos.push(file);
    } else {
      const fileType = importableDocumentType(file.mimeType);
      if (fileType) result.documents.push({ file, fileType });
      else result.skipped.push({ fileId: file.id, reason: "unsupported_type" });
    }
  }
  return result;
}

/** Removes repeated ids, keeping the first occurrence. */
export function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

// ── Atomic bulk writes ─────────────────────────────────────────────────────
export const FIRESTORE_BATCH_LIMIT = 400;

/**
 * Splits items into write-batch chunks that always leave `reservedOps` free in
 * every batch, so the playlist update can ride in the LAST batch together with
 * its videos (a failure can then never leave committed videos that are missing
 * from the playlist's sortOrder/counters).
 */
export function chunkForBatches<T>(items: readonly T[], maxOps: number = FIRESTORE_BATCH_LIMIT, reservedOps = 1): T[][] {
  const size = maxOps - reservedOps;
  if (!Number.isInteger(size) || size < 1) throw new Error("Batch size must leave room for at least one write.");
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) chunks.push(items.slice(offset, offset + size));
  return chunks;
}
