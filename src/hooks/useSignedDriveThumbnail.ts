"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getSignedDriveUrls } from "@/lib/driveClient";
import { parseDriveThumbnailMarker } from "@/lib/driveThumbnailMarker";

/**
 * Resolves a persisted Drive thumbnail marker (`/api/drive/thumbnail/{fileId}?connectionId=…`)
 * to a short-lived signed URL, because <img> cannot send an Authorization
 * header. Non-marker values (YouTube/Facebook URLs, data URLs) pass through
 * unchanged; `undefined` means "still resolving", `null` means "failed".
 */
export function useSignedDriveThumbnail(src?: string | null): string | null | undefined {
  const { user } = useAuth();
  const [resolved, setResolved] = React.useState(src);

  React.useEffect(() => {
    const marker = parseDriveThumbnailMarker(src, typeof window === "undefined" ? undefined : window.location.origin);
    if (!src || !src.includes("/api/drive/thumbnail/")) {
      setResolved(src);
      return;
    }
    if (!user) return;
    let active = true;
    setResolved(undefined);
    const signedRequest = async () => {
      try {
        if (!marker) throw new Error("Invalid Drive thumbnail marker.");
        const idToken = await user.getIdToken();
        const [signedUrl] = await getSignedDriveUrls(idToken, user.uid, [{
          fileId: marker.fileId,
          connectionId: marker.connectionId,
          purpose: "thumb",
        }]);
        if (active) setResolved(signedUrl);
      } catch {
        if (active) setResolved(null);
      }
    };
    void signedRequest();
    return () => { active = false; };
  }, [src, user]);

  return resolved;
}
