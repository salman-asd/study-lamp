"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getDriveAccessToken } from "@/lib/driveClient";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { buildPickerMimeTypes, type DrivePickerKind } from "@/lib/driveMime";

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

let scriptsLoadingPromise: Promise<void> | null = null;

/** Loads Google's api.js + the Picker module once per page, cached across
 *  every DrivePicker instance on the page. */
function loadPickerScripts(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  if (scriptsLoadingPromise) return scriptsLoadingPromise;

  scriptsLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onload = () => {
      window.gapi.load("picker", { callback: () => resolve(), onerror: reject });
    };
    script.onerror = () => reject(new Error("Failed to load Google's Picker script."));
    document.body.appendChild(script);
  });
  return scriptsLoadingPromise;
}

export interface DrivePickerSelection {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
}

/**
 * "Pick from Drive" button (Phase 14). Opens Google's own Picker UI, scoped
 * to the connected Google account and the drive.file/docs scopes — the
 * Picker is itself part of how a narrow drive.file-scoped app is allowed to
 * grant access to files outside what it created: whatever the user picks
 * here, the app is granted access to, without ever requesting the broad
 * drive.readonly scope.
 */
export function DrivePickerButton({
  connectionId,
  onPicked,
  allowFolders = true,
  label = "Pick from Drive",
  kinds = ["video"],
}: {
  connectionId: string;
  onPicked: (selections: DrivePickerSelection[]) => void;
  allowFolders?: boolean;
  label?: string;
  kinds?: DrivePickerKind[];
}) {
  const { user } = useAuth();
  const [opening, setOpening] = React.useState(false);

  async function openPicker() {
    if (!user) return;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY;
    const appId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
    if (!apiKey) {
      toast.error("Google Drive picker isn't configured on this deployment (missing NEXT_PUBLIC_GOOGLE_PICKER_API_KEY).");
      return;
    }
    if (!appId) {
      toast.error("Google Drive picker isn't configured on this deployment (missing Firebase project number).");
      return;
    }

    setOpening(true);
    try {
      const idToken = await user.getIdToken();
      const [accessToken] = await Promise.all([getDriveAccessToken(idToken, connectionId), loadPickerScripts()]);

      const google = window.google;
      const views: any[] = [];
      const videoMimeTypes = kinds.includes("video") ? ["video/*"] : [];
      const docMimeTypes = buildPickerMimeTypes(kinds.filter((kind) => kind !== "video"));

      if (videoMimeTypes.length > 0) {
        views.push(
          new google.picker.DocsView(google.picker.ViewId.DOCS_VIDEOS)
            .setMimeTypes(videoMimeTypes.join(","))
            .setIncludeFolders(allowFolders)
            .setSelectFolderEnabled(allowFolders)
        );
      }

      if (docMimeTypes.length > 0) {
        views.push(
          new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setMimeTypes(docMimeTypes.join(","))
            .setIncludeFolders(allowFolders)
            .setSelectFolderEnabled(allowFolders)
        );
      }

      if (views.length === 0) {
        views.push(
          new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setIncludeFolders(allowFolders)
            .setSelectFolderEnabled(allowFolders)
        );
      }

      const builder = new google.picker.PickerBuilder()
        .setAppId(appId)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setTitle(
          kinds.includes("video") && docMimeTypes.length > 0
            ? "Choose a video, document, or folder"
            : kinds.includes("video")
              ? "Choose a video or folder"
              : "Choose a document or folder"
        )
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setCallback((data: any) => {
          if (data.action === google.picker.Action.PICKED) {
            const selected = Array.isArray(data.docs) ? data.docs : [];
            if (selected.length === 0) return;
            onPicked(selected.map((doc: any) => ({
              id: doc.id,
              name: doc.name,
              mimeType: doc.mimeType,
              isFolder: doc.mimeType === "application/vnd.google-apps.folder",
            })));
          }
        });

      for (const view of views) {
        builder.addView(view);
      }

      const picker = builder.build();
      picker.setVisible(true);
    } catch (error: any) {
      toast.error(error?.message || "Couldn't open the Google Drive picker.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={openPicker} loading={opening} loadingText="Opening…" className="gap-1.5">
      <FolderOpen className="h-4 w-4" /> {label}
    </Button>
  );
}
