"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  listDriveConnections, createDriveBackup, listDriveBackups,
  previewDriveRestore, confirmDriveRestore, type BackupSummary, type RestorePreview,
} from "@/lib/driveClient";
import {
  backupErrorMessage,
  isReconnectError,
  markConnectionInvalid,
  pickBackupConnection,
  shouldShowReconnectAlert,
} from "@/lib/backupConnections";
import type { DriveConnectionSummary } from "@/types";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export default function BackupPage() {
  return (
    <RequireAuth>
      <BackupContent />
    </RequireAuth>
  );
}

function BackupContent() {
  const { user } = useAuth();
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [backups, setBackups] = React.useState<{ fileId: string; name: string }[]>([]);
  const [backingUp, setBackingUp] = React.useState(false);
  const [loadingBackups, setLoadingBackups] = React.useState(false);
  const [pendingRestore, setPendingRestore] = React.useState<{ fileId: string; name: string; preview: RestorePreview } | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const [connectionsLoaded, setConnectionsLoaded] = React.useState(false);
  // Set when a Drive call answered "reconnect" (Google rejected the saved permission).
  const [reconnectRequested, setReconnectRequested] = React.useState(false);

  /** Shows the reconnect alert (not a raw error) and flags the connection locally; true when it handled the error. */
  const handleReconnectError = React.useCallback((error: unknown, cid: string | null): boolean => {
    if (!isReconnectError(error)) return false;
    setReconnectRequested(true);
    if (cid) setConnections((current) => markConnectionInvalid(current, cid));
    return true;
  }, []);

  const loadBackups = React.useCallback(async (cid: string) => {
    if (!user) return;
    setLoadingBackups(true);
    try {
      const idToken = await user.getIdToken();
      setBackups(await listDriveBackups(idToken, cid));
    } catch (error: unknown) {
      if (!handleReconnectError(error, cid)) toast.error(backupErrorMessage(error, "Failed to list backups."));
    } finally {
      setLoadingBackups(false);
    }
  }, [user, handleReconnectError]);

  React.useEffect(() => {
    (async () => {
      if (!user) return;
      const idToken = await user.getIdToken();
      const list = await listDriveConnections(idToken).catch(() => []);
      // Rejected connections stay in the list (with a badge) so the page says "reconnect", not "no connection".
      setConnections(list);
      setConnectionsLoaded(true);
      const first = pickBackupConnection(list);
      if (first) {
        setConnectionId(first.id);
        loadBackups(first.id);
      }
    })();
  }, [user, loadBackups]);

  async function handleBackupNow() {
    if (!user || !connectionId) return;
    setBackingUp(true);
    try {
      const idToken = await user.getIdToken();
      const result: BackupSummary = await createDriveBackup(idToken, connectionId);
      toast.success(`Backed up ${result.counts?.playlists ?? 0} playlists and ${result.counts?.videos ?? 0} videos to Drive.`);
      loadBackups(connectionId);
    } catch (error: unknown) {
      if (!handleReconnectError(error, connectionId)) toast.error(backupErrorMessage(error, "Backup failed."));
    } finally {
      setBackingUp(false);
    }
  }

  async function handleChooseRestore(backup: { fileId: string; name: string }) {
    if (!user || !connectionId) return;
    try {
      const idToken = await user.getIdToken();
      const preview = await previewDriveRestore(idToken, connectionId, backup.fileId);
      setPendingRestore({ fileId: backup.fileId, name: backup.name, preview });
    } catch (error: unknown) {
      if (!handleReconnectError(error, connectionId)) toast.error(backupErrorMessage(error, "Couldn't read that backup."));
    }
  }

  async function handleConfirmRestore() {
    if (!user || !connectionId || !pendingRestore) return;
    setRestoring(true);
    try {
      const idToken = await user.getIdToken();
      const result = await confirmDriveRestore(idToken, connectionId, pendingRestore.fileId);
      toast.success(`Restored ${result.playlistsToRestore} playlists and ${result.videosToRestore} videos.`);
      setPendingRestore(null);
    } catch (error: unknown) {
      setPendingRestore(null);
      if (!handleReconnectError(error, connectionId)) toast.error(backupErrorMessage(error, "Restore failed."));
    } finally {
      setRestoring(false);
    }
  }

  const activeConnection = connections.find((connection) => connection.id === connectionId) ?? null;
  const canUseBackups = activeConnection !== null && activeConnection.status !== "invalid";
  const showReconnectAlert = shouldShowReconnectAlert(connections, reconnectRequested);

  if (connectionsLoaded && connections.length === 0) {
    return (
      <AppShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <h1 className="font-display text-2xl font-semibold">Backups</h1>
          <p className="text-sm text-muted-foreground">Connect a Google Drive account first — see Settings → Google.</p>
          <Button asChild variant="outline" size="sm"><a href="/settings/google#drive">Go to Google settings</a></Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Backups</h1>
          <p className="text-sm text-muted-foreground">
            A backup is a plain JSON snapshot of your playlists, videos, notes, summaries, goals and quiz history, saved
            to a &quot;Study Lamp Backups&quot; folder in your connected Drive.
          </p>
        </div>

        {showReconnectAlert && (
          <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">Google needs to be reconnected</p>
                <p className="text-muted-foreground">Google rejected the saved permission, so backups can&apos;t be listed or created until you reconnect. Nothing was deleted.</p>
              </div>
            </div>
            <Button asChild size="sm" variant="outline"><a href="/settings/google#drive">Reconnect Google</a></Button>
          </div>
        )}

        {connections.length > 0 && (
          <ul className="space-y-1.5" aria-label="Google accounts">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="break-all">{connection.googleEmail}</span>
                {connection.status === "invalid" ? <Badge variant="destructive">Needs reconnect</Badge> : <Badge variant="success">Connected</Badge>}
              </li>
            ))}
          </ul>
        )}

        <Card>
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <h2 className="font-display text-base font-semibold">Back up now</h2>
              <p className="mt-1 text-sm text-muted-foreground">Creates a new snapshot — it never overwrites a previous one.</p>
            </div>
            <Button onClick={handleBackupNow} loading={backingUp} loadingText="Backing up…" disabled={!canUseBackups}>Back up now</Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="font-display text-base font-semibold">Restore</h2>
            {loadingBackups && <p className="text-sm text-muted-foreground">Loading backups…</p>}
            {!loadingBackups && backups.length === 0 && <p className="text-sm text-muted-foreground">{canUseBackups ? "No backups yet." : "Reconnect Google to see your backups."}</p>}
            {backups.map((backup) => (
              <div key={backup.fileId} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <span className="min-w-0 truncate text-sm">{backup.name}</span>
                <Button variant="outline" size="sm" onClick={() => handleChooseRestore(backup)} disabled={!canUseBackups}>Restore…</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!pendingRestore} onOpenChange={(open) => !open && setPendingRestore(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore &quot;{pendingRestore?.name}&quot;?</DialogTitle>
          </DialogHeader>
          {pendingRestore && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                This only adds back what&apos;s currently missing — anything you still have is left untouched, nothing is
                overwritten.
              </p>
              <ul className="list-inside list-disc space-y-1">
                <li>{pendingRestore.preview.playlistsToRestore} playlists ({pendingRestore.preview.videosToRestore} videos)</li>
                <li>{pendingRestore.preview.notesToRestore} notes</li>
                <li>{pendingRestore.preview.summariesToRestore} summaries</li>
                <li>{pendingRestore.preview.goalsToRestore} goals</li>
                <li>{pendingRestore.preview.quizAttemptsToRestore} quiz attempts</li>
              </ul>
              {pendingRestore.preview.playlistTitles.length > 0 && (
                <p className="text-xs text-muted-foreground">Playlists: {pendingRestore.preview.playlistTitles.join(", ")}</p>
              )}
              {pendingRestore.preview.playlistsToRestore === 0 && pendingRestore.preview.notesToRestore === 0 && (
                <p className="text-xs text-muted-foreground">Everything in this backup already exists — restoring will do nothing.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>Cancel</Button>
            <Button onClick={handleConfirmRestore} loading={restoring} loadingText="Restoring…">Confirm restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
