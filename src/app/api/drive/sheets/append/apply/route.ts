import { NextResponse } from "next/server";
import { applySheetsAppend } from "@/lib/server/googleAppendApply";
import { realSheetsDeps } from "@/lib/server/googleAppendDeps";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** APPLY. Body is ONLY {planToken, accepted, documentId}; the rows are rebuilt on the server from stored attempts. */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const planToken = typeof parsed.body.planToken === "string" ? parsed.body.planToken : "";
  const documentId = typeof parsed.body.documentId === "string" ? parsed.body.documentId : "";
  const accepted = Array.isArray(parsed.body.accepted)
    ? parsed.body.accepted.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];

  const result = await applySheetsAppend(realSheetsDeps, { uid, planToken, accepted, documentId });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}, { scope: "googleApply", preset: "googleApply", tooManyMessage: "Too many spreadsheet apply requests. Please slow down." });
