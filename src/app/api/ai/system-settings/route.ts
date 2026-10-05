import { NextResponse } from "next/server";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";
import { getSystemAiDefaults, setSystemAiDefaults, validateSystemDefaultsInput } from "@/lib/server/aiQuota";

export const GET = withAuthedRoute(async () => {
  try {
    const defaults = await getSystemAiDefaults();
    return NextResponse.json({ defaults }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    logServerError("Failed to load system AI defaults", err);
    return NextResponse.json({ error: "Failed to load defaults." }, { status: 500 });
  }
}, { admin: true });

export const PATCH = withAuthedRoute(async ({ req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validationError = validateSystemDefaultsInput(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const defaults = await setSystemAiDefaults(body as any);
    return NextResponse.json({ defaults }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    logServerError("Failed to update system AI defaults", err);
    return NextResponse.json({ error: "Failed to update defaults." }, { status: 500 });
  }
}, { admin: true });
