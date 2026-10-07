"use client";

import * as React from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmActionDialog } from "@/components/sync/ConfirmActionDialog";
import { ConfirmChangesDialog } from "@/components/sync/ConfirmChangesDialog";
import { describeCounts } from "@/components/sync/CalendarSyncCard";
import { useTasksSync } from "@/components/sync/useTasksSync";
import { getGoogleTasksStatus, toggleGoogleTasks } from "@/lib/googleClient";
import type { GoogleConnectionSummary, GoogleTasksStatus } from "@/types";

/** What Study Lamp does with each goal field. Shown to the user so nothing about sync is a surprise. */
export const TASKS_SYNC_ROWS: Array<{ what: string; how: string }> = [
  { what: "Title", how: "Both ways, after you confirm" },
  { what: "Due date", how: "Both ways, after you confirm. Removing the due date in Google clears it on the goal" },
  { what: "Completed", how: "Both ways, after you confirm" },
  { what: "Notes and priority", how: "Study Lamp → Google only (written into the task notes, never read back)" },
  { what: "Deleting a goal or a task", how: "Never synced. A deletion is only ever done if you choose it" },
];

export function TasksSyncCard({ connection, onChanged }: { connection: GoogleConnectionSummary; onChanged?: () => void }) {
  const { user } = useAuth();
  const hasTasks = connection.grantedScopes.includes("tasks");
  const usable = hasTasks && connection.status === "active";
  const [enabled, setEnabled] = React.useState(connection.tasksEnabled);
  const [status, setStatus] = React.useState<GoogleTasksStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [enableOpen, setEnableOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);

  const refreshStatus = React.useCallback(async () => {
    if (!user || !usable) return;
    try {
      setStatus(await getGoogleTasksStatus(await user.getIdToken(), connection.id));
      setStatusError(null);
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error && error.message ? error.message : "Couldn't load the sync status.");
    }
  }, [user, usable, connection.id]);

  const sync = useTasksSync({ connectionId: connection.id, onApplied: () => { void refreshStatus(); } });

  React.useEffect(() => { setEnabled(connection.tasksEnabled); }, [connection.tasksEnabled]);
  React.useEffect(() => { if (enabled) void refreshStatus(); else setStatus(null); }, [enabled, refreshStatus]);

  async function setTasksEnabled(next: boolean) {
    if (!user) return;
    setSwitching(true);
    try {
      await toggleGoogleTasks(await user.getIdToken(), connection.id, next);
      setEnabled(next);
      toast.success(next ? "Tasks sync is on. Nothing has been written yet." : "Tasks sync is off. Nothing in Google was changed.");
      onChanged?.();
    } catch (error) {
      // Includes "the list was deleted in Google": the switch stays where it was.
      toast.error(error instanceof Error && error.message ? error.message : "Couldn't change Tasks sync.");
      throw error;
    } finally {
      setSwitching(false);
    }
  }

  if (!hasTasks) {
    return <p className="text-xs text-muted-foreground">Allow Tasks access above to sync goals with Google Tasks.</p>;
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ListChecks className="mt-0.5 h-4 w-4 text-accent" aria-hidden="true" />
          <div>
            <label htmlFor={`gtasks-switch-${connection.id}`} className="text-sm font-medium">Sync goals with Tasks</label>
            <p className="text-xs text-muted-foreground">
              {enabled ? `Using the “${status?.listName ?? "Study Lamp"}” list.` : "Off. Study Lamp doesn't touch your tasks."}
            </p>
          </div>
        </div>
        <Switch
          id={`gtasks-switch-${connection.id}`}
          checked={enabled}
          disabled={!usable || switching}
          onCheckedChange={(next) => {
            if (next) setEnableOpen(true);
            else void setTasksEnabled(false).catch(() => undefined);
          }}
          aria-label="Sync goals with Google Tasks"
        />
      </div>

      {!usable && connection.status === "invalid" && <p className="text-xs text-red-700">This connection needs to be reconnected before Tasks sync can be used.</p>}

      {enabled && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground" aria-live="polite">
              {statusError ? <span className="text-red-700">{statusError}</span> : status ? describeCounts(status.counts) : "Loading status…"}
              {status?.lastSyncAt ? ` · Last applied ${new Date(status.lastSyncAt).toLocaleString()}` : status ? " · Nothing applied yet" : ""}
            </div>
            <Button size="sm" variant="outline" className="gap-1.5" loading={sync.checking} loadingText="Checking…" onClick={() => void sync.check({ openDialog: true, announceEmpty: true })}>
              <RefreshCw className="h-3.5 w-3.5" /> Check for changes
            </Button>
          </div>

          {sync.plan && sync.bannerCount > 0 && !sync.dialogOpen && (
            <button type="button" className="text-left text-xs text-accent underline" onClick={() => sync.setDialogOpen(true)}>
              {sync.bannerCount} change{sync.bannerCount === 1 ? "" : "s"} ready to review
            </button>
          )}

          {sync.lastOutcome && (
            <div role="status" className={sync.lastOutcome.tone === "error" ? "rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200" : sync.lastOutcome.tone === "warning" ? "rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"}>
              <p>{sync.lastOutcome.message}</p>
              {sync.lastOutcome.details.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {sync.lastOutcome.details.map((text) => <li key={text}>{text}</li>)}
                </ul>
              )}
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">What syncs</summary>
            <table className="mt-2 w-full text-left">
              <tbody>
                {TASKS_SYNC_ROWS.map((row) => (
                  <tr key={row.what} className="border-t border-border align-top">
                    <th scope="row" className="w-2/5 py-1 pr-2 font-medium">{row.what}</th>
                    <td className="py-1 text-muted-foreground">{row.how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <ConfirmActionDialog
        open={enableOpen}
        onOpenChange={setEnableOpen}
        title="Turn on Google Tasks sync?"
        description={`Study Lamp will create a new task list called “Study Lamp” in ${connection.googleEmail}. It never looks at or changes your other lists. Turning this on writes no tasks: every change is shown to you first, and only the ones you tick are applied.`}
        confirmLabel="Turn on"
        onConfirm={() => setTasksEnabled(true)}
      />

      <ConfirmChangesDialog
        open={sync.dialogOpen}
        onOpenChange={sync.setDialogOpen}
        items={sync.plan?.items ?? []}
        service="Google Tasks"
        title="Review Google Tasks changes"
        confirmLabel="Apply changes"
        description="Study Lamp compared your goals with your Study Lamp task list. Tick what you want to apply. Nothing is changed in either place until you press Apply."
        onApply={sync.apply}
        footerExtra={<Button variant="ghost" onClick={() => void sync.check({ openDialog: true })} disabled={sync.checking}>Check again</Button>}
      />
    </div>
  );
}
