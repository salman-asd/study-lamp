"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { DrivePickerButton, type DrivePickerSelection } from "@/components/drive/DrivePickerButton";
import type { DrivePickerKind } from "@/lib/driveMime";
import {
  listDriveConnections, importDriveFile, importDriveFolder,
  startDriveUploadSession, uploadFileToDrive,
} from "@/lib/driveClient";
import type { DriveConnectionSummary } from "@/types";
import { toast } from "sonner";
import { UploadCloud } from "lucide-react";

/**
 * The "Google Drive" tab inside Save Video / Study Materials import dialogs
 * (Phases 14 & 15). Two ways in: pick an existing file/folder via the
 * Google Picker, or upload a new file straight to Drive. Both end at the
 * same /api/drive/import/file (or /folder) call, so the caller only needs
 * one onImported callback regardless of which path was used.
 */
export function DriveImportPanel({
  playlistId,
  onImported,
  accept,
  allowFolders = true,
  kinds,
}: {
  /** Target playlist for a picked/uploaded *video*. Documents ignore this. */
  playlistId?: string;
  onImported: () => void;
  /** Restricts the upload <input>'s file picker; Picker itself always shows
   *  both videos and documents since Google doesn't let us filter by our
   *  own mime allowlist there. */
  accept?: string;
  /** Study Materials passes false — folder import only knows how to create
   *  a video playlist today (see /api/drive/import/folder), so offering
   *  folder selection there would silently do the wrong thing. */
  allowFolders?: boolean;
  kinds?: DrivePickerKind[];
}) {
  const { user } = useAuth();
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = React.useState<string | null>(null);
  const [loadingConnections, setLoadingConnections] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    (async () => {
      if (!user) return;
      try {
        const idToken = await user.getIdToken();
        const list = (await listDriveConnections(idToken)).filter((c) => c.status !== "invalid");
        setConnections(list);
        if (list[0]) setConnectionId(list[0].id);
      } finally {
        setLoadingConnections(false);
      }
    })();
  }, [user]);

  async function handlePicked(selections: DrivePickerSelection[] | DrivePickerSelection) {
    const items = Array.isArray(selections) ? selections : [selections];
    if (!user || !connectionId || items.length === 0) return;
    setBusy(true);
    try {
      const idToken = await user.getIdToken();
      const importedFiles: string[] = [];
      const importedFolders: string[] = [];

      for (const selection of items) {
        if (selection.isFolder) {
          const result = await importDriveFolder(idToken, { connectionId, folderId: selection.id });
          importedFolders.push(`"${selection.name}" (${result.videoCount} videos)`);
        } else {
          await importDriveFile(idToken, { connectionId, fileId: selection.id, playlistId });
          importedFiles.push(`"${selection.name}"`);
        }
      }

      if (importedFolders.length > 0) {
        toast.success(`Imported folder${importedFolders.length > 1 ? "s" : ""}: ${importedFolders.join(", ")}.`);
      }
      if (importedFiles.length > 0) {
        toast.success(`Imported file${importedFiles.length > 1 ? "s" : ""}: ${importedFiles.join(", ")}.`);
      }
      onImported();
    } catch (error: any) {
      toast.error(error?.message || "Import from Drive failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadFile(file: File) {
    if (!user || !connectionId) return;
    setBusy(true);
    setUploadPct(0);
    try {
      const idToken = await user.getIdToken();
      const uploadUrl = await startDriveUploadSession(idToken, { connectionId, name: file.name, mimeType: file.type, sizeBytes: file.size });
      const uploaded = await uploadFileToDrive(uploadUrl, file, setUploadPct);
      await importDriveFile(idToken, { connectionId, fileId: uploaded.id, playlistId });
      toast.success(`Uploaded and saved "${file.name}".`);
      onImported();
    } catch (error: any) {
      toast.error(error?.message || "Upload to Drive failed.");
    } finally {
      setBusy(false);
      setUploadPct(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (loadingConnections) return <p className="text-sm text-muted-foreground">Loading your Google Drive connections…</p>;

  if (connections.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        <p>Connect a Google account first.</p>
        <Button asChild variant="outline" size="sm"><a href="/settings/drive" target="_blank" rel="noopener noreferrer">Open Google Drive settings</a></Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connections.length > 1 && (
        <div className="space-y-1.5">
          <Label>Google account</Label>
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={connectionId ?? ""}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            {connections.map((c) => <option key={c.id} value={c.id}>{c.googleEmail}</option>)}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {connectionId && (
          <DrivePickerButton
            connectionId={connectionId}
            onPicked={handlePicked}
            label="Pick from Drive"
            allowFolders={allowFolders}
            kinds={kinds ?? (allowFolders ? ["video"] : ["pdf", "docx", "pptx", "xlsx"])}
          />
        )}
        <Button type="button" variant="outline" className="gap-1.5" disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <UploadCloud className="h-4 w-4" /> Upload to Drive
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => { const file = e.target.files?.[0]; if (file) handleUploadFile(file); }}
        />
      </div>

      {uploadPct !== null && (
        <div className="space-y-1">
          <Progress value={uploadPct} />
          <p className="text-xs text-muted-foreground">Uploading… {uploadPct}%</p>
        </div>
      )}
    </div>
  );
}
