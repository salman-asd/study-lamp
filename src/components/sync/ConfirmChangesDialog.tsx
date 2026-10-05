"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { PlanItem } from "@/lib/sync/plan";
import { cn } from "@/lib/utils";

export type ConfirmResolution = "use_study_lamp" | "use_google" | "skip" | "unlink" | "recreate" | "delete_goal";

export interface ConfirmChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PlanItem[];
  title?: string;
  confirmLabel?: string;
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

export function ConfirmChangesDialog({
  open,
  onOpenChange,
  items,
  title = "Review changes",
  confirmLabel = "Apply",
  onApply,
}: ConfirmChangesDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => getDefaultSelectedItemIds(items));
  const [resolutions, setResolutions] = useState<Record<string, ConfirmResolution>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSelectedIds(getDefaultSelectedItemIds(items));
    setResolutions({});
    setSubmitting(false);
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
    try {
      await onApply({ accepted, resolutions, confirmedDestructive });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <div className="p-6 pb-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Review the proposed changes before anything is written. Nothing changes until you press Apply.
            </DialogDescription>
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
                const currentResolution = resolutions[item.itemId] ?? (isConflict ? "skip" : "use_study_lamp");

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

                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {item.fields.map((field) => (
                            <div key={`${item.itemId}-${field.name}`} className="flex justify-between gap-3">
                              <span>{field.name}</span>
                              <span>{String(field.before ?? "—")} → {String(field.after ?? "—")}</span>
                            </div>
                          ))}
                        </div>

                        {isConflict && (
                          <div className="mt-3">
                            <Label htmlFor={`resolution-${item.itemId}`} className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
                              Resolution
                            </Label>
                            <select
                              id={`resolution-${item.itemId}`}
                              value={currentResolution}
                              onChange={(event) => setResolutions((prev) => ({ ...prev, [item.itemId]: event.target.value as ConfirmResolution }))}
                              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                            >
                              <option value="skip">Skip</option>
                              <option value="use_study_lamp">Use Study Lamp</option>
                              <option value="use_google">Use Google</option>
                            </select>
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

        <DialogFooter className="border-t p-4 sm:justify-between">
          <div className="text-xs text-muted-foreground">Nothing changes until you press Apply.</div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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
