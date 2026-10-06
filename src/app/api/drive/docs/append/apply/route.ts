import { NextResponse } from "next/server";
import { applyDocsAppend } from "@/lib/server/googleAppendApply";
import { realDocsDeps } from "@/lib/server/googleAppendDeps";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * APPLY. The body carries ONLY {planToken, accepted, documentId}. Text, heading and revision are never read
 * from the request: the server rebuilds them from stored data and checks them against the confirmed fingerprint.
 */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const planToken = typeof parsed.body.planToken === "string" ? parsed.body.planToken : "";
  const documentId = typeof parsed.body.documentId === "string" ? parsed.body.documentId : "";
  const accepted = Array.isArray(parsed.body.accepted)
    ? parsed.body.accepted.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];

  const result = await applyDocsAppend(realDocsDeps, { uid, planToken, accepted, documentId });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}, { scope: "googleApply", preset: "googleApply", tooManyMessage: "Too many document apply requests. Please slow down." });
