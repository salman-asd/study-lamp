import type { VideoWithState } from "@/types";

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

/**
 * Decides whether load() should publish a cached snapshot into React state.
 * Publishing creates a new snapshot object, which re-renders every consumer, so
 * it is skipped when the current snapshot already belongs to this user and is
 * not in a loading state.
 */
export function shouldApplyCachedSnapshot(input: {
  currentUid: string | undefined;
  currentLoading: boolean;
  targetUid: string;
}): boolean {
  return input.currentUid !== input.targetUid || input.currentLoading;
}

export function videoKey(video: Pick<VideoWithState, "source" | "playlistId" | "id">): string {
  return `${video.source || "shared"}:${video.playlistId}:${video.id}`;
}