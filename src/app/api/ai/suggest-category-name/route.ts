import { NextResponse } from "next/server";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { adminDb } from "@/lib/server/firebase-admin";
import { AiServiceError, generateAiText } from "@/lib/ai/aiService";
import { AI_OPTIONS } from "@/lib/ai/generateOptions";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
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
      const text = await generateAiText({ provider, apiKey, model, language }, prompt, { ...AI_OPTIONS.jsonObject, maxOutputTokens: 400 });
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
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong creating a category suggestion.", logLabel: "Failed to suggest category name" });
  }
});
