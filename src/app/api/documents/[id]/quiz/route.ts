import { NextResponse } from "next/server";
import { generateVideoQuiz } from "@/lib/ai/aiService";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { logServerError } from "@/lib/server/logError";
import { buildSourceHash } from "@/lib/server/sourceHash";
import { getDocumentQuiz, saveDocumentQuiz } from "@/lib/server/quiz";
import { getPersonalDocument, extractPersonalDocumentText } from "@/lib/server/documentContent";
import { ScannedPdfError } from "@/lib/server/documentText";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

interface RouteParams {
  params: { id: string };
}

// Mirrors /api/ai/quiz/generate/route.ts: same cache-by-sourceHash shape
// (see quizSource.ts and src/lib/server/quiz.ts's document-specific
// get/saveDocumentQuiz), same generateVideoQuiz() call — a document's
// extracted text takes the transcript's place.
// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute<RouteParams["params"]>(async ({ uid, req, params }) => {
  const doc = await getPersonalDocument(uid, params.id);
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — summary is optional, used only for the cache key
  }
  const language = await resolveAiLanguage(uid, body.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  const summary = typeof body.summary === "string" ? body.summary : null;
  try {
    const text = await extractPersonalDocumentText(uid, doc);
    const sourceHash = buildSourceHash({ kind: "document-quiz", title: doc.title, summary, text, language });
    const cached = await getDocumentQuiz(uid, doc.id).catch(() => null);
    if (cached && cached.sourceHash === sourceHash) {
      return NextResponse.json({ questions: cached.questions }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const questions = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoQuiz({ provider, apiKey, model, language }, { title: doc.title, description: null, transcript: text, summary });
    });

    try {
      await saveDocumentQuiz(uid, doc.id, questions, sourceHash);
    } catch (cacheError) {
      logServerError("Generated document quiz could not be cached", cacheError);
    }

    return NextResponse.json({ questions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof ScannedPdfError) return NextResponse.json({ error: err.message }, { status: 422 });
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong generating a quiz.", logLabel: "Unexpected error generating document quiz", hideServerMessages: true });
  }
});
