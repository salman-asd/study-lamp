"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const SLOW_HINT_MS = 6000;

/** Google's own preview in an iframe. Needs this browser to be signed in to the right Google account. */
export function GooglePreviewFrame({
  url, title, openUrl, onUseReader, heightClass = "h-[calc(100dvh-14rem)] min-h-[28rem]",
}: {
  url: string;
  title: string;
  openUrl: string;
  onUseReader: () => void;
  heightClass?: string;
}) {
  const [loaded, setLoaded] = React.useState(false);
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [url]);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <iframe
        src={url}
        title={title}
        className={`w-full border-0 bg-background ${heightClass}`}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        onLoad={() => setLoaded(true)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2">
        <p className="text-xs text-muted-foreground" role="status">
          {slow && !loaded ? "Still loading… " : ""}Not loading? Sign in to the right Google account in this browser, or switch to the Study Lamp reader.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm"><a href={openUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Google</a></Button>
          <Button type="button" size="sm" onClick={onUseReader}>Use Study Lamp reader</Button>
        </div>
      </div>
    </div>
  );
}
