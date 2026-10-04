import { adminDb } from "@/lib/server/firebase-admin";
import type { AiLanguage } from "@/lib/ai/types";

export interface AiPreferences {
  speechToTextEnabled: boolean;
  generatingLanguage: AiLanguage;
}

const defaults: AiPreferences = { speechToTextEnabled: false, generatingLanguage: "en" };

export function isAiLanguage(value: unknown): value is AiLanguage {
  return value === "en" || value === "bn";
}

/**
 * Language for an AI request: the explicit `language` when the client sends one
 * (EN/BN), the user's saved default when it is omitted, and null for any other
 * value (routes answer 400 "language must be en or bn.").
 */
export async function resolveAiLanguage(
  uid: string,
  requested: unknown,
  loadPreferences: (uid: string) => Promise<AiPreferences> = getAiPreferences,
): Promise<AiLanguage | null> {
  if (requested === undefined) return (await loadPreferences(uid)).generatingLanguage;
  return isAiLanguage(requested) ? requested : null;
}

export async function getAiPreferences(uid: string): Promise<AiPreferences> {
  const snap = await adminDb.collection("users").doc(uid).get();
  const settings = snap.data()?.aiSettings;
  return {
    speechToTextEnabled: settings?.speechToTextEnabled === true,
    generatingLanguage: isAiLanguage(settings?.generatingLanguage) ? settings.generatingLanguage : "en",
  };
}

export async function updateAiPreferences(uid: string, input: Partial<AiPreferences>): Promise<AiPreferences> {
  const current = await getAiPreferences(uid);
  const next = { ...defaults, ...current, ...input };
  await adminDb.collection("users").doc(uid).set({ aiSettings: next }, { merge: true });
  return next;
}
