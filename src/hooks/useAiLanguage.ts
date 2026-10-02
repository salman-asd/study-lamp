"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAiPreferences } from "@/lib/aiPreferencesClient";
import type { AiLanguage } from "@/lib/ai/types";
import { toast } from "sonner";

export function useAiLanguage() {
  const { user } = useAuth();
  const [language, setLanguage] = React.useState<AiLanguage>("en");
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setReady(false);
    if (!user) return () => { active = false; };

    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const preferences = await getAiPreferences(idToken);
        if (active) {
          setLanguage(preferences.generatingLanguage);
          setReady(true);
        }
      } catch (error) {
        if (active) toast.error(error instanceof Error ? error.message : "Unable to load AI language preference.");
      }
    })();
    return () => { active = false; };
  }, [user]);

  return { language, setLanguage, languageReady: ready };
}
