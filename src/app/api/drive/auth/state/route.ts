import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { signDriveState, isDriveConfigured } from "@/lib/server/googleDrive";

// Step 1 of the OAuth flow (Phase 13): the browser calls this (authenticated,
// normal fetch with an Authorization header) to get a short-lived signed
// state token, then builds the Google auth URL itself and navigates the
// whole page there. See src/lib/driveClient.ts.
export async function POST(req: NextRequest) {
  const uid = await requireAuthenticatedUid(req);
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isDriveConfigured()) {
    return NextResponse.json(
      { error: "Google Drive isn't configured on this deployment yet (missing GOOGLE_DRIVE_CLIENT_ID/SECRET)." },
      { status: 501 }
    );
  }

  return NextResponse.json({ state: signDriveState(uid) });
}
