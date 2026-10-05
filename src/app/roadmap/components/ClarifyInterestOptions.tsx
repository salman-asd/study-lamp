"use client";

import { Button } from "@/components/ui/button";

export function ClarifyInterestOptions({
  options,
  pendingName,
  onPick,
}: {
  options: { label: string; description: string }[];
  pendingName: string;
  onPick: (name: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      <p className="text-sm text-muted-foreground">
        Did you mean one of these for &quot;{pendingName}&quot;?
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.label}
            variant="outline"
            size="sm"
            title={option.description}
            onClick={() => onPick(option.label)}
          >
            {option.label}
          </Button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => onPick(pendingName)}>
          Use &quot;{pendingName}&quot; as typed
        </Button>
      </div>
    </div>
  );
}
