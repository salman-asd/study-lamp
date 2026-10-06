/**
 * Pure helpers for removing orphaned driveThumbs docs. Kept free of Firebase imports so they are unit-testable.
 *
 * A thumbnail doc id is `${connectionId}_${fileId}` (see driveThumbnailDocId). The connection id is
 * [A-Za-z0-9]{10,40} (no underscore), so the FIRST underscore separates the two parts.
 */
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

export interface ThumbnailIdParts {
  connectionId: string;
  fileId: string;
}

export function parseThumbnailDocId(docId: string): ThumbnailIdParts | null {
  const index = docId.indexOf("_");
  if (index < 0) return null;
  const connectionId = docId.slice(0, index);
  const fileId = docId.slice(index + 1);
  if (!CONNECTION_ID_PATTERN.test(connectionId) || !FILE_ID_PATTERN.test(fileId)) return null;
  return { connectionId, fileId };
}

/**
 * Returns the thumbnail doc ids no record references. `referencedKeys` holds `${connectionId}:${fileId}`
 * keys (the ownedKey format). Ids that do not parse are never returned: when unsure, keep the doc.
 */
export function findUnreferencedThumbnailIds(thumbnailDocIds: readonly string[], referencedKeys: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const docId of thumbnailDocIds) {
    const parts = parseThumbnailDocId(docId);
    if (!parts) continue;
    if (!referencedKeys.has(`${parts.connectionId}:${parts.fileId}`)) result.push(docId);
  }
  return result;
}
