"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

export default function RootPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    // Phase 1 (roadmap v3): onboarding is no longer a forced gate. A
    // brand-new profile lands straight on the dashboard, where an
    // InterestsBanner offers the same setup optionally. /onboarding itself
    // is untouched and still reachable from Settings → Interests.
    router.replace("/dashboard");
  }, [loading, user, router]);

  return null;
}
