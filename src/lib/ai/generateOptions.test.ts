import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AI_DEFAULT_OPTIONS, AI_OPTIONS, resolveAiGenerateOptions } from "./generateOptions";
import { generateAiText } from "./aiService";
import { buildOpenAiRequestBody, isOpenAiReasoningModel } from "./providers/openai";
import { buildGroqRequestBody } from "./providers/groq";
import { buildOpenRouterRequestBody } from "./providers/openrouter";
import type { AiConnectionCredentials } from "./types";

type Provider = AiConnectionCredentials["provider"];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function captureBody(responseBody: unknown): { body: () => any } {
  let sent: any;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  return { body: () => sent };
}

const responses: Record<Provider, unknown> = {
  gemini: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
  openai: { choices: [{ message: { content: "ok" } }] },
  groq: { choices: [{ message: { content: "ok" } }] },
  openrouter: { choices: [{ message: { content: "ok" } }] },
  anthropic: { content: [{ type: "text", text: "ok" }] },
};
const connection = (provider: Provider, model = "test-model"): AiConnectionCredentials => ({ provider, apiKey: "k", model });

describe("resolveAiGenerateOptions", () => {
  it("falls back to today's defaults", () => {
    assert.deepEqual(resolveAiGenerateOptions(), { maxOutputTokens: 1800, temperature: 0.7, json: false, jsonRoot: "object" });
    assert.equal(AI_DEFAULT_OPTIONS.maxOutputTokens, 1800);
  });
  it("exposes the documented presets", () => {
    assert.deepEqual([AI_OPTIONS.summary.maxOutputTokens, AI_OPTIONS.summary.temperature], [2000, 0.5]);
    assert.deepEqual([AI_OPTIONS.jsonArray.maxOutputTokens, AI_OPTIONS.jsonArray.temperature, AI_OPTIONS.jsonArray.json], [2500, 0.2, true]);
  });
});

describe("generation options reach every provider's request", () => {
  it("gemini: maxOutputTokens, temperature and responseMimeType in JSON mode", async () => {
    const sent = captureBody(responses.gemini);
    await generateAiText(connection("gemini"), "p", { maxOutputTokens: 321, temperature: 0.1, json: true, jsonRoot: "array" });
    assert.deepEqual(sent.body().generationConfig, { temperature: 0.1, maxOutputTokens: 321, responseMimeType: "application/json" });
    await generateAiText(connection("gemini"), "p");
    assert.deepEqual(sent.body().generationConfig, { temperature: 0.7, maxOutputTokens: 1800 });
  });

  it("anthropic: max_tokens and temperature, no JSON field", async () => {
    const sent = captureBody(responses.anthropic);
    await generateAiText(connection("anthropic"), "p", { maxOutputTokens: 500, temperature: 0.3, json: true });
    assert.equal(sent.body().max_tokens, 500);
    assert.equal(sent.body().temperature, 0.3);
    assert.equal("response_format" in sent.body(), false);
  });

  it("openai: max_completion_tokens, temperature and json_object only for object roots", async () => {
    const sent = captureBody(responses.openai);
    await generateAiText(connection("openai", "gpt-4o-mini"), "p", { maxOutputTokens: 700, temperature: 0.2, json: true, jsonRoot: "object" });
    assert.equal(sent.body().max_completion_tokens, 700);
    assert.equal("max_tokens" in sent.body(), false);
    assert.equal(sent.body().temperature, 0.2);
    assert.deepEqual(sent.body().response_format, { type: "json_object" });
    await generateAiText(connection("openai", "gpt-4o-mini"), "p", AI_OPTIONS.jsonArray);
    assert.equal("response_format" in sent.body(), false, "json_object cannot return an array root");
  });

  it("openai reasoning models get no custom temperature", () => {
    assert.equal(isOpenAiReasoningModel("o3-mini"), true);
    assert.equal(isOpenAiReasoningModel("gpt-5-mini"), true);
    assert.equal(isOpenAiReasoningModel("gpt-4o"), false);
    assert.equal("temperature" in buildOpenAiRequestBody(connection("openai", "o3-mini"), "p", { temperature: 0.2 }), false);
  });

  it("groq and openrouter: max_tokens/temperature; json_object only on groq with an object root", () => {
    const options = { maxOutputTokens: 900, temperature: 0.4, json: true, jsonRoot: "object" as const };
    const groq = buildGroqRequestBody(connection("groq"), "p", options);
    assert.deepEqual([groq.max_tokens, groq.temperature, groq.response_format], [900, 0.4, { type: "json_object" }]);
    const router = buildOpenRouterRequestBody(connection("openrouter"), "p", options);
    assert.deepEqual([router.max_tokens, router.temperature], [900, 0.4]);
    assert.equal("response_format" in router, false);
  });

  it("appends the language instruction exactly once", async () => {
    const sent = captureBody(responses.openai);
    await generateAiText({ ...connection("openai"), language: "bn" }, "Hello");
    const content: string = sent.body().messages[0].content;
    assert.equal(content.split("Response language:").length - 1, 1);
  });
});
