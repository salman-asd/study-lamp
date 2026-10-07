"use client";

import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmChangesDialog } from "@/components/sync/ConfirmChangesDialog";
import type { CalendarSyncController } from "@/components/sync/useCalendarSync";

/** The review dialog for a Calendar plan. Nothing is written until the user presses Apply inside it. */
export function CalendarSyncReview({ sync }: { sync: CalendarSyncController }) {
  return (
    <ConfirmChangesDialog
      open={sync.dialogOpen}
      onOpenChange={sync.setDialogOpen}
      items={sync.plan?.items ?? []}
      title="Review Google Calendar changes"
      confirmLabel="Apply changes"
      description="Study Lamp compared your goals with your Study Lamp calendar. Tick what you want to apply. Nothing is changed in either place until you press Apply."
      onApply={sync.apply}
      footerExtra={
        <Button variant="ghost" onClick={() => void sync.checkAll({ force: true, openDialog: true })} disabled={sync.checking}>
          Check again
        </Button>
      }
    />
  );
}

/** "N changes ready to review" bar. Shows nothing when nothing is waiting. */
export function CalendarSyncBanner({ sync }: { sync: CalendarSyncController }) {
  // Several connections with Calendar on: say so instead of quietly checking nothing (audit M2).
  if (sync.connectionProblem) {
    return (
      <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span>Google Calendar sync is on for more than one Google connection, so Study Lamp can&apos;t tell which to use. Keep it on for just one.</span>
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
        <CalendarRange className="h-4 w-4 text-accent" aria-hidden="true" />
        Google Calendar: {sync.bannerCount} change{sync.bannerCount === 1 ? "" : "s"} ready to review
      </span>
      <Button size="sm" variant="outline" onClick={() => sync.setDialogOpen(true)}>
        Review
      </Button>
    </div>
  );
}
