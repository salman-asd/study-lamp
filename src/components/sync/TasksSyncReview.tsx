"use client";

import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmChangesDialog } from "@/components/sync/ConfirmChangesDialog";
import type { TasksSyncController } from "@/components/sync/useTasksSync";

/** The review dialog for a Tasks plan (goals page). Nothing is written until the user presses Apply inside it. */
export function TasksSyncReview({ sync }: { sync: TasksSyncController }) {
  return (
    <ConfirmChangesDialog
      open={sync.dialogOpen}
      onOpenChange={sync.setDialogOpen}
      items={sync.plan?.items ?? []}
      service="Google Tasks"
      title="Review Google Tasks changes"
      confirmLabel="Apply changes"
      description="Study Lamp compared your goals with your Study Lamp task list. Tick what you want to apply. Nothing is changed in either place until you press Apply."
      onApply={sync.apply}
      footerExtra={
        <Button variant="ghost" onClick={() => void sync.check({ openDialog: true })} disabled={sync.checking}>
          Check again
        </Button>
      }
    />
  );
}

/** "N changes ready to review" bar for Tasks, or the "several connections" notice. Shows nothing when nothing is waiting. */
export function TasksSyncBanner({ sync }: { sync: TasksSyncController }) {
  if (sync.connectionProblem) {
    return (
      <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span>Google Tasks sync is on for more than one Google connection, so Study Lamp can&apos;t tell which to use. Keep it on for just one.</span>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/google">Open settings</Link>
        </Button>
      </div>
    );
  }
  if (!sync.enabled || sync.bannerCount === 0) return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-accent" aria-hidden="true" />
        Google Tasks: {sync.bannerCount} change{sync.bannerCount === 1 ? "" : "s"} ready to review
      </span>
      <Button size="sm" variant="outline" onClick={() => sync.setDialogOpen(true)}>
        Review
      </Button>
    </div>
  );
}
