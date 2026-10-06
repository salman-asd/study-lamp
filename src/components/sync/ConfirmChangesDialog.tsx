"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PlanFieldChange, PlanItem } from "@/lib/sync/plan";
import { cn } from "@/lib/utils";

export type ConfirmResolution = "use_study_lamp" | "use_google" | "skip" | "unlink" | "recreate" | "delete_goal";

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
  onApply: (payload: {
    accepted: string[];
    resolutions: Record<string, ConfirmResolution>;
    confirmedDestructive: string[];
  }) => void | Promise<void>;
}

export function getDefaultSelectedItemIds(items: PlanItem[]): Set<string> {
  return new Set(items.filter((item) => item.kind !== "conflict" && item.risk !== "destructive").map((item) => item.itemId));
}

export function getDialogSummary(items: PlanItem[], selectedIds: Set<string>) {
  const selected = items.filter((item) => selectedIds.has(item.itemId));
  const destructive = selected.filter((item) => item.risk === "destructive").length;
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
 * Splits an item's fields into unresolved conflicts (no direction — the user must choose)
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
  const [resolutions, setResolutions] = useState<Record<string, ConfirmResolution>>({});
  const [submitting, setSubmitting] = useState(false);
  const [thrownError, setThrownError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSelectedIds(getDefaultSelectedItemIds(items));
    setResolutions({});
    setSubmitting(false);
    setThrownError(null);
  }, [open, items]);

  const summary = useMemo(() => getDialogSummary(items, selectedIds), [items, selectedIds]);

  const toggleItem = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleApply = async () => {
    const accepted = Array.from(selectedIds);
    const confirmedDestructive = items
      .filter((item) => selectedIds.has(item.itemId) && item.risk === "destructive")
      .map((item) => item.itemId);

    setSubmitting(true);
    setThrownError(null);
    try {
      await onApply({ accepted, resolutions, confirmedDestructive });
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
        className="max-w-2xl p-0"
        onOpenAutoFocus={(event) => {
          // Default focus is Cancel, never the action that writes.
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <div className="p-6 pb-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            {summary.selectedCount > 0 ? `Apply ${summary.selectedCount} changes.` : "No changes selected."}
            {summary.destructive > 0 ? ` ${summary.destructive} destructive change${summary.destructive > 1 ? "s" : ""} need a second confirmation.` : ""}
          </div>

          <div className="mt-4 space-y-3">
            {items.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No changes are currently ready to review.
              </p>
            ) : (
              items.map((item) => {
                const checked = selectedIds.has(item.itemId);
                const isConflict = item.kind === "conflict";
                const isDestructive = item.risk === "destructive";
                const conflictFields = isConflict ? groupConflictFields(item.fields).conflicting : [];

                return (
                  <div key={item.itemId} className="rounded-lg border bg-background p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleItem(item.itemId)}
                        aria-label={`Toggle ${item.title}`}
                        className={cn(isConflict || isDestructive ? "data-[state=checked]:bg-amber-500" : "")}
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{item.title}</p>
                            <p className="text-xs text-muted-foreground">{item.kind}</p>
                          </div>
                          {isDestructive && <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800">Destructive</span>}
                          {isConflict && <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">Conflict</span>}
                        </div>

                        {renderItemExtra?.(item)}

                        <div className={cn("mt-2 space-y-1 text-xs text-muted-foreground", hideFields && "hidden")}>
                          {item.fields.map((field) => {
                            const hasBoth = field.local !== undefined || field.remote !== undefined;
                            return (
                              <div key={`${item.itemId}-${field.name}`} className="flex justify-between gap-3">
                                <span>{field.name}</span>
                                {hasBoth ? (
                                  <span>Study Lamp: {String(field.local ?? "—")} · Google: {String(field.remote ?? "—")}</span>
                                ) : (
                                  <span>{String(field.before ?? "—")} → {String(field.after ?? "—")}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {isConflict && conflictFields.length > 0 && (
                          <div className="mt-3 space-y-2">
                            {conflictFields.map((field) => {
                              const key = `${item.itemId}:${field.name}`;
                              const value = resolutions[key] ?? "skip";
                              return (
                                <div key={key} className="rounded-md border bg-muted/30 p-2">
                                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {field.name}: Study Lamp {String(field.local ?? field.before ?? "—")} vs Google {String(field.remote ?? field.after ?? "—")}
                                  </p>
                                  <div role="radiogroup" aria-label={`Resolution for ${field.name}`} className="flex flex-wrap gap-3">
                                    {(["skip", "use_study_lamp", "use_google"] as const).map((choice) => (
                                      <label key={choice} className="flex items-center gap-1.5 text-sm">
                                        <input
                                          type="radio"
                                          name={`resolution-${item.itemId}-${field.name}`}
                                          value={choice}
                                          checked={value === choice}
                                          onChange={() => setResolutions((prev) => ({ ...prev, [key]: choice }))}
                                        />
                                        {choice === "skip" ? "Skip" : choice === "use_study_lamp" ? "Use Study Lamp" : "Use Google"}
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {isDestructive && (
                          <div className="mt-2 text-xs text-red-700">
                            This item deletes or removes data and must be confirmed separately.
                          </div>
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

        <DialogFooter className="border-t p-4 sm:justify-between">
          <div className="text-xs text-muted-foreground">Nothing changes until you press {confirmLabel}.</div>
          <div className="flex flex-wrap items-center gap-2">
            {footerExtra}
            <Button ref={cancelRef} variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={summary.selectedCount === 0 || submitting} loading={submitting} loadingText="Applying...">
              {confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
