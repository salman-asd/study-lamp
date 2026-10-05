import { NextResponse } from "next/server";
import { getPersonalDocument, extractPersonalDocumentText } from "@/lib/server/documentContent";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  const document = await getPersonalDocument(uid, params.id);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  try {
    const text = await extractPersonalDocumentText(uid, document);
    return NextResponse.json({ text }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't extract text from this document.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
});