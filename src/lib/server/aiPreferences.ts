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

export async function resolveAiLanguage(uid: string, requested: unknown): Promise<AiLanguage | null> {
  if (requested === undefined) return (await getAiPreferences(uid)).generatingLanguage;
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
