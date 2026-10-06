import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { getPersonalDocument } from "@/lib/server/documentContent";
import { DriveApiError, getFileMetadata } from "@/lib/server/googleDrive";
import { DRIVE_ERROR_MESSAGES, driveHttpStatusForCode } from "@/lib/driveErrors";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only check against Drive for a Google-native document. The only write is to the user's own
 * personalDocuments record (modifiedTime); nothing is written to Google.
 */
export const POST = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  const document = await getPersonalDocument(uid, params.id);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  if (!document.googleNative) return NextResponse.json({ error: "Only Google Docs and Sheets can be refreshed." }, { status: 400 });

  try {
    const metadata = await withDriveAccessToken(uid, document.driveConnectionId, (accessToken) => getFileMetadata(accessToken, document.driveFileId));
    const modifiedTime = metadata.modifiedTime ?? null;
    const changed = modifiedTime !== null && modifiedTime !== (document.modifiedTime ?? null);
    if (changed) {
      await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(document.id).update({ modifiedTime });
    }
    return NextResponse.json({ modifiedTime, changed }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof DriveApiError && error.code) {
      return NextResponse.json({ error: DRIVE_ERROR_MESSAGES[error.code], code: error.code }, { status: driveHttpStatusForCode(error.code) });
    }
    logServerError("Google document refresh failed", error);
    return NextResponse.json({ error: "Couldn't check Google for changes." }, { status: 502 });
  }
}, { scope: "documents:refresh", preset: "default" });
