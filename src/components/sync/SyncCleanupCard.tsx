"use client";

import * as React from "react";
import { Eraser } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/sync/ConfirmActionDialog";
import { applyGoogleRemoval, GoogleRemovalCountChangedError, previewGoogleRemoval } from "@/lib/googleClient";
import { describeRemovalCount, type RemovalPreviewResult, type RemovalScope, type RemovalTarget } from "@/lib/googleRemovalFlow";
import type { GoogleConnectionSummary } from "@/types";

interface Review {
  orphans: RemovalPreviewResult;
  all: RemovalPreviewResult;
}

/**
 * "Clean up Google" for one connection (W5). Lists what Study Lamp created whose goal was deleted (orphans) and offers
 * to remove them, or everything. Looking is read-only; removing needs the confirmation dialog, which sends the exact
 * number the user was shown. Nothing here runs by itself.
 */
export function SyncCleanupCard({ connection, onChanged }: { connection: GoogleConnectionSummary; onChanged?: () => void }) {
  const { user } = useAuth();
  const targets = (["calendar", "tasks"] as const).filter((target) => connection.grantedScopes.includes(target));
  const [reviews, setReviews] = React.useState<Partial<Record<RemovalTarget, Review>>>({});
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<{ target: RemovalTarget; scope: RemovalScope } | null>(null);

  const usable = connection.status === "active" && targets.length > 0;

  const review = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      const idToken = await user.getIdToken();
      const next: Partial<Record<RemovalTarget, Review>> = {};
      for (const target of targets) {
        const [orphans, all] = await Promise.all([
          previewGoogleRemoval(idToken, { target, scope: "orphans", connectionId: connection.id }),
          previewGoogleRemoval(idToken, { target, scope: "all", connectionId: connection.id }),
        ]);
        next[target] = { orphans, all };
      }
      setReviews(next);
    } catch (error) {
      setLoadError(error instanceof Error && error.message ? error.message : "Couldn't look at what Study Lamp created.");
    } finally {
      setLoading(false);
    }
    // targets is derived from connection.grantedScopes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, connection.id, connection.grantedScopes]);

  async function runRemoval({ target, scope }: { target: RemovalTarget; scope: RemovalScope }) {
    if (!user) return;
    const shown = reviews[target]?.[scope === "orphans" ? "orphans" : "all"];
    if (!shown || shown.count === 0) throw new Error("Nothing to remove. Review again.");
    const idToken = await user.getIdToken();
    try {
      const result = await applyGoogleRemoval(idToken, { planToken: shown.planToken, confirmCount: shown.count, target, scope, connectionId: connection.id });
      if (result.failed > 0 || result.skipped > 0) {
        await review();
        throw new Error(`${result.applied} removed, ${result.failed + result.skipped} could not be removed. Review and try again.`);
      }
      toast.success(`Removed ${describeRemovalCount(target, result.applied)} from Google.`);
      await review();
      onChanged?.();
    } catch (error) {
      if (error instanceof GoogleRemovalCountChangedError) {
        await review();
        throw new Error(`The number changed to ${error.count}. Nothing was removed. Please review and confirm again.`);
      }
      throw error;
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2">
          <Eraser className="mt-0.5 h-4 w-4 text-accent" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Clean up Google</p>
            <p className="text-xs text-muted-foreground">See what Study Lamp created and remove it if you want. Nothing is removed unless you confirm.</p>
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={!usable} loading={loading} loadingText="Looking…" onClick={() => void review()}>
          Review
        </Button>
      </div>

      {loadError && <p role="alert" className="text-xs text-red-700">{loadError}</p>}

      {targets.map((target) => {
        const item = reviews[target];
        if (!item) return null;
        const label = target === "calendar" ? "Calendar" : "Tasks";
        const orphanTitles = item.orphans.items.slice(0, 10);
        return (
          <div key={target} className="space-y-1.5 border-t border-border pt-2 text-xs">
            <p className="font-medium">
              {label}: {item.all.count === 0 ? "nothing created by Study Lamp" : `${describeRemovalCount(target, item.all.count)} created by Study Lamp`}
              {item.all.remaining > 0 ? ` (and ${item.all.remaining} more)` : ""}
            </p>
            {item.orphans.count > 0 && (
              <div>
                <p className="text-muted-foreground">
                  {describeRemovalCount(target, item.orphans.count)} belong to goals you deleted:
                </p>
                <ul className="list-disc pl-4 text-muted-foreground">
                  {orphanTitles.map((entry) => <li key={entry.itemId}>{entry.title}</li>)}
                  {item.orphans.count > orphanTitles.length && <li>…and {item.orphans.count - orphanTitles.length} more</li>}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={item.orphans.count === 0} onClick={() => setPending({ target, scope: "orphans" })}>
                Remove {item.orphans.count} from deleted goals
              </Button>
              <Button size="sm" variant="outline" disabled={item.all.count === 0} onClick={() => setPending({ target, scope: "all" })}>
                Remove all {item.all.count}
              </Button>
            </div>
          </div>
        );
      })}

      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title={pending ? `Remove ${describeRemovalCount(pending.target, reviews[pending.target]?.[pending.scope === "orphans" ? "orphans" : "all"]?.count ?? 0)} from Google?` : "Remove from Google?"}
        description={
          pending
            ? `This deletes ${pending.scope === "orphans" ? "the items that belong to goals you deleted" : "everything Study Lamp created"} from ${pending.target === "calendar" ? "your Study Lamp calendar" : "your Study Lamp task list"} in ${connection.googleEmail}. Only items Study Lamp recorded are touched, and your goals here are not changed. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove from Google"
        destructive
        onConfirm={async () => { if (pending) await runRemoval(pending); }}
      />
    </div>
  );
}
