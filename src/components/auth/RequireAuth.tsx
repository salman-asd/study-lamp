"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { Skeleton } from "@/components/ui/skeleton";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, profile, profileError } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user || !profile) {
    if (!loading && user && !profile) {
      const permissionDenied = profileError === "permission-denied";
      return (
        <div className="flex min-h-screen items-center justify-center p-8 text-center">
          <div className="max-w-lg">
            <h1 className="font-display text-xl font-semibold">Account setup could not finish</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {permissionDenied
                ? "Firestore denied profile creation. Check that this admin email is in both NEXT_PUBLIC_SEED_ADMIN_EMAILS and firestore.rules, then deploy the updated rules."
                : "Your account is signed in, but its Firestore profile could not be loaded or created. Check your connection and try again."}
            </p>
            <button
              type="button"
              className="mt-4 text-sm font-medium text-primary underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Reload and retry
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      </div>
    );
  }

  if (profile.status === "disabled") {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <h1 className="font-display text-xl font-semibold">Access disabled</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account has been disabled. Contact an administrator for help.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (!loading && !user) router.replace("/login");
    if (!loading && user && (!profile || profile.status === "disabled" || profile.role !== "admin")) {
      router.replace("/dashboard");
    }
  }, [loading, user, profile, router]);

  if (loading || !user || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <Skeleton className="h-8 w-64" />
      </div>
    );
  }

  if (profile.status === "disabled" || profile.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <Skeleton className="h-8 w-64" />
      </div>
    );
  }

  return <>{children}</>;
}
