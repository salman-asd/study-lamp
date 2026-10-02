/**
 * The persisted value of a Drive-backed item's `thumbnailUrl`.
 *
 * It is a *marker*, not a loadable URL: an <img> cannot send an Authorization
 * header, so clients resolve it to a short-lived HMAC-signed URL through
 * /api/drive/sign (see useSignedDriveThumbnail). Pure and dependency-free so
 * both server import code and client components can build/parse it.
 */
export const DRIVE_THUMBNAIL_MARKER_PREFIX = "/api/drive/thumbnail/";

export function driveThumbnailMarker(fileId: string, connectionId: string): string {
  return `${DRIVE_THUMBNAIL_MARKER_PREFIX}${encodeURIComponent(fileId)}?connectionId=${encodeURIComponent(connectionId)}`;
}

export function isDriveThumbnailMarker(value: string | null | undefined): value is string {
  return !!value && value.includes(DRIVE_THUMBNAIL_MARKER_PREFIX);
}

/** Extracts {fileId, connectionId} from a marker, or null if it is not one. */
export function parseDriveThumbnailMarker(
  value: string | null | undefined,
  base = "http://localhost",
): { fileId: string; connectionId: string } | null {
  if (!isDriveThumbnailMarker(value)) return null;
  try {
    const url = new URL(value, base);
    const fileId = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    const connectionId = url.searchParams.get("connectionId") || "";
    return fileId && connectionId ? { fileId, connectionId } : null;
  } catch {
    return null;
  }
}
