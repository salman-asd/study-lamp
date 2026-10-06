import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { AiServiceError, type AiErrorCode } from "@/lib/ai/errors";
import { AI_STATUS_BY_CODE, aiErrorResponse, createAuthedRoute, readJsonObject, withAuthedRoute } from "./routeHelpers";
import { logServerError } from "./logError";

describe("AI_STATUS_BY_CODE", () => {
  it("keeps the status table every route used before the refactor", () => {
    assert.deepEqual(AI_STATUS_BY_CODE, {
      auth: 400, rate_limit: 429, invalid_request: 502, blocked: 422,
      timeout: 504, network: 502, server_error: 502, unsupported_provider: 400, unknown: 500,
    });
  });
});

describe("aiErrorResponse", () => {
  const codes = Object.keys(AI_STATUS_BY_CODE) as AiErrorCode[];

  it("maps every AiServiceError code to its status and keeps the message", async () => {
    for (const code of codes) {
      const response = aiErrorResponse(new AiServiceError(code, `msg-${code}`), { fallbackMessage: "fallback" });
      assert.equal(response.status, AI_STATUS_BY_CODE[code]);
      assert.deepEqual(await response.json(), { error: `msg-${code}` });
    }
  });

  it("hides AiServiceError messages at status >= 500 only when asked", async () => {
    const hidden = aiErrorResponse(new AiServiceError("server_error", "provider detail"), { fallbackMessage: "generic", hideServerMessages: true });
    assert.equal(hidden.status, 502);
    assert.deepEqual(await hidden.json(), { error: "generic" });

    const visible = aiErrorResponse(new AiServiceError("blocked", "refused"), { fallbackMessage: "generic", hideServerMessages: true });
    assert.equal(visible.status, 422);
    assert.deepEqual(await visible.json(), { error: "refused" });
  });

  it("returns 500 with the fallback for unexpected errors and logs only the error name", async () => {
    const log = mock.method(console, "error", () => {});
    try {
      const response = aiErrorResponse(new TypeError("secret-api-key-in-message"), { fallbackMessage: "Something went wrong.", logLabel: "Failed" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Something went wrong." });
      assert.equal(log.mock.calls.length, 1);
      assert.deepEqual(log.mock.calls[0].arguments, ["Failed: TypeError"]);
    } finally {
      log.mock.restore();
    }
  });
});

describe("logServerError", () => {
  it("logs only the label, error name and numeric status when present", () => {
    const log = mock.method(console, "error", () => {});
    try {
      const err = Object.assign(new TypeError("secret"), { status: 503 });
      logServerError("Drive import failed", err);
      assert.deepEqual(log.mock.calls[0].arguments, ["Drive import failed: TypeError status=503"]);
    } finally {
      log.mock.restore();
    }
  });
});

describe("readJsonObject", () => {
  const post = (body: string) => new Request("http://localhost/x", { method: "POST", body });

  it("returns the parsed object", async () => {
    const result = await readJsonObject(post('{"a":1}'));
    assert.deepEqual(result, { ok: true, body: { a: 1 } });
  });

  it("returns a 400 'Invalid JSON body.' for bad JSON, null, arrays and primitives", async () => {
    for (const raw of ["{nope", "null", "[1]", "3", '"x"', ""]) {
      const result = await readJsonObject(post(raw));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.response.status, 400);
        assert.deepEqual(await result.response.json(), { error: "Invalid JSON body." });
      }
    }
  });
});

describe("withAuthedRoute", () => {
  it("returns 401 Unauthorized without a bearer token and never calls the handler", async () => {
    let called = false;
    const route = withAuthedRoute(() => { called = true; return new Response("ok"); }, { scope: "test:noauth" });
    const response = await route(new NextRequest("http://localhost/api/x"), { params: {} });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
    assert.equal(called, false);
  });
});

describe("createAuthedRoute", () => {
  const request = () => new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer t" } });

  it("passes uid, req and params to the handler", async () => {
    const route = createAuthedRoute<{ id: string }>(
      async () => "user-1",
      ({ uid, params, req }) => Response.json({ uid, id: params.id, hasReq: req instanceof NextRequest }),
    );
    const response = await route(request(), { params: { id: "abc" } });
    assert.deepEqual(await response.json(), { uid: "user-1", id: "abc", hasReq: true });
  });

  it("returns the standard 429 with Retry-After once the limit is used up", async () => {
    const route = createAuthedRoute(async () => "limited-user", () => new Response("ok"), { scope: "test:limit-default", limit: 2 });
    assert.equal((await route(request(), { params: {} })).status, 200);
    assert.equal((await route(request(), { params: {} })).status, 200);
    const blocked = await route(request(), { params: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("Retry-After"), "60");
    assert.deepEqual(await blocked.json(), { error: "Too many requests." });
  });

  it("supports a custom 429 message and no Retry-After header", async () => {
    const route = createAuthedRoute(async () => "limited-user-2", () => new Response("ok"), {
      scope: "test:limit-custom", limit: 1, tooManyMessage: "Too many requests. Please slow down.", retryAfterSeconds: null,
    });
    await route(request(), { params: {} });
    const blocked = await route(request(), { params: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("Retry-After"), null);
    assert.deepEqual(await blocked.json(), { error: "Too many requests. Please slow down." });
  });

  it("does not rate limit when no scope is given", async () => {
    const route = createAuthedRoute(async () => "free-user", () => new Response("ok"));
    for (let i = 0; i < 100; i++) assert.equal((await route(request(), { params: {} })).status, 200);
  });

  it("rejects before the limiter and handler when authentication fails", async () => {
    let called = false;
    const route = createAuthedRoute(async () => null, () => { called = true; return new Response("ok"); }, { scope: "test:limit-401", limit: 1 });
    assert.equal((await route(request(), { params: {} })).status, 401);
    assert.equal(called, false);
  });

  it("authenticates once for admin routes and returns 403 for non-admins", async () => {
    let authCalls = 0;
    let called = false;
    const authenticate = async () => { authCalls++; return "plain-user"; };
    const route = createAuthedRoute(authenticate, () => { called = true; return new Response("ok"); }, { admin: true }, async () => false);
    const response = await route(request(), { params: {} });
    assert.equal(response.status, 403);
    assert.equal(authCalls, 1);
    assert.equal(called, false);
  });

  it("runs the handler for admins with the authenticated uid", async () => {
    let authCalls = 0;
    const route = createAuthedRoute(
      async () => { authCalls++; return "admin-1"; },
      ({ uid }) => Response.json({ uid }),
      { admin: true },
      async (uid) => uid === "admin-1",
    );
    const response = await route(request(), { params: {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { uid: "admin-1" });
    assert.equal(authCalls, 1);
  });
});
