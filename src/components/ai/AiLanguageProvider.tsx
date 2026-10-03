"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAiPreferences } from "@/lib/aiPreferencesClient";
import type { AiLanguage } from "@/lib/ai/types";
import { toast } from "sonner";

interface AiLanguageContextValue {
  /** The saved default (Settings -> AI). English until loaded. */
  defaultLanguage: AiLanguage;
  /** True once the saved default has been loaded for the signed-in user. */
  ready: boolean;
  /** Updates the in-memory default after Settings -> AI saved it. Does NOT call the server. */
  setDefaultLanguage: (language: AiLanguage) => void;
}

const AiLanguageContext = React.createContext<AiLanguageContextValue>({
  defaultLanguage: "en",
  ready: false,
  setDefaultLanguage: () => undefined,
});

/**
 * Loads the saved AI language preference ONCE per login and shares it with
 * every page (previously each page fetched /api/ai/preferences itself).
 */
export function AiLanguageProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid;
  const [defaultLanguage, setDefaultLanguage] = React.useState<AiLanguage>("en");
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setReady(false);
    if (!user) {
      setDefaultLanguage("en");
      return () => { active = false; };
    }

    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const preferences = await getAiPreferences(idToken);
        if (active) setDefaultLanguage(preferences.generatingLanguage);
      } catch (error) {
        if (active) toast.error(error instanceof Error ? error.message : "Couldn't load your AI language preference. Using English.");
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
    // Keyed on uid so token refreshes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const value = React.useMemo(() => ({ defaultLanguage, ready, setDefaultLanguage }), [defaultLanguage, ready]);
  return <AiLanguageContext.Provider value={value}>{children}</AiLanguageContext.Provider>;
}

export function useAiLanguageContext(): AiLanguageContextValue {
  return React.useContext(AiLanguageContext);
}
