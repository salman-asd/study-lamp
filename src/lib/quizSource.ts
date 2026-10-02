/**
 * Stable cache key for generated quizzes. This deliberately has no
 * Firebase dependency so both client code and server routes can use it.
 *
 * Phase 5 (roadmap v3): `transcript` was missing here even though the quiz
 * route can now generate from a transcript — a video whose transcript
 * changed (a better manual transcript pasted in, a newly-available
 * caption track) would keep serving a stale cached quiz forever since the
 * hash never changed. It's an optional trailing param so the one other
 * caller without a transcript concept (src/app/api/documents/[id]/quiz/route.ts)
 * doesn't need to change.
 */
export function buildVideoSourceHash(
  title: string,
  description?: string | null,
  summary?: string | null,
  transcript?: string | null,
): string {
  const text = `${(title || "").trim()}\n${(description || "").trim()}\n${(summary || "").trim()}\n${(transcript || "").trim()}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function hashDocumentText(text: string): string {
  return buildVideoSourceHash("", null, null, text);
}
