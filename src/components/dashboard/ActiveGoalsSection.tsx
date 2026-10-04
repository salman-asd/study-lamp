import Link from "next/link";
import { Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { describeDueDate } from "@/lib/goalUtils";
import type { GoalPaceRow } from "@/lib/dashboardUtils";

export function ActiveGoalsSection({ rows }: { rows: GoalPaceRow[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Target className="h-4 w-4 text-accent" /> Active goals
        </h2>
        <Link href="/goals" className="text-sm text-muted-foreground hover:text-foreground">View all</Link>
      </div>
      <div className="space-y-2">
        {rows.slice(0, 4).map((goal) => {
          const due = describeDueDate(goal.targetDate, false);
          const tone = goal.status === "overdue" ? "text-destructive" : goal.status === "behind" ? "text-amber-600" : "text-emerald-600";
          const label = goal.status === "ahead" ? "Ahead" : goal.status === "on-track" ? "On track" : goal.status === "behind" ? "Behind" : "Overdue";
          return (
            <Link
              key={goal.id}
              href={`/goals?goal=${goal.id}`}
              className="block rounded-xl border-border bg-card p-3.5 transition-colors hover:border-accent/50"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{goal.title}</span>
                <span className="flex items-center gap-2 text-xs">
                  {due.label && <Badge variant="outline">{due.label}</Badge>}
                  <span className={cn("font-medium", tone)}>
                    {label}{goal.videosPerDayNeeded > 0 ? ` · ${goal.videosPerDayNeeded}/day` : ""}
                  </span>
                </span>
              </div>
              <div className="mt-2 space-y-1">
                <Progress value={goal.progressPercent} className="h-1.5" />
                <p className="text-[11px] text-muted-foreground">
                  {goal.watched} of {goal.total} watched{goal.videosRemaining > 0 ? ` · ${goal.videosRemaining} to go` : " · complete"}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
