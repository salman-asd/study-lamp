"use client";

import { Button } from "@/components/ui/button";
import { goalDraftTargetDate } from "@/lib/roadmapUtils";
import type { GoalSuggestion } from "@/lib/goalSuggestionsClient";
import { X } from "lucide-react";

export function GoalSuggestionsList({
  suggestions,
  onAccept,
  onDismiss,
}: {
  suggestions: GoalSuggestion[];
  onAccept: (suggestion: GoalSuggestion) => void;
  onDismiss: (suggestion: GoalSuggestion) => void;
}) {
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">Candidate goals — review and add the ones that fit</p>
      {suggestions.map((suggestion, i) => (
        <div key={`${suggestion.title}-${i}`} className="flex items-start justify-between gap-3 rounded-md border border-border bg-background p-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{suggestion.title}</p>
            {suggestion.notes && <p className="text-xs text-muted-foreground">{suggestion.notes}</p>}
            <p className="mt-1 text-[11px] text-muted-foreground">Target: {goalDraftTargetDate(suggestion.daysFromNow)}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" onClick={() => onAccept(suggestion)}>Add to my Goals</Button>
            <Button size="sm" variant="ghost" onClick={() => onDismiss(suggestion)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
