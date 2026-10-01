import { AiServiceError } from "./errors";

/**
 * Phase 4 (roadmap v3) — automatic speech-to-text fallback, LAST resort
 * after (a) official captions and (b) a manual transcript
 * (src/lib/ai/universalTranscript.ts) both come up empty.
 *
 * Deliberately not implemented yet. The roadmap calls this out explicitly:
 * "Ship the manual-transcript path first; treat automatic STT as a
 * follow-up once you've seen how often users actually hit 'no transcript.'"
 * This file exists so the rest of the system (the speechToTextEnabled flag
 * in src/lib/server/aiPreferences.ts, the error copy in the summary/quiz
 * routes) has a real function to call once it's built, instead of that
 * wiring pointing at nothing.
 *
 * When this gets implemented, the shape should be:
 *   1. Extract audio-only (ffmpeg, discard the video stream) from the
 *      video's URL/stream.
 *   2. Send it to a speech-to-text-capable provider through the SAME
 *      withAiConnection/quota pattern the rest of the AI system uses
 *      (src/lib/server/resolveAiConnection.ts) — no separate one-off
 *      integration, no new provider-selection UI.
 *   3. Return the resulting text so it can be cached as a manual
 *      transcript (saveTranscript) — treat an STT result exactly like a
 *      user-provided one from then on, including cache invalidation via
 *      buildVideoSourceHash.
 */
export async function transcribeAudio(_videoUrl: string): Promise<string> {
  throw new AiServiceError(
    "unsupported_provider",
    "Automatic speech-to-text isn't available yet. Paste or upload a transcript instead."
  );
}
