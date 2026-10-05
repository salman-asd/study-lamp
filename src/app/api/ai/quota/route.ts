import { NextResponse } from "next/server";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";
import { getOrInitQuota, setUserQuotaOverride, validateQuotaOverrideInput } from "@/lib/server/aiQuota";

export const GET = withAuthedRoute(async ({ uid, req }) => {
  const targetUid = new URL(req.url).searchParams.get("uid") || uid;
  if (targetUid !== uid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const quota = await getOrInitQuota(targetUid);
    return NextResponse.json({ quota }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    logServerError("Failed to load quota", err);
    return NextResponse.json({ error: "Failed to load quota." }, { status: 500 });
  }
});

export const PATCH = withAuthedRoute(async ({ req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validationError = validateQuotaOverrideInput(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const uid = (body as Record<string, unknown>)?.uid;
  if (typeof uid !== "string" || !uid.trim()) {
    return NextResponse.json({ error: "uid is required." }, { status: 400 });
  }

  try {
    const quota = await setUserQuotaOverride(uid, body as any);
    return NextResponse.json({ quota }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    logServerError("Failed to update quota", err);
    return NextResponse.json({ error: "Failed to update quota." }, { status: 500 });
  }
}, { admin: true });
