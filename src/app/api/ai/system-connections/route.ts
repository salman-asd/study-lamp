import { NextResponse } from "next/server";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";
import {
  createConnection,
  listConnections,
  validateCreateInput,
} from "@/lib/server/systemAiConnections";

export const GET = withAuthedRoute(async () => {
  try {
    const connections = await listConnections();
    return NextResponse.json({ connections }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    logServerError("Failed to list system AI connections", err);
    return NextResponse.json({ error: "Failed to load connections." }, { status: 500 });
  }
}, { admin: true });

export const POST = withAuthedRoute(async ({ req }) => {
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
    const connection = await createConnection(body as any);
    return NextResponse.json({ connection }, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err: unknown) {
    logServerError("Failed to create system AI connection", err);
    return NextResponse.json({ error: "Failed to save connection." }, { status: 500 });
  }
}, { admin: true });
