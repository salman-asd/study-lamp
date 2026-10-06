import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import {
  deleteConnection,
  updateConnection,
  validateUpdateInput,
} from "@/lib/server/systemAiConnections";

interface RouteParams {
  params: { id: string };
}

const options = { admin: true, scope: "ai-system-connections" } as const;

export const PATCH = withAuthedRoute<RouteParams["params"]>(async ({ req, params }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validationError = validateUpdateInput(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const connection = await updateConnection(params.id, body as Parameters<typeof updateConnection>[1]);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return NextResponse.json({ connection }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    logServerError("Failed to update system AI connection", err);
    return NextResponse.json({ error: "Failed to update connection." }, { status: 500 });
  }
}, options);

export const DELETE = withAuthedRoute<RouteParams["params"]>(async ({ params }) => {
  try {
    const deleted = await deleteConnection(params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    logServerError("Failed to delete system AI connection", err);
    return NextResponse.json({ error: "Failed to delete connection." }, { status: 500 });
  }
}, options);
