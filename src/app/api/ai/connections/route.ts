import { NextResponse } from "next/server";
import { createConnection, listConnections, validateCreateInput } from "@/lib/server/aiConnections";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

// GET /api/ai/connections — list the caller's own connections, masked.
export const GET = withAuthedRoute(async ({ uid }) => {
  try {
    const connections = await listConnections(uid);
    return NextResponse.json({ connections }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    logServerError("Failed to list AI connections", err);
    return NextResponse.json({ error: "Failed to load connections." }, { status: 500 });
  }
});

// POST /api/ai/connections — create a connection. Body: { provider, apiKey, model, label }.
export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validationError = validateCreateInput(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const connection = await createConnection(uid, body as any);
    return NextResponse.json({ connection }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err: any) {
    // Deliberately generic — never let a raw error object (which could
    // theoretically echo back request data) reach the client.
    logServerError("Failed to create AI connection", err);
    return NextResponse.json({ error: "Failed to save connection." }, { status: 500 });
  }
});
