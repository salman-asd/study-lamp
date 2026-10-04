"use client";

import * as React from "react";
import { useAiLanguageContext } from "@/components/ai/AiLanguageProvider";
import { isLanguageOverridden, nextOverride, resolveEffectiveLanguage, resolveRequestLanguage } from "@/lib/aiLanguageState";
import type { AiLanguage } from "@/lib/ai/types";

/**
 * Language for ONE AI trigger (one page or one generate button).
 *
 * `language` is the saved default until the user picks something else with
 * `setLanguage`; that override is local to this hook instance, is never
 * saved, and disappears when the page is left. While not overridden, the
 * value follows the default if it changes in Settings -> AI.
 */
export function useAiLanguage() {
  const { defaultLanguage, ready, loadFailed } = useAiLanguageContext();
  const [override, setOverride] = React.useState<AiLanguage | null>(null);

  const language = resolveEffectiveLanguage(defaultLanguage, override);
  // What to SEND: undefined when the saved default failed to load and nothing was picked,
  // so the server uses the saved default. The picker keeps showing `language`.
  const languageForRequest = resolveRequestLanguage({ defaultLanguage, override, loadFailed });
  const setLanguage = React.useCallback((picked: AiLanguage) => {
    setOverride(nextOverride(defaultLanguage, picked));
  }, [defaultLanguage]);
  const resetToDefault = React.useCallback(() => setOverride(null), []);

  return {
    language,
    languageForRequest,
    setLanguage,
    resetToDefault,
    defaultLanguage,
    isOverridden: isLanguageOverridden(defaultLanguage, override),
    languageReady: ready,
  };
}
