import Link from "next/link";
import { BookOpenCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { RoadmapFocusRow } from "@/lib/dashboardUtils";

export function ActiveRoadmapSection({ rows }: { rows: RoadmapFocusRow[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <BookOpenCheck className="h-4 w-4 text-accent" /> Your roadmap
        </h2>
        <Link href="/roadmap" className="text-sm text-muted-foreground hover:text-foreground">View all</Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.slice(0, 3).map((row) => (
          <div key={row.id} className="space-y-2.5 rounded-xl border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              {/* row.categoryName is resolved from the real category doc.
                  This previously rendered interest.categoryId — a raw
                  Firestore id — which is the "wrong title" bug. */}
              <p className="font-medium leading-tight">{row.categoryName}</p>
              <Badge variant="secondary" className="shrink-0 capitalize">{row.level}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Step {row.currentStepIndex + 1} of {row.stepCount} — <span className="text-foreground">{row.currentStepTitle}</span>
            </p>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Roadmap progress</span>
                <span>{row.progressPercent}%</span>
              </div>
              <Progress value={row.progressPercent} className="h-1.5" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {row.completedVideos} completed video{row.completedVideos === 1 ? "" : "s"} in this topic
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
