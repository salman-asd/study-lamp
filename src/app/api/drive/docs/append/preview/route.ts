import { NextResponse } from "next/server";
import { previewDocsAppend } from "@/lib/server/googleAppendApply";
import { realDocsDeps } from "@/lib/server/googleAppendDeps";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PREVIEW: read-only. Builds the exact text on the server and returns a signed plan token. Writes nothing. */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const documentId = typeof parsed.body.documentId === "string" ? parsed.body.documentId : "";
  const content = typeof parsed.body.content === "string" ? parsed.body.content : "";
  const result = await previewDocsAppend(realDocsDeps, { uid, documentId, content });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}, { scope: "googleSync", preset: "googleSync", tooManyMessage: "Too many document preview requests. Please slow down." });
