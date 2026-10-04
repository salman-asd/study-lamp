import { NextResponse } from "next/server";
import { getAiPreferences, isAiLanguage, updateAiPreferences } from "@/lib/server/aiPreferences";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const GET = withAuthedRoute(async ({ uid }) => {
  return NextResponse.json({ preferences: await getAiPreferences(uid) }, { headers: { "Cache-Control": "private, no-store" } });
});

export const PATCH = withAuthedRoute(async ({ uid, req }) => {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).length === 0) {
    return NextResponse.json({ error: "At least one AI preference is required." }, { status: 400 });
  }
  if (body.speechToTextEnabled !== undefined && typeof body.speechToTextEnabled !== "boolean") {
    return NextResponse.json({ error: "speechToTextEnabled must be a boolean." }, { status: 400 });
  }
  if (body.generatingLanguage !== undefined && !isAiLanguage(body.generatingLanguage)) {
    return NextResponse.json({ error: "generatingLanguage must be en or bn." }, { status: 400 });
  }
  const preferences = await updateAiPreferences(uid, {
    ...(body.speechToTextEnabled === undefined ? {} : { speechToTextEnabled: body.speechToTextEnabled }),
    ...(body.generatingLanguage === undefined ? {} : { generatingLanguage: body.generatingLanguage }),
  });
  return NextResponse.json({ preferences }, { headers: { "Cache-Control": "private, no-store" } });
});
