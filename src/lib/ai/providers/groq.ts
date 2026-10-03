import { AiServiceError } from "../errors";
import type { AiConnectionCredentials, AiGenerateOptions } from "../types";
import { resolveAiGenerateOptions } from "../generateOptions";

const CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";
const GENERATE_TIMEOUT_MS = 45_000;
const VALIDATE_TIMEOUT_MS = 10_000;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function translateHttpError(status: number, body: any): AiServiceError {
  const detail = typeof body?.error?.message === "string" ? body.error.message : undefined;
  if (status === 401 || status === 403) return new AiServiceError("auth", "Groq rejected this API key.");
  if (status === 429) return new AiServiceError("rate_limit", "Groq rate-limited this request.");
  if (status === 400 || status === 404) {
    return new AiServiceError("invalid_request", detail ? `Groq rejected the request: ${detail}` : "Groq rejected the request.");
  }
  if (status >= 500) return new AiServiceError("server_error", `Groq returned a server error (status ${status}).`);
  return new AiServiceError("unknown", `Groq returned an unexpected error (status ${status}).`);
}

function parseCompletion(body: any): string {
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "content_filter") throw new AiServiceError("blocked", "Groq declined to answer this request.");
  const text = choice?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new AiServiceError("unknown", "Groq returned an empty response.");
  return text.trim();
}

export function buildGroqRequestBody(credentials: AiConnectionCredentials, prompt: string, options?: AiGenerateOptions) {
  const settings = resolveAiGenerateOptions(options);
  return {
    model: credentials.model,
    messages: [{ role: "user", content: prompt }],
    temperature: settings.temperature,
    max_tokens: settings.maxOutputTokens,
    // json_object mode only allows an object root; array replies stay prompt-only.
    ...(settings.json && settings.jsonRoot === "object" ? { response_format: { type: "json_object" } } : {}),
  };
}

export async function generateWithGroq(credentials: AiConnectionCredentials, prompt: string, options?: AiGenerateOptions): Promise<string> {
  let res: Response;
  try {
    res = await withTimeout(GENERATE_TIMEOUT_MS, (signal) => fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildGroqRequestBody(credentials, prompt, options)),
    }));
  } catch (err: any) {
    if (err?.name === "AbortError") throw new AiServiceError("timeout", "Timed out waiting for Groq.");
    throw new AiServiceError("network", "Could not reach Groq.");
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) throw translateHttpError(res.status, body);
  return parseCompletion(body);
}

export async function validateGroqConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await withTimeout(VALIDATE_TIMEOUT_MS, (signal) => fetch(MODELS_URL, {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
    if (res.ok) return { ok: true, message: "Connection verified." };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Groq rejected this API key." };
    return { ok: false, message: `Groq returned an unexpected error (status ${res.status}).` };
  } catch (err: any) {
    if (err?.name === "AbortError") return { ok: false, message: "Timed out reaching Groq." };
    return { ok: false, message: "Could not reach Groq." };
  }
}
