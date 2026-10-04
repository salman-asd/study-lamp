import { NextResponse } from "next/server";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { generateGoalSuggestions } from "@/lib/ai/aiService";
import type { RoadmapStep } from "@/types";
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

  const categoryName = String(body?.categoryName ?? "").trim();
  const level = String(body?.level ?? "").trim() || "basic";
  const rawSteps = Array.isArray(body?.steps) ? (body.steps as unknown[]) : [];
  const steps = rawSteps
    .map((step) => step as Partial<RoadmapStep>)
    .filter((step): step is Partial<RoadmapStep> => !!step && typeof step.title === "string" && step.title.trim().length > 0)
    .map((step) => ({ title: step.title!.trim(), description: (step.description || "").trim() }));
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  if (!categoryName) {
    return NextResponse.json({ error: "A categoryName is required." }, { status: 400 });
  }
  if (steps.length === 0) {
    return NextResponse.json({ error: "At least one roadmap step is required." }, { status: 400 });
  }

  try {
    const suggestions = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateGoalSuggestions({ provider, apiKey, model, language }, { categoryName, level, steps });
    });

    return NextResponse.json({ suggestions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong suggesting goals.", logLabel: "Failed to generate goal suggestions" });
  }
});
