"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlanFieldChange, PlanItem, PlanValue, SyncResolution } from "@/lib/sync/plan";
import { describeAttentionReason } from "@/lib/syncMessages";
import { cn } from "@/lib/utils";

export type ConfirmResolution = SyncResolution;

export interface ConfirmApplyPayload {
  accepted: string[];
  resolutions: Record<string, ConfirmResolution>;
  confirmedDestructive: string[];
}

export interface ConfirmChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PlanItem[];
  title?: string;
  confirmLabel?: string;
  /** Replaces the default "Review the proposed changes…" sentence. */
  description?: string;
  /** Hides the generic before → after rows (use when renderItemExtra shows the exact content). */
  hideFields?: boolean;
  /** Extra content under each item, e.g. a read-only box with the exact text that will be written. */
  renderItemExtra?: (item: PlanItem) => ReactNode;
  /** A visible error from the last attempt. When absent, an error thrown by onApply is shown instead. */
  errorMessage?: string | null;
  /** Extra footer controls (e.g. "Preview again", a reconnect link). */
  footerExtra?: ReactNode;
  onApply: (payload: ConfirmApplyPayload) => void | Promise<void>;
}

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** Items that can be ticked at all. A goal-linked "attention" item can only be read, never applied. */
export function isSelectableItem(item: PlanItem): boolean {
  return !(item.kind === "attention" && item.goalId);
}

/**
 * Ticked by default: ordinary pushes and pulls. NOT ticked: conflicts (need a choice), events deleted in Google,
 * imports (new goals), attention items, and anything destructive.
 */
export function getDefaultSelectedItemIds(items: PlanItem[]): Set<string> {
  const unticked = new Set<PlanItem["kind"]>(["conflict", "remote_deleted", "pull_create", "attention"]);
  return new Set(items.filter((item) => !unticked.has(item.kind) && item.risk !== "destructive").map((item) => item.itemId));
}

/** Starting choices: an event deleted in Google defaults to "unlink" (touches only Study Lamp's own link). */
export function getDefaultResolutions(items: PlanItem[]): Record<string, ConfirmResolution> {
  const result: Record<string, ConfirmResolution> = {};
  for (const item of items) if (item.kind === "remote_deleted") result[item.itemId] = "unlink";
  return result;
}

export function getDialogSummary(items: PlanItem[], selectedIds: Set<string>, resolutions: Record<string, ConfirmResolution> = {}) {
  const selected = items.filter((item) => selectedIds.has(item.itemId));
  const destructive = selected.filter((item) => item.risk === "destructive" || resolutions[item.itemId] === "delete_goal").length;
  const conflicts = items.filter((item) => item.kind === "conflict").length;
  return {
    selectedCount: selected.length,
    destructive,
    conflicts,
    pushCount: items.filter((item) => item.kind === "push_update" || item.kind === "push_create").length,
    pullCount: items.filter((item) => item.kind === "pull_update" || item.kind === "pull_create").length,
  };
}

/**
 * Splits an item's fields into unresolved conflicts (no direction: the user must choose)
 * and decided fields (carry a direction and are applied normally). Z3 item 3.
 */
export function groupConflictFields(fields: PlanFieldChange[]): {
  conflicting: PlanFieldChange[];
  nonConflicting: PlanFieldChange[];
} {
  const conflicting: PlanFieldChange[] = [];
  const nonConflicting: PlanFieldChange[] = [];
  for (const field of fields) {
    if (field.direction === "study_lamp" || field.direction === "google") nonConflicting.push(field);
    else conflicting.push(field);
  }
  return { conflicting, nonConflicting };
}

const FIELD_LABELS: Record<string, string> = { title: "Title", targetDate: "Due date", completed: "Completed" };

export function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

export function formatPlanValue(name: string, value: PlanValue | undefined): string {
  if (value === null || value === undefined || value === "") return "(none)";
  if (name === "completed") return value === true ? "Done" : "Not done";
  return String(value);
}

