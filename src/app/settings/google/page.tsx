"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarSyncCard } from "@/components/sync/CalendarSyncCard";
import { TasksSyncCard } from "@/components/sync/TasksSyncCard";
import { DisconnectGoogleDialog } from "@/components/sync/DisconnectGoogleDialog";
import { SyncCleanupCard } from "@/components/sync/SyncCleanupCard";
import { SyncHistoryCard } from "@/components/sync/SyncHistoryCard";
import { cacheSyncStateFromConnections } from "@/lib/googleCalendarFlag";
import { listGoogleConnections, startGoogleConnect } from "@/lib/googleClient";
import type { GoogleConnectionSummary, GoogleWorkspaceFeature } from "@/types";
import { CalendarRange, CheckCircle2, ListTodo, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

const FEATURE_LABELS: Record<GoogleWorkspaceFeature, string> = {
  calendar: "Calendar",
  tasks: "Tasks",
};

export default function GoogleWorkspaceSettingsPage() {
  return (
    <RequireAuth>
      <GoogleWorkspaceContent />
    </RequireAuth>
  );
}

function GoogleWorkspaceContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [connections, setConnections] = React.useState<GoogleConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [connecting, setConnecting] = React.useState<GoogleWorkspaceFeature | "reconnect" | null>(null);
  const [disconnectTarget, setDisconnectTarget] = React.useState<GoogleConnectionSummary | null>(null);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const list = await listGoogleConnections(idToken);
      setConnections(list);
      // Keep the cached "is Calendar / Tasks sync on, and for which connection?" state honest for the goals page.
      cacheSyncStateFromConnections(user.uid, list);
    } catch (error: any) {
      toast.error(error?.message || "Failed to load your Google Workspace connections.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  // The OAuth callback redirects back here with ?connected=<email>, ?error or
  // ?missing=<feature> — surface it once, then drop it from the URL.
  React.useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const missing = searchParams.get("missing");
    if (connected) toast.success(`Connected ${connected}`);
    if (missing) {
      const words = missing
        .split(",")
        .map((feature) => FEATURE_LABELS[feature as GoogleWorkspaceFeature] ?? feature)
        .join(" and ");
      toast.error(`You did not allow ${words} access, so that feature stays off.`);
    }
    if (error) toast.error(error);
    if (connected || error || missing) {
      const url = new URL(window.location.href);
      url.searchParams.delete("connected");
      url.searchParams.delete("error");
      url.searchParams.delete("missing");
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  /** Starts the flow for exactly one feature so access is granted incrementally. */
  async function handleGrant(feature: GoogleWorkspaceFeature, label: string) {
    if (!user) return;
    setConnecting(feature);
    try {
      const idToken = await user.getIdToken();
      await startGoogleConnect(idToken, [feature]); // navigates away to Google
    } catch (error: any) {
      toast.error(error?.message || `Failed to start connecting Google ${label}.`);
      setConnecting(null);
    }
  }

  async function handleReconnect(connection: GoogleConnectionSummary) {
    if (!user) return;
    // Re-request everything this connection already has so a single consent
    // fixes an "invalid" state without losing existing permissions.
    const features = connection.grantedScopes.length > 0 ? connection.grantedScopes : (["calendar"] as GoogleWorkspaceFeature[]);
    setConnecting("reconnect");
    try {
      const idToken = await user.getIdToken();
      await startGoogleConnect(idToken, features); // navigates away to Google
    } catch (error: any) {
      toast.error(error?.message || "Failed to start reconnecting Google.");
      setConnecting(null);
    }
  }

  /** Runs after the dialog finished (any optional removal first, then the disconnect itself). */
  function handleDisconnected(connection: GoogleConnectionSummary, removed: number) {
    if (!user) return;
    const remaining = connections.filter((c) => c.id !== connection.id);
    setConnections(remaining);
    cacheSyncStateFromConnections(user.uid, remaining);
    toast.success(removed > 0 ? `Removed ${removed} item${removed === 1 ? "" : "s"} from Google and disconnected.` : "Disconnected. Anything already in Google was left untouched.");
  }

  const busy = connecting !== null;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Google Workspace</h1>
          <p className="text-sm text-muted-foreground">
            Connect Google Calendar and Tasks so Study Lamp can keep your study goals in step. It reads to check for
            changes, and writes only after you confirm — nothing is changed automatically.
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-start gap-2.5">
              <div className="rounded-md bg-accent/10 p-2">
                <CalendarRange className="h-5 w-5 text-accent" />
              </div>
              <div>
                <h2 className="font-display text-base font-semibold">Connected accounts</h2>
                <p className="text-sm text-muted-foreground">
                  Study Lamp only uses the permissions you allow below. It never reads or edits your other calendars, and
                  unchecking a permission on Google&apos;s screen simply means that feature stays off.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => handleGrant("calendar", "Calendar")}
                disabled={busy || loading}
                loading={connecting === "calendar"}
                loadingText="Redirecting…"
              >
                <CalendarRange className="h-4 w-4" /> Allow Calendar access
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => handleGrant("tasks", "Tasks")}
                disabled={busy || loading}
                loading={connecting === "tasks"}
                loadingText="Redirecting…"
              >
                <ListTodo className="h-4 w-4" /> Allow Tasks access
              </Button>
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={load} disabled={busy || loading}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </Button>
            </div>

            {loading && (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
              </div>
            )}

            {!loading && connections.length === 0 && (
              <div className="space-y-1 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">No Google account connected yet</p>
                <p>Allow Calendar or Tasks access above to get started.</p>
              </div>
            )}

            {!loading && connections.map((connection) => (
              <div key={connection.id} className="space-y-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{connection.googleEmail}</span>
                      {connection.status === "invalid" ? (
                        <Badge variant="destructive">Needs reconnect</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : "Not used yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {connection.status === "invalid" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => handleReconnect(connection)}
                        disabled={busy}
                        loading={connecting === "reconnect"}
                      >
                        <RefreshCw className="h-4 w-4" /> Reconnect
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDisconnectTarget(connection)}
                      aria-label={`Disconnect ${connection.googleEmail}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {(["calendar", "tasks"] as const).map((feature) => {
                    const granted = connection.grantedScopes.includes(feature);
                    return (
                      <span
                        key={feature}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs"
                      >
                        {granted ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className={granted ? "text-foreground" : "text-muted-foreground"}>
                          {FEATURE_LABELS[feature]} {granted ? "allowed" : "not allowed"}
                        </span>
                      </span>
                    );
                  })}
                </div>

                <CalendarSyncCard connection={connection} onChanged={load} />
                <TasksSyncCard connection={connection} onChanged={load} />
                <SyncCleanupCard connection={connection} onChanged={load} />
              </div>
            ))}
          </CardContent>
        </Card>

        {!loading && connections.length > 0 && <SyncHistoryCard />}
      </div>

      <DisconnectGoogleDialog
        connection={disconnectTarget}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        onDisconnected={handleDisconnected}
      />
    </AppShell>
  );
}