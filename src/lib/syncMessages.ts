import type { PlanAttentionReason } from "@/lib/sync/plan";

/**
 * Plain-language wording for sync outcomes. Pure (no React, no server imports) so the same text is used by
 * the review dialog, the settings card and the toasts, and so a test can pin it down.
 */

const RESULT_CODE_TEXT: Record<string, string> = {
  not_accepted: "Not selected",
  fingerprint_mismatch: "Changed since you opened the review. Check again.",
  item_gone: "No longer needed: Study Lamp and Google now agree.",
  missing_resolution: "You didn't choose a side, so nothing was changed.",
  destructive_not_confirmed: "Deleting needs its own confirmation, so nothing was changed.",
  no_resolution: "You didn't choose what to do, so nothing was changed.",
  no_writer: "This kind of change can't be applied.",
  goal_changed: "The goal was edited while syncing, so it was left alone. Check again.",
  goal_missing: "The goal no longer exists.",
  goal_has_no_date: "The goal has no due date, so it can't be put on a calendar.",
  changed_remotely: "The event changed in Google while syncing. Check again.",
  remote_missing: "The event is no longer in Google Calendar.",
  remote_cancelled: "The event was deleted in Google, so it was not restored.",
  remote_unsupported: "Google's version of this event can't be used as a goal (for example it has a time or spans several days).",
  invalid_remote_value: "Google's value isn't valid for a goal (for example an empty title), so it was not used.",
  needs_attention: "This event can't be applied. You can hide it from future checks.",
  unsupported_kind: "This kind of change can't be applied.",
  busy: "Another sync is creating this task right now. Wait a moment and check again.",
  goal_has_no_title: "The goal has no title, so it can't be put in Google Tasks.",
  writer_error: "Google or Study Lamp couldn't complete this change. Nothing was marked as synced.",
};

/** Wording that says "task" instead of "event" for Google Tasks. */
const TASKS_CODE_TEXT: Record<string, string> = {
  changed_remotely: "The task changed in Google while syncing. Check again.",
  remote_missing: "The task is no longer in Google Tasks.",
  remote_unsupported: "Google's version of this task can't be used as a goal (for example its title is empty).",
  remote_cancelled: "The task was deleted in Google, so it was not restored.",
  needs_attention: "This task can't be applied.",
};

export function describeResultCode(code: string | undefined, service: "calendar" | "tasks" = "calendar"): string {
  if (!code) return "";
  if (service === "tasks" && TASKS_CODE_TEXT[code]) return TASKS_CODE_TEXT[code];
  return RESULT_CODE_TEXT[code] ?? "This change was not applied.";
}

const ATTENTION_TEXT: Record<PlanAttentionReason, string> = {
  cancelled: "This event was deleted in Google.",
  timed: "This event has a start time. Study Lamp goals are all-day, so it can't be used.",
  multi_day: "This event spans several days. Study Lamp goals have a single due date.",
  no_date: "This event has no date.",
  invalid_date: "This event's date isn't valid.",
  empty_title: "This event has no title.",
  title_too_long: "This event's title is too long for a goal.",
  goal_has_no_date: "This goal has no due date any more, but its calendar event still exists. Set a date or leave it.",
};

/** The same reasons in Google Tasks wording ("task", never "event" or "calendar"). */
const TASKS_ATTENTION_TEXT: Record<PlanAttentionReason, string> = {
  cancelled: "This task was deleted in Google.",
  timed: "This task has a start time. Study Lamp goals only have a due date, so it can't be used.",
  multi_day: "This task spans several days. Study Lamp goals have a single due date.",
  no_date: "This task has no due date.",
  invalid_date: "This task's due date isn't valid.",
  empty_title: "This task has no title.",
  title_too_long: "This task's title is too long for a goal.",
  goal_has_no_date: "This goal has no due date any more, but its task still exists. Set a date or leave it.",
};

export function describeAttentionReason(reason: PlanAttentionReason | null | undefined, service: "calendar" | "tasks" = "calendar"): string {
  if (!reason) return "This item can't be applied.";
  return (service === "tasks" ? TASKS_ATTENTION_TEXT : ATTENTION_TEXT)[reason];
}

export interface ApplyTally { applied: number; stale: number; skipped: number; failed: number }

export function summarizeApplyResults(results: Array<{ status: "applied" | "stale" | "skipped" | "failed"; code?: string }>): ApplyTally {
  const tally: ApplyTally = { applied: 0, stale: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    if (result.code === "not_accepted") continue;
    tally[result.status] += 1;
  }
  return tally;
}

/**
 * One honest sentence for the toast after an apply. It only says "synced" when something was really written
 * and nothing failed, so a failed call is never shown as success.
 */
export function describeApplyOutcome(tally: ApplyTally): { tone: "success" | "warning" | "error"; message: string } {
  const { applied, stale, skipped, failed } = tally;
  if (failed > 0) {
    return { tone: "error", message: `${failed} change${failed === 1 ? "" : "s"} failed${applied ? `; ${applied} applied` : ""}. Nothing failed was marked as synced.` };
  }
  const notDone = stale + skipped;
  if (applied > 0 && notDone === 0) return { tone: "success", message: `${applied} change${applied === 1 ? "" : "s"} applied.` };
  if (applied > 0) return { tone: "warning", message: `${applied} applied, ${notDone} left unchanged. Check again to see what's left.` };
  if (notDone > 0) return { tone: "warning", message: `Nothing was changed (${notDone} item${notDone === 1 ? "" : "s"} skipped or out of date). Check again.` };
  return { tone: "warning", message: "Nothing was changed." };
}
