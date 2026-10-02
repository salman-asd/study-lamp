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