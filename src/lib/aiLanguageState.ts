import type { AiLanguage } from "@/lib/ai/types";

/**
 * Per-picker language override logic (pure, so it is unit-testable).
 *
 * The saved default lives in Settings -> AI. Each AI trigger has its own
 * picker, which starts on the default; picking a different language overrides
 * ONLY that picker's next generation and never changes the saved default.
 */

/** A picker that was never manually changed follows the saved default. */
export function resolveEffectiveLanguage(defaultLanguage: AiLanguage, override: AiLanguage | null): AiLanguage {
  return override ?? defaultLanguage;
}

/** Choosing the default language again is the same as "no override", so the picker keeps following the default. */
export function nextOverride(defaultLanguage: AiLanguage, picked: AiLanguage): AiLanguage | null {
  return picked === defaultLanguage ? null : picked;
}

export function isLanguageOverridden(defaultLanguage: AiLanguage, override: AiLanguage | null): boolean {
  return override !== null && override !== defaultLanguage;
}

export const AI_LANGUAGE_LABELS: Record<AiLanguage, string> = {
  en: "English (EN)",
  bn: "Bengali (BN)",
};
