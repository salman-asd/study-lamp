import { createConnectionRouteHandlers } from "@/lib/server/connectionRouteHandlers";
import { realConnectionRouteDeps } from "@/lib/server/connectionRouteDeps";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export const GET = withAuthedRoute(createConnectionRouteHandlers(realConnectionRouteDeps).list, { scope: "google:connections", preset: "authSensitive" });
