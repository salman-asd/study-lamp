"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AiLanguage } from "@/lib/ai/types";

// ── Focus editor ──

export function FocusEditor({
  categoryName,
  currentSubtopics,
  language,
  onSave,
}: {
  categoryName: string;
  currentSubtopics: string[];
  language: AiLanguage | undefined;
  onSave: (subtopics: string[]) => void;
}) {
  const { user } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(currentSubtopics.join(", "));
  const [checking, setChecking] = React.useState(false);
  const [clarifyOptions, setClarifyOptions] = React.useState<{ label: string; description: string }[] | null>(null);

  React.useEffect(() => {
    setValue(currentSubtopics.join(", "));
  }, [currentSubtopics]);

  async function commit(rawValue: string) {
    const subtopics = rawValue.split(",").map((s) => s.trim()).filter(Boolean);
    if (subtopics.length === 0) {
      setEditing(false);
      setClarifyOptions(null);
      onSave([]);
      return;
    }
    if (!user) return;
    setChecking(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/ai/roadmap/clarify", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: subtopics.join(", "), context: categoryName, kind: "focus", language }),
      });
      const result = await res.json().catch(() => ({ ambiguous: false }));
      if (res.ok && result?.ambiguous && result.options?.length) {
        setClarifyOptions(result.options);
        setChecking(false);
        return;
      }
    } catch {
      // best-effort — fall through to saving as typed
    }
    setChecking(false);
    setEditing(false);
    setClarifyOptions(null);
    onSave(subtopics);
  }

  function pickClarifiedOption(label: string) {
    setValue(label);
    setClarifyOptions(null);
    setEditing(false);
    onSave([label]);
  }

  if (!editing) {
    return (
      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setEditing(true)}>
        {currentSubtopics.length ? "Edit focus" : "Set a focus (e.g. Speaking, Writing)"}
      </Button>
    );
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Speaking, Writing, Listening"
          className="h-8 max-w-xs text-xs"
          autoFocus
        />
        <Button size="sm" className="h-8" onClick={() => void commit(value)} disabled={checking}>
          {checking ? "Checking…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(false); setClarifyOptions(null); }}>
          Cancel
        </Button>
      </div>
      {clarifyOptions && (
        <div className="space-y-2 rounded-md border border-dashed border-border p-2">
          <p className="text-xs text-muted-foreground">
            &quot;{value}&quot; could mean a few different things within {categoryName || "this topic"} — did you mean:
          </p>
          <div className="flex flex-wrap gap-2">
            {clarifyOptions.map((option) => (
              <Button
                key={option.label}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                title={option.description}
                onClick={() => pickClarifiedOption(option.label)}
              >
                {option.label}
              </Button>
            ))}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void commit(value)}>
              Use &quot;{value}&quot; as typed
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
