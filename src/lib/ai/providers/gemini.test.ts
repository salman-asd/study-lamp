import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { generateWithGemini, validateGeminiConnection } from "./gemini";
import type { AiConnectionCredentials } from "../types";

type FetchArgs = Parameters<typeof fetch>;

describe("Gemini API-key header handling", () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestHeaders: HeadersInit | undefined;

  before(() => {
    globalThis.fetch = (async (...args: FetchArgs) => {
      requestedUrl = String(args[0]);
      requestHeaders = args[1]?.headers;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "generated" }] } }] }), { status: 200 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends generation keys in the header, never in the URL", async () => {
    const credentials: AiConnectionCredentials = { provider: "gemini", apiKey: "test-secret-key", model: "gemini-test" };
    assert.equal(await generateWithGemini(credentials, "prompt"), "generated");
    assert.equal(new URL(requestedUrl).searchParams.has("key"), false);
    assert.equal(new Headers(requestHeaders).get("x-goog-api-key"), "test-secret-key");
  });

  it("sends validation keys in the header, never in the URL", async () => {
    const result = await validateGeminiConnection("test-secret-key");
    assert.equal(result.ok, true);
    assert.equal(new URL(requestedUrl).searchParams.has("key"), false);
    assert.equal(new Headers(requestHeaders).get("x-goog-api-key"), "test-secret-key");
  });
});