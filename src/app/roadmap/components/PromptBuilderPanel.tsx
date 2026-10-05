"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X, Copy } from "lucide-react";

export function PromptBuilderPanel({
  promptText,
  loading,
  onCopy,
  onClose,
}: {
  promptText: string | null;
  loading: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          This is the exact prompt Study Lamp would send to generate this roadmap. Copy it, run it in any AI
          assistant, then switch to <strong>Customize</strong> and paste the reply in to use it here.
        </p>
        <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0" onClick={onClose} aria-label="Hide prompt">
          <X className="h-4 w-4" />
        </Button>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Building prompt…</p>
      ) : (
        <>
          <Textarea readOnly value={promptText ?? ""} rows={8} className="font-mono text-xs" />
          <div className="flex gap-2">
            <Button size="sm" onClick={onCopy}>
              <Copy className="mr-1 h-3.5 w-3.5" /> Copy to clipboard
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </div>
  );
}
