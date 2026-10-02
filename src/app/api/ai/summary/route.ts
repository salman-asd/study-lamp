import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { generateVideoSummary, AiServiceError, type AiErrorCode } from "@/lib/ai/aiService";
import { resolveTranscript } from "@/lib/ai/universalTranscript";
import { getAiPreferences, resolveAiLanguage } from "@/lib/server/aiPreferences";
import { withAiConnection } from "@/lib/server/resolveAiConnection";

const TRANSCRIPT_MAX_LENGTH = 50000;

const TITLE_MAX_LENGTH = 300;
const DESCRIPTION_MAX_LENGTH = 5000;

// HTTP status per AiServiceError code. Kept local to this route rather than
// in the AI service itself — the service is meant to be usable outside an
// HTTP context too, so it shouldn't know about status codes.
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

// POST /api/ai/summary — generate a transcript-backed summary draft.
// Body: { title, description?, youtubeVideoId?, manualTranscript? }.
// Phase 4 (roadmap v3): youtubeVideoId is no longer the only way in — a
// non-YouTube video can send its saved manualTranscript (from
// users/{uid}/transcripts/{videoId} — see src/lib/firestore/transcripts.ts)
// instead. resolveTranscript() tries YouTube captions first either way, so
// passing a youtubeVideoId alongside a manualTranscript is fine and just
// prefers the official captions.
// Returns { summary: string }. Does NOT touch Firestore's summary
// collection — the caller is responsible for putting the returned text into
// the existing summary textarea/state and saving it via the existing
// save/autosave path (see src/app/video/[videoId]/page.tsx).
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
  if (b.title !== undefined && typeof b.title !== "string") {
    return NextResponse.json({ error: "title must be a string when provided." }, { status: 400 });
  }
  if (typeof b.title === "string" && b.title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json({ error: "title is too long." }, { status: 400 });
  }
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") {
      return NextResponse.json({ error: "description must be a string." }, { status: 400 });
    }
    if (b.description.length > DESCRIPTION_MAX_LENGTH) {
      return NextResponse.json({ error: "description is too long." }, { status: 400 });
    }
  }
  const youtubeVideoId = typeof b.youtubeVideoId === "string" ? b.youtubeVideoId.trim() : "";
  const manualTranscript = typeof b.manualTranscript === "string" ? b.manualTranscript : "";
  const language = await resolveAiLanguage(uid, b.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  if (manualTranscript.length > TRANSCRIPT_MAX_LENGTH) {
    return NextResponse.json({ error: "manualTranscript is too long." }, { status: 400 });
  }
  if (!youtubeVideoId && !manualTranscript.trim()) {
    return NextResponse.json(
      { error: "A YouTube video, or a pasted/uploaded transcript, is required for transcript-based summaries." },
      { status: 400 }
    );
  }

  const transcript = await resolveTranscript({ youtubeVideoId, manualTranscript });
  if (!transcript) {
    const preferences = await getAiPreferences(uid).catch(() => ({ speechToTextEnabled: false }));
    return NextResponse.json(
      {
        error: preferences.speechToTextEnabled
          ? "No transcript is available. Speech-to-text fallback is enabled, but no transcription service is configured yet."
          : "No transcript or captions are available. Paste or upload a transcript for this video, or enable speech-to-text fallback in AI Settings once a transcription service is configured.",
      },
      { status: 422 }
    );
  }

  try {
    const title = typeof b.title === "string" ? b.title : undefined;
    const description = b.description === null ? null : typeof b.description === "string" ? b.description : undefined;

    const summary = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoSummary(
        { provider, apiKey, model, language },
        { title, description, transcript }
      );
    });

    return NextResponse.json({ summary }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof AiServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    console.error("Unexpected error generating AI summary", err);
    return NextResponse.json({ error: "Something went wrong generating a summary." }, { status: 500 });
  }
}
