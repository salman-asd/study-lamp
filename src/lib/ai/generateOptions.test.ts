import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AI_DEFAULT_OPTIONS, AI_OPTIONS, resolveAiGenerateOptions } from "./generateOptions";
import { generateAiText } from "./aiService";
import { buildOpenAiRequestBody, isOpenAiReasoningModel } from "./providers/openai";
import { buildGeminiRequestBody, generateWithGemini } from "./providers/gemini";
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
    assert.deepEqual(resolveAiGenerateOptions(), { maxOutputTokens: 1800, temperature: 0.7, json: false, jsonRoot: "object", disableThinking: false });
    assert.equal(AI_DEFAULT_OPTIONS.maxOutputTokens, 1800);
  });
  it("exposes the documented presets", () => {
    assert.deepEqual([AI_OPTIONS.summary.maxOutputTokens, AI_OPTIONS.summary.temperature], [2500, 0.5]);
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

describe("Gemini thinking budget", () => {
  const body = (model: string, options: any, includeThinking = true) =>
    buildGeminiRequestBody(connection("gemini", model), "p", options, includeThinking).generationConfig as any;

  it("adds thinkingConfig only for 2.5 models on the summary and JSON presets", () => {
    assert.deepEqual(body("gemini-2.5-flash", AI_OPTIONS.summary).thinkingConfig, { thinkingBudget: 0 });
    assert.deepEqual(body("gemini-2.5-pro", AI_OPTIONS.jsonArray).thinkingConfig, { thinkingBudget: 0 });
    assert.equal("thinkingConfig" in body("gemini-2.0-flash", AI_OPTIONS.summary), false);
    assert.equal("thinkingConfig" in body("gemini-1.5-pro", AI_OPTIONS.jsonObject), false);
    assert.equal("thinkingConfig" in body("gemini-2.5-flash", undefined), false, "options === undefined -> no thinkingConfig");
    assert.equal("thinkingConfig" in body("gemini-2.5-flash", {}), false, "no disableThinking -> no thinkingConfig");
    assert.equal("thinkingConfig" in body("gemini-2.5-flash", AI_OPTIONS.summary, false), false);
  });

  it("with options === undefined the provider uses the legacy defaults (1800 tokens, temperature 0.7)", async () => {
    const config = body("gemini-2.5-flash", undefined);
    assert.deepEqual(config, { temperature: 0.7, maxOutputTokens: 1800 });
    let sent: any;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(responses.gemini), { status: 200 }); }) as typeof fetch;
    await generateWithGemini(connection("gemini", "gemini-2.5-flash"), "p"); // no third argument at all
    assert.deepEqual(sent.generationConfig, { temperature: 0.7, maxOutputTokens: 1800 });
  });

  it("retries once without thinkingConfig when the model rejects it with a 400 about thinking", async () => {
    const sent: any[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body)));
      return sent.length === 1
        ? new Response(JSON.stringify({ error: { message: "Budget 0 is invalid. This model only works in thinking mode." } }), { status: 400 })
        : new Response(JSON.stringify(responses.gemini), { status: 200 });
    }) as typeof fetch;
    assert.equal(await generateWithGemini(connection("gemini", "gemini-2.5-pro"), "p", AI_OPTIONS.summary), "ok");
    assert.equal(sent.length, 2);
    assert.ok(sent[0].generationConfig.thinkingConfig);
    assert.equal("thinkingConfig" in sent[1].generationConfig, false);
  });

  it("does not retry other 400 errors or models without thinkingConfig", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "Bad prompt" } }), { status: 400 }); }) as typeof fetch;
    await assert.rejects(() => generateWithGemini(connection("gemini", "gemini-2.5-flash"), "p", AI_OPTIONS.summary));
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(() => generateWithGemini(connection("gemini", "gemini-2.0-flash"), "p", AI_OPTIONS.summary));
    assert.equal(calls, 1);
  });
});
