import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRIVE_ERROR_MESSAGES, classifyDriveExportError, driveHttpStatusForCode, driveResponseErrorMessage, extractGoogleErrorReason,
} from "./driveErrors";

describe("Drive export error classification", () => {
  it("reports 403 as too large only for the size-limit reason", () => {
    assert.equal(classifyDriveExportError(403, "exportSizeLimitExceeded"), "too_large");
  });

  it("reports other 403s as a permission problem, not 'too large'", () => {
    assert.equal(classifyDriveExportError(403, "forbidden"), "permission");
    assert.equal(classifyDriveExportError(403, "insufficientFilePermissions"), "permission");
    assert.equal(classifyDriveExportError(403, null), "permission");
    assert.equal(classifyDriveExportError(403), "permission");
  });

  it("classifies 404, 401 and everything else", () => {
    assert.equal(classifyDriveExportError(404), "not_found");
    assert.equal(classifyDriveExportError(401), "auth");
    assert.equal(classifyDriveExportError(500), "upstream");
    assert.equal(classifyDriveExportError(429), "upstream");
  });

  it("gives every code a different message and a sensible HTTP status", () => {
    const messages = Object.values(DRIVE_ERROR_MESSAGES);
    assert.equal(new Set(messages).size, messages.length);
    assert.equal(driveHttpStatusForCode("unsupported_type"), 400);
    assert.equal(driveHttpStatusForCode("permission"), 403);
    assert.equal(driveHttpStatusForCode("not_found"), 404);
    assert.equal(driveHttpStatusForCode("too_large"), 413);
    assert.equal(driveHttpStatusForCode("upstream"), 502);
  });
});

describe("extractGoogleErrorReason", () => {
  it("reads the reason from a Google error body", () => {
    const body = { error: { code: 403, message: "secret detail", errors: [{ reason: "exportSizeLimitExceeded", message: "x" }] } };
    assert.equal(extractGoogleErrorReason(body), "exportSizeLimitExceeded");
  });

  it("returns null for anything else", () => {
    for (const body of [null, undefined, "x", {}, { error: "x" }, { error: { errors: [] } }, { error: { errors: [{ reason: 5 }] } }]) {
      assert.equal(extractGoogleErrorReason(body), null);
    }
  });
});

describe("driveResponseErrorMessage", () => {
  it("maps known codes to fixed messages and never echoes server text", async () => {
    const res = new Response(JSON.stringify({ error: "leaky server text", code: "permission" }), { status: 403 });
    assert.equal(await driveResponseErrorMessage(res, "fallback"), DRIVE_ERROR_MESSAGES.permission);
  });

  it("falls back for unknown codes and non-JSON bodies", async () => {
    assert.equal(await driveResponseErrorMessage(new Response("nope", { status: 502 }), "fallback"), "fallback");
    assert.equal(await driveResponseErrorMessage(new Response(JSON.stringify({ code: "weird" }), { status: 500 }), "fallback"), "fallback");
    assert.equal(await driveResponseErrorMessage(new Response("", { status: 404 }), "fallback"), DRIVE_ERROR_MESSAGES.not_found);
  });
});
