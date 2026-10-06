import { NextResponse, type NextRequest } from "next/server";
import { AiServiceError, type AiErrorCode } from "@/lib/ai/errors";
import { isAdminUid, requireAuthenticatedUid } from "@/lib/server/requireAuth";
import { checkRateLimit, type RateLimitPreset } from "@/lib/server/rateLimit";
import { logServerError } from "@/lib/server/logError";

/** HTTP status per AiServiceError code. The single copy; routes must not keep their own. */
export const AI_STATUS_BY_CODE: Record<AiErrorCode, number> = {
  auth: 400,
  rate_limit: 429,
  invalid_request: 502,
  blocked: 422,
  timeout: 504,
  network: 502,
  server_error: 502,
  unsupported_provider: 400,
  unknown: 500,
};

export interface AuthedRouteContext<P> {
  uid: string;
  req: NextRequest;
  params: P;
}

export interface AuthedRouteOptions {
  /** Rate-limit scope. Omit to authenticate without rate limiting (the AI routes are quota-limited instead). */
  scope?: string;
  preset?: RateLimitPreset;
  limit?: number;
  /** Require the caller to be an admin. */
  admin?: boolean;
  /** Body text of the 429 response. Default "Too many requests." */
  tooManyMessage?: string;
  /** Retry-After header on the 429 response, in seconds. Default 60; null sends no header. */
  retryAfterSeconds?: number | null;
}

type RouteHandler<P> = (context: AuthedRouteContext<P>) => Promise<Response> | Response;

/**
 * Wraps a route handler with the standard checks every authenticated route repeats:
 * Bearer token -> 401 {error:"Unauthorized"}, then (when `scope` is set) the per-user
 * rate limit -> 429. The handler runs only for an authenticated, non-limited caller.
 *
 * Not for routes with their own auth (signed-URL stream/thumbnail, the OAuth callback)
 * or that need extra checks between auth and the limiter.
 */
export function withAuthedRoute<P = Record<string, never>>(handler: RouteHandler<P>, options: AuthedRouteOptions = {}) {
  return createAuthedRoute<P>(requireAuthenticatedUid, handler, options);
}

/** Same as withAuthedRoute with the authenticator injected; exists so the 401/429 paths are unit-testable. */
export function createAuthedRoute<P = Record<string, never>>(
  authenticate: (req: NextRequest) => Promise<string | null>,
  handler: RouteHandler<P>,
  options: AuthedRouteOptions = {},
  isAdmin: (uid: string) => Promise<boolean> = isAdminUid,
) {
  return async function route(req: NextRequest, context: { params: P }): Promise<Response> {
    const uid = await authenticate(req);
    if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // The token is verified once above; admin routes only add the role check.
    if (options.admin && !(await isAdmin(uid))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (options.scope) {
      const allowed = checkRateLimit(uid, { scope: options.scope, preset: options.preset, limit: options.limit });
      if (!allowed) {
        const retryAfter = options.retryAfterSeconds === undefined ? 60 : options.retryAfterSeconds;
        return NextResponse.json(
          { error: options.tooManyMessage ?? "Too many requests." },
          { status: 429, ...(retryAfter === null ? {} : { headers: { "Retry-After": String(retryAfter) } }) },
        );
      }
    }

    return handler({ uid, req, params: context?.params ?? ({} as P) });
  };
}

export type JsonObjectResult =
  | { ok: true; body: Record<string, any> }
  | { ok: false; response: NextResponse };

/** Parses the request body as a JSON object. Anything else (bad JSON, null, array, primitive) -> 400 "Invalid JSON body." */
export async function readJsonObject(req: Request): Promise<JsonObjectResult> {
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed };
  } catch {
    // fall through to the 400 below
  }
  return { ok: false, response: NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }) };
}

export interface AiErrorResponseOptions {
  /** Message for failures that are not AiServiceErrors (and for hidden >= 500 ones). */
  fallbackMessage: string;
  /** Replace AiServiceError messages with fallbackMessage when the mapped status is >= 500. Default false. */
  hideServerMessages?: boolean;
  /** Prefix for the server log line. Only the error's `name` is logged, never its message or stack. */
  logLabel?: string;
}

/** Maps a thrown AI failure to a JSON response. AiServiceErrors keep their provider-agnostic message. */
export function aiErrorResponse(err: unknown, options: AiErrorResponseOptions): NextResponse {
  if (err instanceof AiServiceError) {
    const status = AI_STATUS_BY_CODE[err.code] ?? 500;
    const message = options.hideServerMessages && status >= 500 ? options.fallbackMessage : err.message;
    return NextResponse.json({ error: message }, { status });
  }
  const name = err instanceof Error ? err.name : typeof err;
  logServerError(options.logLabel ?? "Unexpected AI route error", err);
  return NextResponse.json({ error: options.fallbackMessage }, { status: 500 });
}
