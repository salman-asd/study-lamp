"use client";

import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import type { UserInterest } from "@/types";

const SESSION_DISMISS_KEY = "interestsBannerDismissedSession";

/**
 * Phase 1 (roadmap v3): with onboarding no longer a forced gate, this is
 * the optional nudge that replaces it on the dashboard. Shown only when
 * profile.interests is empty AND the user hasn't permanently dismissed it.
 *
 * Two dismiss actions, same "closable but persistent" idea as
 * MotivationBanner's X button, split into two strengths:
 *  - "Not now": localStorage only, so it reappears next login (session-only).
 *  - "Don't ask again": writes interestsBannerDismissed: true onto the
 *    user's profile doc, so it's gone for good across devices/sessions.
 */
export function InterestsBanner({
  uid,
  interests,
  permanentlyDismissed,
}: {
  uid: string;
  interests: UserInterest[] | undefined;
  permanentlyDismissed: boolean;
}) {
  const [sessionDismissed, setSessionDismissed] = React.useState(true); // assume hidden until storage read
  const [savingDismiss, setSavingDismiss] = React.useState(false);

  React.useEffect(() => {
    try {
      setSessionDismissed(window.localStorage.getItem(SESSION_DISMISS_KEY) === "1");
    } catch {
      setSessionDismissed(false);
    }
  }, []);

  const hasInterests = !!interests && interests.length > 0;
  if (hasInterests || permanentlyDismissed || sessionDismissed) return null;

  function handleNotNow() {
    setSessionDismissed(true);
    try {
      window.localStorage.setItem(SESSION_DISMISS_KEY, "1");
    } catch {
      // Non-fatal: it'll just show again next visit.
    }
  }

  async function handleDontAskAgain() {
    if (savingDismiss) return;
    setSavingDismiss(true);
    try {
      await updateDoc(doc(db, "users", uid), { interestsBannerDismissed: true });
    } catch {
      // Non-fatal: worst case it asks again next time.
    } finally {
      setSavingDismiss(false);
      setSessionDismissed(true);
    }
  }

  return (
    <section className="relative rounded-2xl border border-dashed border-accent/50 bg-accent/5 p-5">
      <button
        type="button"
        onClick={handleNotNow}
        aria-label="Dismiss for now"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-accent">Choose your learning focus</p>
          <h2 className="mt-1 font-display text-xl font-semibold">Build a dashboard around what matters to you.</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Select a few interests to unlock roadmap steps, recommendations, and more useful progress guidance. Totally optional — you can always do this later from Settings.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild><Link href="/onboarding">Set up interests</Link></Button>
          <Button variant="ghost" size="sm" onClick={handleNotNow}>Not now</Button>
          <Button variant="ghost" size="sm" onClick={handleDontAskAgain} disabled={savingDismiss}>
            Don&apos;t ask again
          </Button>
        </div>
      </div>
    </section>
  );
}
