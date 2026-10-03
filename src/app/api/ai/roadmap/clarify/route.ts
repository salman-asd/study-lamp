import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { withAiConnection } from "@/lib/server/resolveAiConnection";
import { AiServiceError, generateTopicClarification, generateFocusClarification } from "@/lib/ai/aiService";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";

const STATUS_BY_CODE: Record<string, number> = {
  auth: 400, rate_limit: 429, invalid_request: 502, blocked: 422,
  timeout: 504, network: 502, server_error: 502, unsupported_provider: 400, unknown: 500,
};

// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }

  const rawName = String(body?.name ?? "").trim();
  const context = String(body?.context ?? "").trim();
  const kind = body?.kind === "focus" ? "focus" : "topic";
  const language = await resolveAiLanguage(uid, body?.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });

  if (!rawName) return NextResponse.json({ error: "A name is required." }, { status: 400 });
  if (kind === "focus" && !context) return NextResponse.json({ error: "A category context is required for focus clarification." }, { status: 400 });

  try {
    const result = await withAiConnection(uid, (apiKey, provider, model) =>
      kind === "focus"
        ? generateFocusClarification({ provider, apiKey, model, language }, context, rawName)
        : generateTopicClarification({ provider, apiKey, model, language }, rawName)
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    // Clarification is best-effort — never block saving over it.
    if (err instanceof AiServiceError) console.error(`Clarify AI error [${err.code}]`);
    return NextResponse.json({ ambiguous: false });
  }
}