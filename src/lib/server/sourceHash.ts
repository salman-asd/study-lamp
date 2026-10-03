import crypto from "crypto";
import { PROMPT_VERSION } from "@/lib/ai/prompts";
import type { AiLanguage } from "@/lib/ai/types";

export { PROMPT_VERSION };

export type SourceHashKind = "video-quiz" | "document-quiz";

export interface SourceHashInput {
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  /** Transcript for videos, extracted text for documents. */
  text?: string | null;
  /** Part of the hash, so switching language regenerates instead of serving the other language. */
  language: AiLanguage;
  /** Defaults to the current PROMPT_VERSION; pass it explicitly in tests. */
  promptVersion?: string;
  kind: SourceHashKind;
}

/**
 * Cache key for generated study material (SHA-256, hex). It covers everything
 * that changes the output: the source text, the language, the prompt wording
 * (PROMPT_VERSION) and the kind of artifact. Fields are JSON-encoded as an
 * array, so no field can run into its neighbour.
 *
 * Quizzes cached with the previous 32-bit FNV hash simply miss once and
 * regenerate; there is nothing to migrate.
 */
export function buildSourceHash(input: SourceHashInput): string {
  const fields = [
    input.kind,
    input.promptVersion ?? PROMPT_VERSION,
    input.language,
    (input.title || "").trim(),
    (input.description || "").trim(),
    (input.summary || "").trim(),
    (input.text || "").trim(),
  ];
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** SHA-256 of extracted document text (stored as `textHash` next to the cached text). */
export function hashDocumentText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
