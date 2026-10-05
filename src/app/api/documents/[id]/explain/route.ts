import { NextResponse } from "next/server";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { getPersonalDocument } from "@/lib/server/documentContent";
import { generateDocumentPageExplanation } from "@/lib/ai/aiService";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

interface RouteParams {
  params: { id: string };
}

const MAX_PAGE_TEXT_CHARS = 8_000;
// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute<RouteParams["params"]>(async ({ uid, req, params }) => {
  const document = await getPersonalDocument(uid, params.id);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (document.fileType !== "pdf") return NextResponse.json({ error: "Page explanations are available for PDFs only." }, { status: 422 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const values = body as Record<string, unknown>;
  const language = await resolveAiLanguage(uid, values.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  if (!Number.isSafeInteger(values.pageNumber) || Number(values.pageNumber) < 1) {
    return NextResponse.json({ error: "pageNumber must be a positive integer." }, { status: 400 });
  }
  if (typeof values.pageText !== "string" || !values.pageText.trim()) {
    return NextResponse.json({ error: "Readable text from the current page is required." }, { status: 400 });
  }
  if (values.pageText.length > MAX_PAGE_TEXT_CHARS) {
    return NextResponse.json({ error: "Page text exceeds the 8,000-character limit." }, { status: 413 });
  }

  try {
    const explanation = await withAiConnection(uid, (apiKey, provider, model) => (
      generateDocumentPageExplanation({ apiKey, provider, model, language }, {
        title: document.title,
        pageNumber: Number(values.pageNumber),
        pageText: values.pageText as string,
      })
    ));
    return NextResponse.json({ explanation }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return aiErrorResponse(error, { fallbackMessage: "Couldn't explain this page.", logLabel: "Unexpected error explaining a document page" });
  }
});