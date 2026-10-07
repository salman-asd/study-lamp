import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { GoogleConnectionError } from "@/lib/server/googleConnections";
import { PlanAlreadyAppliedError, type SyncResolution } from "@/lib/server/goalSyncApply";
import { PlanTokenVerificationError, verifyPlanToken } from "@/lib/server/planToken";
import { readJsonObject } from "@/lib/server/routeHelpers";
import { syncErrorResponse } from "@/lib/server/googleSyncErrors";

/**
 * Handler bodies for /api/google/sync/{plan,apply,status}. The route files only wrap them in withAuthedRoute
 * (auth + rate limit) and pass the real dependencies, so every branch (401, validation, success, replay) can be
 * tested with fakes and no Firestore or Google.
 */

export type SyncTarget = "calendar" | "tasks";

export const EMPTY_CALENDAR_PLAN = {
  planToken: "",
  items: [],
  counts: { push: 0, pull: 0, conflict: 0, attention: 0, remoteDeleted: 0, orphaned: 0 },
  orphans: [],
  remaining: 0,
};

/**
 * `targets` defaults to CALENDAR ONLY (audit H1). The Calendar hook sends no targets, and a default that also
 * planned Tasks cost every goals-page check an extra token refresh and a full Tasks read whose result was thrown
 * away. The Tasks hook always sends ["tasks"] explicitly. Each target has its OWN plan token.
 */
export function readTargets(value: unknown): { targets: SyncTarget[]; explicit: boolean } {
  if (!Array.isArray(value)) return { targets: ["calendar"], explicit: false };
  const targets = value.filter((entry): entry is SyncTarget => entry === "calendar" || entry === "tasks");
  return { targets: Array.from(new Set(targets)), explicit: true };
}

// ─── plan ───────────────────────────────────────────────────────────────────

export interface SyncPlanDeps {
  /** Calendar plan, or EMPTY_CALENDAR_PLAN when Calendar sync is not enabled. READ-ONLY. */
  planCalendar(uid: string, connectionId: string | null, goalIds: string[]): Promise<Record<string, unknown>>;
  /** Tasks plan, or null when Tasks sync is not enabled. READ-ONLY. */
  planTasks(uid: string, connectionId: string | null, goalIds: string[]): Promise<Record<string, unknown> | null>;
}

export function createSyncPlanHandler(deps: SyncPlanDeps) {
  return async function handleSyncPlan({ uid, req }: { uid: string; req: NextRequest }): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.response;

    const body = parsed.body;
    const goalIds = Array.isArray(body.goalIds) ? body.goalIds.filter((value): value is string => typeof value === "string") : [];
    const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;
    const { targets, explicit } = readTargets(body.targets);

    if (goalIds.length > 25) {
      return NextResponse.json({ error: "goalIds must contain at most 25 items." }, { status: 400 });
    }

    /**
     * A target the user never set up must not fail a default (non-explicit) check. "ambiguous" is NOT tolerated:
     * the user has several connections and must be told to choose one (audit M2), not left with a silent no-op.
     */
    const tolerate = (error: unknown) =>
      !explicit && error instanceof GoogleConnectionError && (error.code === "not_found" || error.code === "scope_missing");

    try {
      let calendarPart: Record<string, unknown> = EMPTY_CALENDAR_PLAN;
      if (targets.includes("calendar")) {
        try {
          calendarPart = await deps.planCalendar(uid, requestedConnectionId, goalIds);
        } catch (error) {
          if (!tolerate(error)) throw error;
        }
      }

      let tasksPart: Record<string, unknown> | null = null;
      if (targets.includes("tasks")) {
        try {
          tasksPart = await deps.planTasks(uid, requestedConnectionId, goalIds);
        } catch (error) {
          if (!tolerate(error)) throw error;
        }
      }

      return NextResponse.json({ ...calendarPart, ...(tasksPart ? { tasks: tasksPart } : {}) });
    } catch (error) {
      return syncErrorResponse("google sync plan", error);
    }
  };
}

// ─── apply ──────────────────────────────────────────────────────────────────

export const SYNC_RESOLUTIONS: readonly SyncResolution[] = ["use_study_lamp", "use_google", "skip", "unlink", "recreate", "delete_goal", "ignore"];
/** `<itemId>` (64 hex) or `<itemId>:<field>` for one field of a conflict. */
const RESOLUTION_KEY = /^[a-f0-9]{64}(:[A-Za-z]{1,30})?$/;
const MAX_LIST = 500;

