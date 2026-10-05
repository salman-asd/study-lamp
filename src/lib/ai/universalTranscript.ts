import { getYouTubeTranscript, TranscriptUnavailableError } from "./transcript";
import { logServerError } from "@/lib/server/logError";

/**
 * Phase 4 (roadmap v3) — one transcript pipeline for every platform.
 *
 * Priority order, same as the roadmap: official captions where they exist
 * (YouTube today) → a manually pasted/uploaded transcript the learner
 * provided (src/lib/firestore/transcripts.ts) → nothing found. Automatic
 * speech-to-text (src/lib/ai/audioTranscribe.ts) is a deliberate follow-up,
 * not step (c) here — see that file's header comment.
 *
 * Deliberately has no Firestore/React dependency, same reasoning as
 * buildVideoSourceHash in src/lib/quizSource.ts: callers (API routes) fetch
 * whatever they already have (youtubeVideoId from the request body, the
 * saved manual transcript from users/{uid}/transcripts/{videoId}) and hand
 * it to this function rather than this function reading Firestore itself,
 * which keeps it usable from both server routes and, eventually, tests.
 */
export interface TranscriptSource {
  /** Present only for youtube/youtube-shorts videos. */
  youtubeVideoId?: string | null;
  /** The learner's own pasted/uploaded transcript, if one has been saved. */
  manualTranscript?: string | null;
}

export async function resolveTranscript(video: TranscriptSource): Promise<string | null> {
  const youtubeId = (video.youtubeVideoId || "").trim();
  if (youtubeId) {
    try {
      const transcript = await getYouTubeTranscript(youtubeId);
      if (transcript.trim()) return transcript;
    } catch (error) {
      // No captions available (the expected/common case for a lot of
      // videos) or a transient fetch failure — either way, fall through to
      // the manual transcript rather than failing the whole request. A
      // genuinely unexpected error is swallowed here too: this function's
      // contract is "best available transcript, or null", never a throw.
      if (!(error instanceof TranscriptUnavailableError)) {
        logServerError("Unexpected error fetching YouTube transcript", error);
      }
    }
  }

  const manual = (video.manualTranscript || "").trim();
  if (manual) return manual;

  return null;
}
