import { toast } from "sonner";
import { planGoogleSync } from "@/lib/googleClient";
import { countActionableItems, readCalendarFlag } from "@/lib/googleCalendarFlag";

/**
 * For pages that create a goal but don't show the review dialog (the roadmap). If Calendar sync is on, asks the
 * server for a READ-ONLY plan for that one goal and, when something is ready, shows a toast whose Review button
 * opens the Goals page review. Nothing is written here, and any failure is silent: the goal is already saved.
 */
export async function offerCalendarReview(user: { uid: string; getIdToken: () => Promise<string> }, goalId: string, openReview: () => void): Promise<void> {
  if (readCalendarFlag(user.uid) !== true) return;
  try {
    const result = await planGoogleSync(await user.getIdToken(), [goalId]);
    const ready = countActionableItems(result.items);
    if (ready === 0) return;
    toast(`Google Calendar: ${ready} change${ready === 1 ? "" : "s"} ready to review`, {
      action: { label: "Review", onClick: openReview },
      duration: 10_000,
    });
  } catch {
    // Shown in Settings > Google Workspace when the user looks there.
  }
}