export function readResolutions(value: unknown): Record<string, SyncResolution> {
  const result: Record<string, SyncResolution> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, choice] of Object.entries(value).slice(0, MAX_LIST)) {
    if (!RESOLUTION_KEY.test(key)) continue;
    if (typeof choice === "string" && (SYNC_RESOLUTIONS as readonly string[]).includes(choice)) result[key] = choice as SyncResolution;
  }
  return result;
}

export function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_LIST) : [];
}

export type ApplyResultStatus = "applied" | "stale" | "skipped" | "failed";

export function summarizeApply(results: Array<{ status: ApplyResultStatus }>) {
  const applied = results.filter((result) => result.status === "applied").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return { ok: applied > 0 && failed === 0, results, applied, skipped: results.length - applied - failed, failed };
}

export interface SyncApplyInput {
  planToken: string;
  accepted: string[];
  resolutions: Record<string, SyncResolution>;
  confirmedDestructive: string[];
}

export interface SyncApplyDeps {
  /** Null when that target's sync is not enabled for the connection. */
  applyCalendar(uid: string, connectionId: string | null, input: SyncApplyInput): Promise<{ results: Array<{ status: ApplyResultStatus }> } | null>;
  applyTasks(uid: string, connectionId: string | null, input: SyncApplyInput): Promise<{ results: Array<{ status: ApplyResultStatus }> } | null>;
  /** Housekeeping: deletes spent, expired token docs. Fire-and-forget; its failure never changes the response (audit H3). */
  pruneUsedTokens(uid: string): Promise<unknown>;
}

function pruneQuietly(deps: SyncApplyDeps, uid: string): void {
  void Promise.resolve()
    .then(() => deps.pruneUsedTokens(uid))
    .catch(() => undefined);
}

export function createSyncApplyHandler(deps: SyncApplyDeps) {
  return async function handleSyncApply({ uid, req }: { uid: string; req: NextRequest }): Promise<Response> {
    const parsed = await readJsonObject(req);
    if (!parsed.ok) return parsed.response;

    const body = parsed.body;
    const planToken = typeof body.planToken === "string" ? body.planToken : "";
    const input: SyncApplyInput = {
      planToken,
      accepted: readStrings(body.accepted),
      resolutions: readResolutions(body.resolutions),
      confirmedDestructive: readStrings(body.confirmedDestructive),
    };
    const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;

    if (!planToken) {
      return NextResponse.json({ error: "Missing planToken." }, { status: 400 });
    }

    // Each target has its own plan and token. Default stays "calendar" so existing callers are unchanged.
    // A token signed for the OTHER target fails here with wrong_scope.
    const target: SyncTarget = body.target === "tasks" ? "tasks" : "calendar";

    try {
      verifyPlanToken(planToken, uid, target);
    } catch (error) {
      if (error instanceof PlanTokenVerificationError) {
        return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
      }
      return syncErrorResponse("google sync apply token", error);
    }

    if (input.accepted.length === 0) {
      return NextResponse.json({ error: "The sync plan was not accepted for application." }, { status: 409 });
    }

    try {
      const outcome = target === "tasks"
        ? await deps.applyTasks(uid, requestedConnectionId, input)
        : await deps.applyCalendar(uid, requestedConnectionId, input);
      if (!outcome) {
        return NextResponse.json({ error: target === "tasks" ? "Google Tasks sync is not enabled." : "Google Calendar sync is not enabled." }, { status: 409 });
      }
      // The one-time token doc was written by the apply step; trim old ones so the collection stays bounded.
      pruneQuietly(deps, uid);
      return NextResponse.json(summarizeApply(outcome.results));
    } catch (error) {
      if (error instanceof PlanTokenVerificationError) {
        return NextResponse.json({ error: "Invalid or expired plan token." }, { status: 401 });
      }
      if (error instanceof PlanAlreadyAppliedError) {
        return NextResponse.json({ error: "This plan was already applied." }, { status: 409 });
      }
      return syncErrorResponse("google sync apply", error);
    }
  };
}

// ─── status ─────────────────────────────────────────────────────────────────

export interface SyncStatusDeps {
  calendarStatus(uid: string, connectionId: string | null): Promise<unknown>;
  tasksStatus(uid: string, connectionId: string | null): Promise<unknown>;
}

export function createSyncStatusHandler(deps: SyncStatusDeps) {
  return async function handleSyncStatus({ uid, req }: { uid: string; req: NextRequest }): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const connectionId = params.get("connectionId");
    try {
      const status = params.get("target") === "tasks" ? await deps.tasksStatus(uid, connectionId) : await deps.calendarStatus(uid, connectionId);
      return NextResponse.json(status);
    } catch (error) {
      return syncErrorResponse("google sync status", error);
    }
  };
}
