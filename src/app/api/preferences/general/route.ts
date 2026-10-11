import { NextResponse } from "next/server";
import { sanitizePartialPrefs } from "@/lib/generalPrefs";
import { getGeneralPrefs, updateGeneralPrefs } from "@/lib/server/generalPrefs";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

const NO_STORE = { "Cache-Control": "private, no-store" };

export const GET = withAuthedRoute(async ({ uid }) => {
  return NextResponse.json({ preferences: await getGeneralPrefs(uid) }, { headers: NO_STORE });
}, { scope: "prefs:general" });

export const PUT = withAuthedRoute(async ({ uid, req }) => {
  const body: unknown = await req.json().catch(() => null);
  const partial = sanitizePartialPrefs(body);
  if (Object.keys(partial).length === 0) {
    return NextResponse.json({ error: "No valid preference was sent." }, { status: 400 });
  }
  return NextResponse.json({ preferences: await updateGeneralPrefs(uid, partial) }, { headers: NO_STORE });
}, { scope: "prefs:general" });
