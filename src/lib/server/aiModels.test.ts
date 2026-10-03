import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { fetchModelsForProvider, modelsErrorMessage, modelsErrorStatus } from "./aiModels";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchModelsForProvider", () => {
  it("sends the Gemini key in x-goog-api-key, never in the URL", async () => {
    let url = ""; let headers: Headers | undefined;
    globalThis.fetch = (async (input: unknown, init?: { headers?: HeadersInit }) => {
      url = String(input); headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-x", displayName: "Gemini X" }] }), { status: 200 });
    }) as typeof fetch;
    const result = await fetchModelsForProvider("gemini", "secret-key");
    assert.equal(new URL(url).searchParams.has("key"), false);
    assert.equal(url.includes("secret-key"), false);
    assert.equal(headers?.get("x-goog-api-key"), "secret-key");
    assert.equal(headers?.has("authorization"), false);
    assert.deepEqual("models" in result && result.models, [{ id: "gemini-x", name: "Gemini X" }]);
  });

  it("returns generic messages and never forwards provider error text", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "API key sk-LEAK is invalid" } }), { status: 401 })) as typeof fetch;
    const result = await fetchModelsForProvider("openai", "k");
    assert.deepEqual(result, { error: "The provider rejected this key.", status: 400 });
  });

  it("maps statuses", () => {
    assert.equal(modelsErrorMessage(403), "The provider rejected this key.");
    assert.equal(modelsErrorMessage(429), "The provider is rate-limiting this key.");
    assert.equal(modelsErrorMessage(500), "Couldn't fetch models.");
    assert.equal(modelsErrorStatus(429), 429);
    assert.equal(modelsErrorStatus(500), 502);
  });
});