/** One sentence per field, with the direction written in words (never just an arrow). */
export function describeFieldChange(field: PlanFieldChange): string {
  const label = fieldLabel(field.name);
  if (field.direction === "study_lamp") return `Google Calendar will change: ${label} ${formatPlanValue(field.name, field.before)} → ${formatPlanValue(field.name, field.after)}`;
  if (field.direction === "google") return `Study Lamp will change: ${label} ${formatPlanValue(field.name, field.before)} → ${formatPlanValue(field.name, field.after)}`;
  return `${label} is different in both places: Study Lamp has ${formatPlanValue(field.name, field.local)}, Google has ${formatPlanValue(field.name, field.remote)}`;
}

const KIND_LABELS: Record<PlanItem["kind"], string> = {
  push_create: "Add to Google Calendar",
  push_update: "Update Google Calendar",
  pull_update: "Update Study Lamp from Google",
  pull_create: "Event in Google that isn't a goal yet",
  conflict: "Changed in both places",
  remote_deleted: "Deleted in Google Calendar",
  attention: "Can't be applied",
  append: "Add to the end of your file",
};

export function kindLabel(kind: PlanItem["kind"]): string {
  return KIND_LABELS[kind];
}

/** Item ids the user ticked that do nothing yet because every conflicting field is still on "skip". */
export function unresolvedConflictItemIds(items: PlanItem[], selectedIds: Set<string>, resolutions: Record<string, ConfirmResolution>): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (item.kind !== "conflict" || !selectedIds.has(item.itemId)) continue;
    const { conflicting, nonConflicting } = groupConflictFields(item.fields);
    const resolved = conflicting.filter((field) => {
      const choice = resolutions[`${item.itemId}:${field.name}`];
      return choice === "use_study_lamp" || choice === "use_google";
    }).length;
    if (resolved === 0 && nonConflicting.length === 0) result.push(item.itemId);
  }
  return result;
}

/**
 * Builds exactly what is sent to the server, and the reason Apply must stay disabled (or null).
 * - a ticked event-only "attention" item means "hide this event", so it carries the "ignore" choice
 * - a "delete the goal" choice counts as destructive only once its own box is ticked (deleteAck)
 */
