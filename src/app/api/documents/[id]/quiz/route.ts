import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { generateVideoQuiz, AiServiceError, type AiErrorCode } from "@/lib/ai/aiService";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { buildVideoSourceHash, hashDocumentText } from "@/lib/quizSource";
import { getDocumentQuiz, saveDocumentQuiz } from "@/lib/server/quiz";
import { getPersonalDocument, extractPersonalDocumentText } from "@/lib/server/documentContent";
import { ScannedPdfError } from "@/lib/server/documentText";

interface RouteParams {
  params: { id: string };
}

const STATUS_BY_CODE: Record<AiErrorCode, number> = {
  auth: 400, rate_limit: 429, invalid_request: 502, blocked: 422,
  timeout: 504, network: 502, server_error: 502, unsupported_provider: 400, unknown: 500,
};

// Mirrors /api/ai/quiz/generate/route.ts: same cache-by-sourceHash shape
// (see quizSource.ts and src/lib/server/quiz.ts's document-specific
// get/saveDocumentQuiz), same generateVideoQuiz() call — a document's
// extracted text takes the transcript's place.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await getPersonalDocument(uid, params.id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — summary is optional, used only for the cache key
  }
  const summary = typeof body.summary === "string" ? body.summary : null;
  try {
    const text = await extractPersonalDocumentText(uid, doc);
    const sourceHash = buildVideoSourceHash(doc.title, null, summary, hashDocumentText(text));
    const cached = await getDocumentQuiz(uid, doc.id).catch(() => null);
    if (cached && cached.sourceHash === sourceHash) {
      return NextResponse.json({ questions: cached.questions }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const questions = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoQuiz({ provider, apiKey, model }, { title: doc.title, description: null, transcript: text, summary });
    });

    try {
      await saveDocumentQuiz(uid, doc.id, questions, sourceHash);
    } catch (cacheError) {
      console.error("Generated document quiz could not be cached", cacheError);
    }

    return NextResponse.json({ questions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof ScannedPdfError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (err instanceof AiServiceError) {
      const status = STATUS_BY_CODE[err.code];
      return NextResponse.json({ error: status >= 500 ? "Something went wrong generating a quiz." : err.message }, { status });
    }
    console.error("Unexpected error generating document quiz", err);
    return NextResponse.json({ error: "Something went wrong generating a quiz." }, { status: 500 });
  }
}
