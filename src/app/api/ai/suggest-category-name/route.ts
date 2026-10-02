import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { adminDb } from "@/lib/server/firebase-admin";
import { AiServiceError, generateAiText } from "@/lib/ai/aiService";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";

const STATUS_BY_CODE: Record<string, number> = {
  auth: 400,
  rate_limit: 429,
  invalid_request: 502,
  blocked: 422,
  timeout: 504,
  network: 502,
  server_error: 502,
  unsupported_provider: 400,
  unknown: 500,
};

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const typedValue = String(body?.otherText ?? "").trim();
  const contextName = String(body?.contextName ?? "learning topic").trim();
  const candidateSubtopics = Array.isArray(body?.candidateSubtopics)
    ? body.candidateSubtopics.map((item: unknown) => String(item).trim()).filter(Boolean).slice(0, 100)
    : [];
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  if (!typedValue) {
    return NextResponse.json({ error: "The typed topic is required." }, { status: 400 });
  }

  try {
    const categorySnap = await adminDb.collection("users").doc(uid).collection("categories").get();
    const candidateCategories = categorySnap.docs.map((categoryDoc) => ({
      id: categoryDoc.id,
      name: String(categoryDoc.data().name ?? ""),
    }));
    const suggestion = await withAiConnection(uid, async (apiKey, provider, model) => {
      const prompt = `Suggest the correctly spelled learning topic. The learner is choosing a subtopic under "${contextName}".\n\nInput: "${typedValue}"\nKnown subtopics: ${candidateSubtopics.join(", ") || "(none)"}\nExisting main categories: ${candidateCategories.map((c) => c.name).join(", ") || "(none)"}\n\nIf the input is a typo, return the closest known subtopic. If it is a valid new topic, preserve it with normal title casing. Return JSON only in this exact shape:\n{\n  "cleanedName": "string",\n  "isDuplicate": boolean,\n  "matchingCategory": "string or null"\n}`;
      const text = await generateAiText({ provider, apiKey, model, language }, prompt);
      let parsed: any;
      try {
        parsed = JSON.parse((text.match(/\{[\s\S]*\}/)?.[0] ?? "{}"));
      } catch {
        throw new AiServiceError("invalid_request", "The AI returned an invalid spelling suggestion.");
      }
      if (!parsed || typeof parsed !== "object") throw new AiServiceError("invalid_request", "AI returned an invalid suggestion.");
      return {
        cleanedName: String(parsed.cleanedName || typedValue).trim(),
        isDuplicate: Boolean(parsed.isDuplicate),
        matchingCategory: parsed.matchingCategory ? String(parsed.matchingCategory).trim() : null,
      };
    });

    return NextResponse.json({ suggestion }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    if (err instanceof AiServiceError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] ?? 500 });
    }
    console.error("Failed to suggest category name", err);
    return NextResponse.json({ error: "Something went wrong creating a category suggestion." }, { status: 500 });
  }
}