export function buildApplyPayload(input: {
  items: PlanItem[];
  selectedIds: Set<string>;
  resolutions: Record<string, ConfirmResolution>;
  deleteAck: Set<string>;
}): { payload: ConfirmApplyPayload; blockedReason: string | null } {
  const { items, selectedIds, deleteAck } = input;
  const resolutions: Record<string, ConfirmResolution> = {};
  const confirmedDestructive: string[] = [];
  let blockedReason: string | null = null;

  for (const item of items) {
    if (!selectedIds.has(item.itemId)) continue;
    for (const [key, value] of Object.entries(input.resolutions)) {
      if (key === item.itemId || key.startsWith(`${item.itemId}:`)) resolutions[key] = value;
    }
    if (item.kind === "attention" && !item.goalId) resolutions[item.itemId] = "ignore";

    const choice = resolutions[item.itemId];
    if (item.risk === "destructive") confirmedDestructive.push(item.itemId);
    if (choice === "delete_goal") {
      if (deleteAck.has(item.itemId)) confirmedDestructive.push(item.itemId);
      else blockedReason ??= `Tick the box to confirm deleting "${item.title}", or choose another option.`;
    }
  }

  const unresolved = unresolvedConflictItemIds(items, selectedIds, input.resolutions);
  if (unresolved.length > 0) {
    const item = items.find((candidate) => candidate.itemId === unresolved[0]);
    blockedReason ??= `Choose Study Lamp or Google for at least one field of "${item?.title ?? "this goal"}", or untick it.`;
  }

  return { payload: { accepted: Array.from(selectedIds), resolutions, confirmedDestructive }, blockedReason };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConfirmChangesDialog({
  open,
  onOpenChange,
  items,
  title = "Review changes",
  confirmLabel = "Apply",
  description = "Review the proposed changes before anything is written. Nothing changes until you press Apply.",
  hideFields = false,
  renderItemExtra,
  errorMessage,
  footerExtra,
  onApply,
}: ConfirmChangesDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => getDefaultSelectedItemIds(items));
  const [resolutions, setResolutions] = useState<Record<string, ConfirmResolution>>(() => getDefaultResolutions(items));
  const [deleteAck, setDeleteAck] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [thrownError, setThrownError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSelectedIds(getDefaultSelectedItemIds(items));
    setResolutions(getDefaultResolutions(items));
    setDeleteAck(new Set());
    setSubmitting(false);
    setThrownError(null);
  }, [open, items]);

  const summary = useMemo(() => getDialogSummary(items, selectedIds, resolutions), [items, selectedIds, resolutions]);
  const built = useMemo(() => buildApplyPayload({ items, selectedIds, resolutions, deleteAck }), [items, selectedIds, resolutions, deleteAck]);

  const toggleItem = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const setChoice = (key: string, choice: ConfirmResolution) => setResolutions((previous) => ({ ...previous, [key]: choice }));

  const handleApply = async () => {
    if (built.blockedReason) return;
    setSubmitting(true);
    setThrownError(null);
    try {
      await onApply(built.payload);
      onOpenChange(false);
    } catch (error) {
      // Stay open and show the failure; never close as if it had worked.
      setThrownError(error instanceof Error && error.message ? error.message : "Something went wrong. Nothing was written.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          // Default focus is Cancel, never the action that writes.
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground" aria-live="polite">
            {summary.selectedCount > 0 ? `Apply ${summary.selectedCount} change${summary.selectedCount === 1 ? "" : "s"}.` : "No changes selected."}
            {summary.destructive > 0 ? ` ${summary.destructive} deletion${summary.destructive > 1 ? "s" : ""} need a second confirmation.` : ""}
          </div>

          <div className="mt-4 space-y-3">
            {items.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No changes are currently ready to review.</p>
            ) : (
              items.map((item) => {
                const checked = selectedIds.has(item.itemId);
                const selectable = isSelectableItem(item);
                const isConflict = item.kind === "conflict";
                const isDeleted = item.kind === "remote_deleted";
                const isImport = item.kind === "pull_create";
                const isEventOnlyAttention = item.kind === "attention" && !item.goalId;
                const { conflicting } = groupConflictFields(item.fields);
                const choice = resolutions[item.itemId];
                const idBase = `item-${item.itemId.slice(0, 12)}`;

                return (
                  <div key={item.itemId} className={cn("rounded-lg border bg-background p-3", !selectable && "opacity-90")}>
                    <div className="flex items-start gap-3">
                      {selectable ? (
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleItem(item.itemId)}
                          aria-label={isEventOnlyAttention ? `Hide ${item.title} from future checks` : `Toggle ${item.title}`}
                          className={cn(isConflict || isDeleted ? "data-[state=checked]:bg-amber-500" : "")}
                        />
                      ) : (
                        <span className="mt-1 h-4 w-4 shrink-0 rounded-sm border border-dashed" aria-hidden="true" />
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{item.title}</p>
                            <p className="text-xs text-muted-foreground">{kindLabel(item.kind)}</p>
                          </div>
                          {isConflict && <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">Conflict</span>}
                          {item.kind === "attention" && <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700">Not applied</span>}
                        </div>

                        {renderItemExtra?.(item)}

                        {item.kind === "attention" && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {describeAttentionReason(item.reason)}
                            {isEventOnlyAttention ? " Tick the box to hide it from future checks." : ""}
                          </p>
                        )}

                        <ul className={cn("mt-2 space-y-1 text-xs text-muted-foreground", hideFields && "hidden")}>
                          {item.fields.map((field) => (
                            <li key={`${item.itemId}-${field.name}`}>{describeFieldChange(field)}</li>
                          ))}
                        </ul>

                        {isConflict && conflicting.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {conflicting.map((field) => {
                              const key = `${item.itemId}:${field.name}`;
                              const value = resolutions[key] ?? "skip";
                              return (
                                <fieldset key={key} className="rounded-md border bg-muted/30 p-2">
                                  <legend className="px-1 text-xs font-medium text-muted-foreground">{fieldLabel(field.name)}: which one should win?</legend>
                                  <div role="radiogroup" aria-label={`Resolution for ${fieldLabel(field.name)}`} className="flex flex-wrap gap-3">
                                    {(["skip", "use_study_lamp", "use_google"] as const).map((option) => (
                                      <label key={option} className="flex items-center gap-1.5 text-sm">
                                        <input
                                          type="radio"
                                          name={`resolution-${idBase}-${field.name}`}
                                          value={option}
                                          checked={value === option}
                                          onChange={() => setChoice(key, option)}
                                        />
                                        {option === "skip"
                                          ? "Leave both as they are"
                                          : option === "use_study_lamp"
                                            ? `Keep Study Lamp's (${formatPlanValue(field.name, field.local)})`
                                            : `Use Google's (${formatPlanValue(field.name, field.remote)})`}
                                      </label>
                                    ))}
                                  </div>
                                </fieldset>
                              );
                            })}
                          </div>
                        )}

                        {isDeleted && (
                          <fieldset className="mt-3 rounded-md border bg-muted/30 p-2">
                            <legend className="px-1 text-xs font-medium text-muted-foreground">This event was deleted in Google. What should Study Lamp do?</legend>
                            <div role="radiogroup" aria-label={`What to do about ${item.title}`} className="space-y-1.5">
                              {([
                                ["unlink", "Keep the goal and stop syncing it (changes nothing in Google)"],
                                ["recreate", "Put the event back in Google Calendar"],
                                ["delete_goal", "Delete the goal here too"],
                              ] as const).map(([option, label]) => (
                                <label key={option} className="flex items-start gap-1.5 text-sm">
                                  <input
                                    type="radio"
                                    className="mt-1"
                                    name={`resolution-${idBase}`}
                                    value={option}
                                    checked={(choice ?? "unlink") === option}
                                    onChange={() => setChoice(item.itemId, option)}
                                  />
                                  <span className={option === "delete_goal" ? "text-red-700" : undefined}>{label}</span>
                                </label>
                              ))}
                            </div>
                            {choice === "delete_goal" && (
                              <label className="mt-2 flex items-start gap-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={deleteAck.has(item.itemId)}
                                  onChange={() =>
                                    setDeleteAck((current) => {
                                      const next = new Set(current);
                                      if (next.has(item.itemId)) next.delete(item.itemId);
                                      else next.add(item.itemId);
                                      return next;
                                    })
                                  }
                                />
                                I understand this deletes the goal &quot;{item.title}&quot; from Study Lamp. It can&apos;t be undone.
                              </label>
                            )}
                          </fieldset>
                        )}

                        {isImport && checked && (
                          <fieldset className="mt-3 rounded-md border bg-muted/30 p-2">
                            <legend className="px-1 text-xs font-medium text-muted-foreground">Ticked: what should Study Lamp do with this event?</legend>
                            <div role="radiogroup" aria-label={`What to do about ${item.title}`} className="space-y-1.5">
                              {([
                                ["use_google", "Create a goal from it (the Google event is not changed)"],
                                ["ignore", "Don't ask about this event again"],
                              ] as const).map(([option, label]) => (
                                <label key={option} className="flex items-center gap-1.5 text-sm">
                                  <input
                                    type="radio"
                                    name={`resolution-${idBase}`}
                                    value={option}
                                    checked={(choice ?? "use_google") === option}
                                    onChange={() => setChoice(item.itemId, option)}
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                          </fieldset>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {(errorMessage ?? thrownError) && (
          <div role="alert" className="mx-6 mb-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {errorMessage ?? thrownError}
          </div>
        )}
        {built.blockedReason && summary.selectedCount > 0 && (
          <p className="mx-6 mb-3 text-xs text-amber-700 dark:text-amber-300">{built.blockedReason}</p>
        )}

        <DialogFooter className="shrink-0 border-t p-4 sm:justify-between">
          <div className="text-xs text-muted-foreground">Nothing changes until you press {confirmLabel}.</div>
          <div className="flex flex-wrap items-center gap-2">
            {footerExtra}
            <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={summary.selectedCount === 0 || submitting || built.blockedReason !== null} loading={submitting} loadingText="Applying...">
              {confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
