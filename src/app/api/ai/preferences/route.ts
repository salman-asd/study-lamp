import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { getAiPreferences, isAiLanguage, updateAiPreferences } from "@/lib/server/aiPreferences";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ preferences: await getAiPreferences(uid) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
}
