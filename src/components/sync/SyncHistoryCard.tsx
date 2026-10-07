"use client";

import * as React from "react";
import { History } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { getGoogleSyncHistory } from "@/lib/googleClient";
import { describeHistoryEntry } from "@/lib/syncHistoryFormat";
import type { GoogleSyncHistoryEntry } from "@/types";

/** Read-only "Recent changes" (W5). Loads the newest 50 on first open and more on request. No undo button. */
export function SyncHistoryCard() {
  const { user } = useAuth();
  const [entries, setEntries] = React.useState<GoogleSyncHistoryEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (next?: string) => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const page = await getGoogleSyncHistory(await user.getIdToken(), next);
      setEntries((current) => (next ? [...current, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "Couldn't load the recent changes.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  return (
    <details
      className="rounded-md border border-border p-3 text-sm"
      onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !loaded && !loading) void load(); }}
    >
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <History className="h-4 w-4 text-accent" aria-hidden="true" /> Recent changes
      </summary>
      <div className="mt-3 space-y-2" aria-live="polite">
        <p className="text-xs text-muted-foreground">What Study Lamp changed, in either direction, after you confirmed it. This is a record only.</p>
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        {loaded && entries.length === 0 && !error && <p className="text-xs text-muted-foreground">Nothing has been changed yet.</p>}
        <ul className="space-y-2">
          {entries.map((entry, index) => {
            const line = describeHistoryEntry(entry);
            return (
              <li key={`${entry.at}-${index}`} className="rounded border border-border p-2">
                <p className="font-medium">{line.title}</p>
                <p className="text-xs text-muted-foreground">{line.meta}</p>
                {line.changes.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                    {line.changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {loading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {cursor && !loading && (
          <Button size="sm" variant="outline" onClick={() => void load(cursor)}>
            Show older changes
          </Button>
        )}
      </div>
    </details>
  );
}
