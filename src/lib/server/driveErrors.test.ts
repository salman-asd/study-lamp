import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DRIVE_ERROR_MESSAGES } from "@/lib/driveErrors";
import {
  RECONNECT_ROUTE_MESSAGE,
  RejectionThrottle,
  mapDriveRouteError,
  markConnectionRejected,
  shouldMarkConnectionRejected,
  type RejectionStore,
} from "./driveErrors";

class FakeDriveApiError extends Error {
  constructor(readonly status: number, message = "raw google text ya29.SECRET") {
    super(message);
    this.name = "DriveApiError";
  }
}

class FakeConnectionError extends Error {
  constructor(readonly code: "not_found" | "invalid" | "network", message: string) {
    super(message);
    this.name = "DriveConnectionError";
  }
}

const FALLBACK = "Couldn't list backups from Drive.";

describe("mapDriveRouteError", () => {
  it("maps connection errors", () => {
    assert.deepEqual(mapDriveRouteError(new FakeConnectionError("not_found", "gone"), FALLBACK), { status: 404, body: { error: "gone" } });
    assert.deepEqual(mapDriveRouteError(new FakeConnectionError("invalid", "reconnect me"), FALLBACK), { status: 409, body: { error: "reconnect me", code: "reconnect" } });
    assert.deepEqual(mapDriveRouteError(new FakeConnectionError("network", "offline"), FALLBACK), { status: 503, body: { error: "offline" } });
  });

  it("treats a Google 401 that survived the retry as reconnect, never 502", () => {
    assert.deepEqual(mapDriveRouteError(new FakeDriveApiError(401), FALLBACK), {
      status: 409,
      body: { error: RECONNECT_ROUTE_MESSAGE, code: "reconnect" },
    });
  });

  it("maps a Google 403 to the fixed permission wording", () => {
    assert.deepEqual(mapDriveRouteError(new FakeDriveApiError(403), FALLBACK), { status: 403, body: { error: DRIVE_ERROR_MESSAGES.permission } });
  });

  it("keeps everything else a generic 502 and never echoes raw error text", () => {
    for (const err of [new FakeDriveApiError(500), new FakeDriveApiError(429), new Error("ya29.SECRET boom"), "string", null, undefined]) {
      const result = mapDriveRouteError(err, FALLBACK);
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: FALLBACK });
    }
  });

  it("never leaks token-like text for any mapped response", () => {
    const all = [new FakeDriveApiError(401), new FakeDriveApiError(403), new FakeDriveApiError(500)].map((err) => JSON.stringify(mapDriveRouteError(err, FALLBACK)));
    for (const text of all) assert.equal(text.includes("ya29"), false);
  });

  it("does not confuse a DriveApiError with code not_found for a connection error", () => {
    const apiError = Object.assign(new FakeDriveApiError(404), { code: "not_found" });
    assert.equal(mapDriveRouteError(apiError, FALLBACK).status, 502);
  });
});

describe("shouldMarkConnectionRejected", () => {
  it("is true only for a Google 401", () => {
    assert.equal(shouldMarkConnectionRejected(new FakeDriveApiError(401)), true);
    assert.equal(shouldMarkConnectionRejected(new FakeDriveApiError(403)), false);
    assert.equal(shouldMarkConnectionRejected(new FakeDriveApiError(500)), false);
    assert.equal(shouldMarkConnectionRejected(new FakeConnectionError("invalid", "x")), false);
    assert.equal(shouldMarkConnectionRejected(new Error("401")), false);
  });
});

function recordingStore(exists = true) {
  const calls: string[] = [];
  const store: RejectionStore = {
    async markInvalid(uid, connectionId) {
      calls.push(`mark:${uid}:${connectionId}`);
      return exists;
    },
    invalidateToken(uid, connectionId) {
      calls.push(`invalidate:${uid}:${connectionId}`);
    },
  };
  return { store, calls };
}

describe("markConnectionRejected", () => {
  it("writes once per connection per hour", async () => {
    const { store, calls } = recordingStore();
    const throttle = new RejectionThrottle();
    assert.equal(await markConnectionRejected(store, throttle, "u1", "c1", 1_000), true);
    assert.equal(await markConnectionRejected(store, throttle, "u1", "c1", 2_000), false);
    assert.equal(calls.filter((call) => call.startsWith("mark:")).length, 1);
    // The cached token is dropped on every call, even when no write is made.
    assert.equal(calls.filter((call) => call.startsWith("invalidate:")).length, 2);
  });

  it("writes again after an hour and keeps connections independent", async () => {
    const { store, calls } = recordingStore();
    const throttle = new RejectionThrottle(60 * 60_000);
    await markConnectionRejected(store, throttle, "u1", "c1", 0);
    await markConnectionRejected(store, throttle, "u1", "c2", 10);
    await markConnectionRejected(store, throttle, "u1", "c1", 60 * 60_000 + 1);
    assert.deepEqual(calls.filter((call) => call.startsWith("mark:")), ["mark:u1:c1", "mark:u1:c2", "mark:u1:c1"]);
  });

  it("reports false when the connection does not exist", async () => {
    const { store } = recordingStore(false);
    assert.equal(await markConnectionRejected(store, new RejectionThrottle(), "u1", "c1", 0), false);
  });
});
