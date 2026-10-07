import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { createConnectionRouteHandlers } from "@/lib/server/connectionRouteHandlers";
import { realConnectionRouteDeps } from "@/lib/server/connectionRouteDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { id: string };
}

// `id` is the REAL connection doc id (the one the OAuth callback created). There is no literal "calendar" id.
// The logic lives in connectionRouteHandlers.ts so it can be tested with fakes.
const handlers = createConnectionRouteHandlers(realConnectionRouteDeps);

export const GET = withAuthedRoute<RouteParams["params"]>(handlers.get, { scope: "googleSync", preset: "googleSync", limit: 20, tooManyMessage: "Too many connection reads. Please slow down." });

export const PATCH = withAuthedRoute<RouteParams["params"]>(handlers.patch, { scope: "googleSync", preset: "googleSync", limit: 20, tooManyMessage: "Too many connection updates. Please slow down." });

export const DELETE = withAuthedRoute<RouteParams["params"]>(handlers.remove, { scope: "google:connections", preset: "authSensitive" });
