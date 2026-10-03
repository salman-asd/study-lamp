import type { AiGenerateOptions } from "./types";

/** Today's behaviour, used when a caller passes no options. */
export const AI_DEFAULT_OPTIONS = { maxOutputTokens: 1800, temperature: 0.7 } as const;

/** Presets per feature. Tweak limits here, not in the providers. */
export const AI_OPTIONS = {
  /** Summaries and page explanations: more room, calmer sampling. */
  summary: { maxOutputTokens: 2000, temperature: 0.5 },
  /** Quiz, goals, clarification, plan: structured JSON, low temperature. */
  jsonArray: { maxOutputTokens: 2500, temperature: 0.2, json: true, jsonRoot: "array" },
  jsonObject: { maxOutputTokens: 2500, temperature: 0.2, json: true, jsonRoot: "object" },
  /** Week-by-week roadmap: up to 10 weeks x 5 bullets, and Bengali needs far more tokens than English. */
  roadmapSteps: { maxOutputTokens: 4000, temperature: 0.2, json: true, jsonRoot: "array" },
} as const satisfies Record<string, AiGenerateOptions>;

export interface ResolvedAiGenerateOptions {
  maxOutputTokens: number;
  temperature: number;
  json: boolean;
  jsonRoot: "object" | "array";
}

export function resolveAiGenerateOptions(options?: AiGenerateOptions): ResolvedAiGenerateOptions {
  return {
    maxOutputTokens: options?.maxOutputTokens ?? AI_DEFAULT_OPTIONS.maxOutputTokens,
    temperature: options?.temperature ?? AI_DEFAULT_OPTIONS.temperature,
    json: options?.json ?? false,
    jsonRoot: options?.jsonRoot ?? "object",
  };
}
