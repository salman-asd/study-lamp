import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { generateVideoQuiz, AiServiceError, type AiErrorCode } from "@/lib/ai/aiService";
import { resolveTranscript } from "@/lib/ai/universalTranscript";
import { getAiPreferences } from "@/lib/server/aiPreferences";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { buildVideoSourceHash } from "@/lib/quizSource";
import {
  getPersonalVideoQuiz,
  getSharedVideoQuiz,
  savePersonalVideoQuiz,
  saveSharedVideoQuiz,
} from "@/lib/server/quiz";

const STATUS_BY_CODE: Record<AiErrorCode, number> = {
  auth: 400,
  rate_limit: 429,
  invalid_request: 502,
  blocked: 422,
  timeout: 504,
  network: 502,
  server_error: 502,
  unsupported_provider: 400,
  unknown: 500,
};

const TRANSCRIPT_MAX_LENGTH = 50000;

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const videoId = typeof b.videoId === "string" ? b.videoId.trim() : undefined;
  const playlistId = typeof b.playlistId === "string" ? b.playlistId.trim() : undefined;
  const ownerId = typeof b.ownerId === "string" ? b.ownerId.trim() : undefined;
  const title = typeof b.title === "string" ? b.title : undefined;
  const description = typeof b.description === "string" ? b.description : null;
  const summary = typeof b.summary === "string" ? b.summary : null;
  const youtubeVideoId = typeof b.youtubeVideoId === "string" ? b.youtubeVideoId.trim() : "";
  // Phase 4 (roadmap v3): a non-YouTube video's manually pasted/uploaded
  // transcript (users/{uid}/transcripts/{videoId} — see
  // src/lib/firestore/transcripts.ts), sent by the client the same way
  // `summary` already is.
  const manualTranscript = typeof b.manualTranscript === "string" ? b.manualTranscript : "";
  if (manualTranscript.length > TRANSCRIPT_MAX_LENGTH) {
    return NextResponse.json({ error: "manualTranscript is too long." }, { status: 400 });
  }

  if (!summary?.trim() && !youtubeVideoId && !manualTranscript.trim()) {
    return NextResponse.json({ error: "Add a summary, a transcript, or use a YouTube video with available captions before generating a quiz." }, { status: 422 });
  }
  if (ownerId && ownerId !== uid) {
    return NextResponse.json({ error: "You can only generate quizzes for your own personal videos." }, { status: 403 });
  }
  if (!ownerId && (!playlistId || !videoId)) {
    return NextResponse.json({ error: "A playlistId and videoId are required for a shared video quiz." }, { status: 400 });
  }
  if (ownerId && (!playlistId || !videoId)) {
    return NextResponse.json({ error: "A playlistId and videoId are required for a personal video quiz." }, { status: 400 });
  }

  // Phase 5 (roadmap v3) bug fix: this used to skip fetching a transcript
  // whenever a summary existed, even when a transcript was available —
  // meaning quizzes silently ignored transcript detail the moment a
  // summary was saved. Resolve the transcript FIRST and unconditionally
  // (any platform, via resolveTranscript — not just YouTube), and only
  // fall back to the saved summary when no transcript exists at all.
  // buildQuizPrompt's own instructions also prefer transcript > summary,
  // so passing both through is safe either way.
  let transcript: string | null;
  try {
    transcript = await resolveTranscript({ youtubeVideoId, manualTranscript });
  } catch (error) {
    console.error("Unexpected error resolving a transcript for quiz generation", error);
    return NextResponse.json({ error: "Unable to retrieve a transcript for this video." }, { status: 502 });
  }

  if (!transcript && !summary?.trim()) {
    const preferences = await getAiPreferences(uid).catch(() => ({ speechToTextEnabled: false }));
    return NextResponse.json(
      {
        error: preferences.speechToTextEnabled
          ? "No transcript is available. Speech-to-text fallback is enabled, but no transcription service is configured yet."
          : "No transcript or captions are available. Paste or upload a transcript for this video, or write a summary, before generating a quiz.",
      },
      { status: 422 }
    );
  }

  // Source hash now includes the transcript (Phase 5) so a changed
  // transcript — a better manual paste, newly-available captions —
  // correctly invalidates a cached quiz instead of serving a stale one.
  const sourceHash = buildVideoSourceHash(title || "", description, summary, transcript);

  let cachedQuiz;
  if (ownerId && playlistId && videoId) {
    cachedQuiz = await getPersonalVideoQuiz(ownerId, playlistId, videoId).catch(() => null);
  } else if (playlistId && videoId) {
    cachedQuiz = await getSharedVideoQuiz(playlistId, videoId).catch(() => null);
  }

  if (cachedQuiz && cachedQuiz.sourceHash === sourceHash) {
    return NextResponse.json({ questions: cachedQuiz.questions }, { headers: { "Cache-Control": "private, no-store" } });
  }

  try {
    const questions = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoQuiz(
        { provider, apiKey, model },
        { title, description, transcript: transcript || undefined, summary }
      );
    });

    // The cache saves provider cost on later requests, but it must never
    // prevent a learner from receiving a quiz that was generated
    // successfully. In particular, a newly deployed Firestore rule/index
    // or a transient database failure should degrade to an uncached quiz,
    // not a misleading 500 response.
    try {
      if (ownerId && playlistId && videoId) {
        await savePersonalVideoQuiz(ownerId, playlistId, videoId, questions, sourceHash);
      } else if (playlistId && videoId) {
        await saveSharedVideoQuiz(playlistId, videoId, questions, sourceHash);
      }
    } catch (cacheError) {
      console.error("Generated quiz could not be cached", cacheError);
    }

    return NextResponse.json({ questions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof AiServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error("Unexpected error generating AI quiz", err);
    return NextResponse.json({ error: "Something went wrong generating a quiz." }, { status: 500 });
  }
}

