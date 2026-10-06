import { NextResponse } from "next/server";
import { previewSheetsAppend } from "@/lib/server/googleAppendApply";
import { realSheetsDeps } from "@/lib/server/googleAppendDeps";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PREVIEW: read-only. Lists the exact rows (unexported quiz attempts, max 200) and returns a signed plan token. */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const documentId = typeof parsed.body.documentId === "string" ? parsed.body.documentId : "";
  const result = await previewSheetsAppend(realSheetsDeps, { uid, documentId });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}, { scope: "googleSync", preset: "googleSync", tooManyMessage: "Too many spreadsheet preview requests. Please slow down." });
