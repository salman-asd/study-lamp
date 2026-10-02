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
import { backfillDriveThumbnails, listDriveConnections, disconnectDrive, startDriveConnect } from "@/lib/driveClient";
import type { DriveConnectionSummary } from "@/types";
import { HardDrive, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function DriveSettingsPage() {
  return (
    <RequireAuth>
      <DriveSettingsContent />
    </RequireAuth>
  );
}

function DriveSettingsContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [connecting, setConnecting] = React.useState(false);
  const [disconnectingId, setDisconnectingId] = React.useState<string | null>(null);
  const [refreshingThumbnails, setRefreshingThumbnails] = React.useState(false);
  const [thumbnailsRemaining, setThumbnailsRemaining] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      setConnections(await listDriveConnections(idToken));
    } catch (error: any) {
      toast.error(error?.message || "Failed to load your Google Drive connections.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  // The OAuth callback redirects back here with ?connected=<email> or
  // ?error=<message> — surface it once, then drop it from the URL so a
  // refresh doesn't re-show the toast.
  React.useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (connected) toast.success(`Connected ${connected}`);
    if (error) toast.error(error);
    if (connected || error) {
      const url = new URL(window.location.href);
      url.searchParams.delete("connected");
      url.searchParams.delete("error");
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  async function handleConnect() {
    if (!user) return;
    setConnecting(true);
    try {
      const idToken = await user.getIdToken();
      await startDriveConnect(idToken); // navigates away to Google
    } catch (error: any) {
      toast.error(error?.message || "Failed to start connecting Google Drive.");
      setConnecting(false);
    }
  }

  async function handleDisconnect(connection: DriveConnectionSummary) {
    if (!user) return;
    if (!confirm(`Disconnect ${connection.googleEmail}? Videos and documents already imported from it will stop playing until you reconnect.`)) return;
    setDisconnectingId(connection.id);
    try {
      const idToken = await user.getIdToken();
      await disconnectDrive(idToken, connection.id);
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
      toast.success("Disconnected. Nothing was deleted from your Drive.");
    } catch (error: any) {
      toast.error(error?.message || "Failed to disconnect.");
    } finally {
      setDisconnectingId(null);
    }
  }

  async function handleRefreshThumbnails() {
    if (!user || refreshingThumbnails) return;
    setRefreshingThumbnails(true);
    setThumbnailsRemaining(null);
    let processed = 0;
    try {
      const idToken = await user.getIdToken();
      let remaining = 1;
      while (remaining > 0) {
        const batch = await backfillDriveThumbnails(idToken);
        processed += batch.processed;
        remaining = batch.remaining;
        setThumbnailsRemaining(remaining);
      }
      toast.success(processed ? `Refreshed ${processed} Drive thumbnails.` : "Drive thumbnails are up to date.");
    } catch (error: any) {
      toast.error(error?.message || "Failed to refresh Drive thumbnails.");
    } finally {
      setRefreshingThumbnails(false);
      setThumbnailsRemaining(null);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Google Drive</h1>
          <p className="text-sm text-muted-foreground">
            Link one or more Google accounts to pick videos and documents from Drive, upload new ones, and back up your
            library — independent of the Google account you log into Study Lamp with.
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <div>
                  <h2 className="font-display text-base font-semibold">Connected accounts</h2>
                  <p className="text-sm text-muted-foreground">
                    Study Lamp only ever sees files you explicitly pick or upload (the narrow &quot;drive.file&quot; permission) —
                    never your whole Drive.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {connections.some((connection) => connection.status !== "invalid") && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={handleRefreshThumbnails} disabled={refreshingThumbnails}>
                    <RefreshCw className={`h-4 w-4 ${refreshingThumbnails ? "animate-spin" : ""}`} />
                    {refreshingThumbnails ? `Refreshing${thumbnailsRemaining === null ? "…" : ` (${thumbnailsRemaining} left)`}` : "Refresh thumbnails"}
                  </Button>
                )}
                <Button size="sm" className="gap-1.5" onClick={handleConnect} loading={connecting} loadingText="Redirecting…">
                  <Plus className="h-4 w-4" /> Connect Google Drive
                </Button>
              </div>
            </div>

            {loading && (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
              </div>
            )}

            {!loading && connections.length === 0 && (
              <div className="space-y-1 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">No Google account connected yet</p>
                <p>Connect one to pick videos/folders from Drive, upload new videos, or back up your library.</p>
              </div>
            )}

            {!loading && connections.map((connection) => (
              <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{connection.googleEmail}</span>
                    {connection.status === "invalid" ? (
                      <Badge variant="destructive">Needs reconnecting</Badge>
                    ) : (
                      <Badge variant="success">Connected</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {connection.lastUsedAt ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}` : "Not used yet"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDisconnect(connection)}
                  aria-label="Disconnect"
                  loading={disconnectingId === connection.id}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        {connections.some((c) => c.status !== "invalid") && (
          <Card>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div>
                <h2 className="font-display text-base font-semibold">Backups</h2>
                <p className="mt-1 text-sm text-muted-foreground">Save a portable copy of your library to Drive, or restore from one.</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a href="/settings/backup">Open backups</a>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
