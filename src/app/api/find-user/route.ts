import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/server/firebase-admin";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";

export const GET = withAuthedRoute(async ({ uid, req }) => {
  if (!process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return NextResponse.json({ error: "Recipient lookup is not configured on the server." }, { status: 503 });
  }

  try {
    const email = new URL(req.url).searchParams.get("email")?.trim();
    if (!email || email.length > 320) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    const profile = await adminAuth.getUserByEmail(email);
    if (profile.uid === uid) return NextResponse.json({ found: false, sameUser: true });
    return NextResponse.json({ found: true, uid: profile.uid });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "auth/user-not-found") return NextResponse.json({ found: false });
    logServerError("Recipient lookup failed", error);
    return NextResponse.json({ error: "Recipient lookup failed on the server." }, { status: 500 });
  }
}, { scope: "find-user", limit: 20, tooManyMessage: "Too many lookup requests." });
