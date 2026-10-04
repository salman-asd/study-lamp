"use client";

import * as React from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAiPreferences } from "@/lib/aiPreferencesClient";
import type { AiLanguage } from "@/lib/ai/types";
import { toast } from "sonner";

interface AiLanguageContextValue {
  /** The saved default (Settings -> AI). English until loaded. */
  defaultLanguage: AiLanguage;
  /** True once loading the saved default has finished (successfully or not). */
  ready: boolean;
  /** True when the saved default could not be loaded: `defaultLanguage` is then only a placeholder. */
  loadFailed: boolean;
  /** Updates the in-memory default after Settings -> AI saved it. Does NOT call the server. */
  setDefaultLanguage: (language: AiLanguage) => void;
}

const AiLanguageContext = React.createContext<AiLanguageContextValue>({
  defaultLanguage: "en",
  ready: false,
  loadFailed: false,
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
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setReady(false);
    setLoadFailed(false);
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
        if (active) {
          setLoadFailed(true);
          toast.error(error instanceof Error ? error.message : "Couldn't load your AI language preference.");
        }
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
    // Keyed on uid so token refreshes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const setDefault = React.useCallback((language: AiLanguage) => {
    setDefaultLanguage(language);
    setLoadFailed(false); // Settings just saved a real value
  }, []);
  const value = React.useMemo(() => ({ defaultLanguage, ready, loadFailed, setDefaultLanguage: setDefault }), [defaultLanguage, ready, loadFailed, setDefault]);
  return <AiLanguageContext.Provider value={value}>{children}</AiLanguageContext.Provider>;
}

export function useAiLanguageContext(): AiLanguageContextValue {
  return React.useContext(AiLanguageContext);
}
