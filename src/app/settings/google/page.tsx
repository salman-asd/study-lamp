"use client";

import * as React from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { getGoogleSyncStatus, toggleGoogleCalendar } from "@/lib/googleClient";
import type { GoogleSyncStatus } from "@/types";
import { CalendarRange, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const DEFAULT_COUNTS = {
  synced: 0,
  failed: 0,
  remoteDeleted: 0,
  noDate: 0,
  orphaned: 0,
};

export default function GoogleSettingsPage() {
  return (
    <RequireAuth>
      <GoogleSyncContent />
    </RequireAuth>
  );
}

function GoogleSyncContent() {
  const { user } = useAuth();
  const [status, setStatus] = React.useState<GoogleSyncStatus>({
    enabled: false,
    calendarName: null,
    lastSyncAt: null,
    counts: DEFAULT_COUNTS,
  });
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      setStatus(await getGoogleSyncStatus(idToken));
    } catch (error: any) {
      toast.error(error?.message || "Failed to load Google sync status.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { load(); }, [load]);

  async function handleConnect() {
    if (!user) return;
    setConnecting(true);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/google/auth/state", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ features: ["calendar"] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not start Google Calendar connection.");
      }
      window.location.assign(payload.url);
    } catch (error: any) {
      setConnecting(false);
      toast.error(error?.message || "Failed to start Google Calendar connection.");
    }
  }

  async function handleToggle(nextEnabled: boolean) {
    if (!user) return;
    const previous = status;
    setStatus((current) => ({ ...current, enabled: nextEnabled }));
    setSaving(true);
    try {
      const idToken = await user.getIdToken();
      const result = await toggleGoogleCalendar(idToken, nextEnabled);
      setStatus((current) => ({
        ...current,
        enabled: result.connection.enabled,
        calendarName: current.calendarName || null,
      }));
      toast.success(nextEnabled ? "Google Calendar sync enabled." : "Google Calendar sync disabled.");
    } catch (error: any) {
      setStatus(previous);
      toast.error(error?.message || "Failed to update Google sync.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold">Google sync</h1>
          <p className="text-sm text-muted-foreground">
            Study Lamp can preview goals in a dedicated Google Calendar and ask for confirmation before any write is applied.
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-accent/10 p-2">
                  <CalendarRange className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <h2 className="font-display text-base font-semibold">Calendar sync</h2>
                  <p className="text-sm text-muted-foreground">
                    Keep a dedicated Study Lamp calendar and require a preview-confirm-apply flow before creating or updating events.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={status.enabled ? "success" : "secondary"}>{status.enabled ? "Enabled" : "Off"}</Badge>
                <Switch checked={status.enabled} onCheckedChange={handleToggle} disabled={saving || loading || connecting} aria-label="Toggle Google Calendar sync" />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleConnect} disabled={connecting || loading || saving}>
                {connecting ? "Connecting…" : "Connect Google Calendar"}
              </Button>
              <Button variant="outline" onClick={load} disabled={loading || saving || connecting}>Refresh status</Button>
            </div>

            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-secondary/20 p-3 text-sm text-muted-foreground">
                  {status.enabled ? (
                    <div className="flex items-center gap-2 text-foreground">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span>
                        {status.calendarName ? `Connected to “${status.calendarName}”.` : "Google Calendar sync is enabled."}
                      </span>
                    </div>
                  ) : (
                    <span>Google Calendar sync is currently off. Connect your Google account and then enable the dedicated Study Lamp calendar.</span>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Last sync</div>
                    <div className="mt-1 text-sm font-medium">
                      {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "Not synced yet"}
                    </div>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Synced</div>
                    <div className="mt-1 text-sm font-medium">{status.counts.synced}</div>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Conflicts</div>
                    <div className="mt-1 text-sm font-medium">{status.counts.failed}</div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}