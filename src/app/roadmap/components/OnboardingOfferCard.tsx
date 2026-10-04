"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles } from "lucide-react";

export function OnboardingOfferCard({
  offer,
  generating,
  onAccept,
  onDismiss,
}: {
  offer: { categoryName: string; level: string };
  generating: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <Card className="border-accent/50 bg-accent/5">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium text-accent">
            <Sparkles className="h-4 w-4" /> One more step
          </p>
          <h2 className="font-display text-lg font-semibold">
            Build a roadmap for {offer.categoryName}?
          </h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            We&apos;ll generate a {offer.level} roadmap from the interest you just picked. You can
            edit, regenerate, or delete it afterwards.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={onAccept} loading={generating}>
            <Sparkles className="mr-2 h-4 w-4" /> {generating ? "Generating…" : "Generate roadmap"}
          </Button>
          <Button variant="ghost" onClick={onDismiss} disabled={generating}>
            Not now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
