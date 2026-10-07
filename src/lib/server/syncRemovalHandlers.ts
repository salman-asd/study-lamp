import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PlanAlreadyAppliedError } from "@/lib/server/goalSyncApply";
import { isPlausibleConnectionId } from "@/lib/server/googleConnections";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";
import type { GoogleSyncLogEntry } from "@/lib/server/googleSyncLog";
import { PlanTokenVerificationError, verifyPlanToken } from "@/lib/server/planToken";
import { readJsonObject } from "@/lib/server/routeHelpers";
import {
  isRemovalScope,
  isRemovalTarget,
  RemovalCountMismatchError,
  type RemovalApplyResult,
  type RemovalPlan,
  type RemovalScope,
  type RemovalTarget,
} from "@/lib/server/googleSyncRemoval";
import { summarizeApply } from "@/lib/server/syncRouteHandlers";

/**
 * Handler bodies for /api/google/sync/{history,remove/preview,remove} (W5). The route files only wrap them in
 * withAuthedRoute (auth + rate limit) and pass the real dependencies, so 401/400/409 and success paths are testable
 * with fakes.
 */

export interface RemovalSelectionInput {
  target: RemovalTarget;
  scope: RemovalScope;
  connectionId: string;
}

export interface RemovalRouteDeps {
  /** READ-ONLY. Our own docs only; no write and no Google call. */
  preview(uid: string, selection: RemovalSelectionInput): Promise<RemovalPlan>;
  apply(uid: string, selection: RemovalSelectionInput, input: { planToken: string; confirmCount: number }): Promise<RemovalApplyResult>;
  /** Housekeeping: deletes spent, expired token docs. Fire-and-forget. */
  pruneUsedTokens(uid: string): Promise<unknown>;
}

type Ctx = { uid: string; req: NextRequest };

function readSelection(body: Record<string, unknown>): { ok: true; selection: RemovalSelectionInput } | { ok: false; response: NextResponse } {
  if (!isRemovalTarget(body.target)) return { ok: false, response: NextResponse.json({ error: 'target must be "calendar" or "tasks".' }, { status: 400 }) };
  if (!isRemovalScope(body.scope)) return { ok: false, response: NextResponse.json({ error: 'scope must be "orphans" or "all".' }, { status: 400 }) };
  if (!isPlausibleConnectionId(body.connectionId)) return { ok: false, response: NextResponse.json({ error: "connectionId is required." }, { status: 400 }) };
  return { ok: true, selection: { target: body.target, scope: body.scope, connectionId: body.connectionId } };
}

export function createRemovalPreviewHandler(deps: RemovalRouteDeps) {
  return async function handleRemovalPreview({ uid, req }: Ctx): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.response;
    const selection = readSelection(parsed.body);
    if (!selection.ok) return selection.response;
    try {
      return NextResponse.json(await deps.preview(uid, selection.selection));
    } catch (error) {
      return syncErrorResponse("google sync remove preview", error);
    }
  };
}

export function createRemovalApplyHandler(deps: RemovalRouteDeps) {
  return async function handleRemovalApply({ uid, req }: Ctx): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.response;

    const planToken = typeof parsed.body.planToken === "string" ? parsed.body.planToken : "";
    if (!planToken) return NextResponse.json({ error: "Missing planToken." }, { status: 400 });

    const confirmCount = parsed.body.confirmCount;
    if (typeof confirmCount !== "number" || !Number.isInteger(confirmCount) || confirmCount < 0 || confirmCount > 100_000) {
      return NextResponse.json({ error: "confirmCount must be a whole number." }, { status: 400 });
    }

    const selection = readSelection(parsed.body);
    if (!selection.ok) return selection.response;

    try {
      verifyPlanToken(planToken, uid, "remove");
    } catch (error) {
      if (error instanceof PlanTokenVerificationError) return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
      return syncErrorResponse("google sync remove token", error);
    }

    try {
      const outcome = await deps.apply(uid, selection.selection, { planToken, confirmCount });
      void Promise.resolve()
        .then(() => deps.pruneUsedTokens(uid))
        .catch(() => undefined);
      return NextResponse.json(summarizeApply(outcome.results));
    } catch (error) {
      if (error instanceof RemovalCountMismatchError) {
        // The fresh count lets the browser re-ask the user instead of guessing.
        return NextResponse.json({ error: "The number of items to remove changed. Please review again.", code: "count_changed", count: error.count }, { status: 409 });
      }
      if (error instanceof PlanTokenVerificationError) return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
      if (error instanceof PlanAlreadyAppliedError) return NextResponse.json({ error: "This plan was already applied." }, { status: 409 });
      return syncErrorResponse("google sync remove", error);
    }
  };
}

// ─── history ────────────────────────────────────────────────────────────────

export const HISTORY_PAGE_SIZE = 50;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface SyncHistoryDeps {
  list(uid: string, cursor: string | undefined, limit: number): Promise<{ entries: GoogleSyncLogEntry[]; nextCursor: string | null }>;
}

export function createSyncHistoryHandler(deps: SyncHistoryDeps) {
  return async function handleSyncHistory({ uid, req }: Ctx): Promise<Response> {
    const raw = new URL(req.url).searchParams.get("cursor");
    if (raw !== null && !CURSOR_PATTERN.test(raw)) {
      return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    }
    try {
      return NextResponse.json(await deps.list(uid, raw ?? undefined, HISTORY_PAGE_SIZE));
    } catch (error) {
      return syncErrorResponse("google sync history", error);
    }
  };
}
