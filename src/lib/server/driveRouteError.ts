import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { markDriveConnectionRejected } from "@/lib/server/driveConnections";
import { mapDriveRouteError, shouldMarkConnectionRejected } from "@/lib/server/driveErrors";

/**
 * The one `catch` body for Drive routes that call Google on behalf of a saved connection.
 * Keeps the response shape { error, code? }: `code: "reconnect"` tells the UI to show a
 * "Reconnect Google" action instead of a raw error.
 */
export async function driveRouteErrorResponse(
  uid: string,
  connectionId: string,
  err: unknown,
  options: { logLabel: string; fallbackMessage: string },
): Promise<NextResponse> {
  const mapped = mapDriveRouteError(err, options.fallbackMessage);
  if (shouldMarkConnectionRejected(err)) {
    // Best effort: a failed bookkeeping write must not hide the real answer from the user.
    await markDriveConnectionRejected(uid, connectionId).catch((markError: unknown) => logServerError("Marking Drive connection rejected failed", markError));
  }
  if (mapped.status >= 500 || mapped.status === 409 || mapped.status === 403) logServerError(options.logLabel, err);
  return NextResponse.json(mapped.body, { status: mapped.status });
}
