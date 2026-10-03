import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { generateVideoSummary } from "@/lib/ai/aiService";
import { AiServiceError, type AiErrorCode } from "@/lib/ai/errors";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { getPersonalDocument, extractPersonalDocumentText } from "@/lib/server/documentContent";
import { ScannedPdfError } from "@/lib/server/documentText";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";

interface RouteParams {
  params: { id: string };
}

const STATUS_BY_CODE: Record<AiErrorCode, number> = {
  auth: 400, rate_limit: 429, invalid_request: 502, blocked: 422,
  timeout: 504, network: 502, server_error: 502, unsupported_provider: 400, unknown: 500,
};

// Mirrors /api/ai/summary/route.ts exactly, with the document's extracted
// text standing in for a video transcript — generateVideoSummary only
// needs { title, description, transcript }, so this reuses it unchanged
// rather than a parallel document-specific implementation.
//
// Like the video route, this does NOT touch Firestore — it just returns the
// generated text. The Study Materials page saves it into the same
// users/{uid}/summaries collection a video summary uses (key "d_"+documentId
// instead of the video's id) via the existing client-side notes.ts helpers,
// exactly like the video page already does for its own summary.
// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const language = await resolveAiLanguage(uid, (body as Record<string, unknown>).language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  const doc = await getPersonalDocument(uid, params.id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  try {
    const text = await extractPersonalDocumentText(uid, doc);
    const summary = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoSummary({ provider, apiKey, model, language }, { title: doc.title, description: null, transcript: text });
    });
    return NextResponse.json({ summary }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof ScannedPdfError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (err instanceof AiServiceError) {
      const status = STATUS_BY_CODE[err.code];
      return NextResponse.json({ error: status >= 500 ? "Something went wrong generating a summary." : err.message }, { status });
    }
    console.error("Unexpected error generating document summary", err);
    return NextResponse.json({ error: "Something went wrong generating a summary." }, { status: 500 });
  }
}
