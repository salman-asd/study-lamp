export interface DriveRevision {
  md5Checksum?: string | null;
  modifiedTime?: string | null;
}

export function driveRevisionKey(revision: DriveRevision): string | null {
  if (revision.md5Checksum) return `md5:${revision.md5Checksum}`;
  if (revision.modifiedTime) return `modified:${revision.modifiedTime}`;
  return null;
}

export function isSameDriveRevision(cached: DriveRevision, current: DriveRevision): boolean {
  const cachedKey = driveRevisionKey(cached);
  return cachedKey !== null && cachedKey === driveRevisionKey(current);
}