import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getPersonalDocument, extractPersonalDocumentText } from "@/lib/server/documentContent";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const document = await getPersonalDocument(uid, params.id);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  try {
    const text = await extractPersonalDocumentText(uid, document);
    return NextResponse.json({ text }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Couldn't extract text from this document.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}