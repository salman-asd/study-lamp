import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backupErrorMessage,
  isReconnectError,
  isUsableConnection,
  markConnectionInvalid,
  pickBackupConnection,
  shouldShowReconnectAlert,
} from "./backupConnections";

const active = { id: "a", status: "active" as const };
const invalid = { id: "b", status: "invalid" as const };

describe("usable connections on the Backups page", () => {
  it("treats only invalid connections as unusable", () => {
    assert.equal(isUsableConnection(active), true);
    assert.equal(isUsableConnection(invalid), false);
  });

  it("picks the first usable connection and skips rejected ones", () => {
    assert.equal(pickBackupConnection([invalid, active])?.id, "a");
    assert.equal(pickBackupConnection([invalid]), null);
    assert.equal(pickBackupConnection([]), null);
  });
});

describe("shouldShowReconnectAlert", () => {
  it("shows when a call asked for reconnect", () => {
    assert.equal(shouldShowReconnectAlert([active], true), true);
  });

  it("shows when every connection is rejected, not when there are none", () => {
    assert.equal(shouldShowReconnectAlert([invalid], false), true);
    assert.equal(shouldShowReconnectAlert([invalid, active], false), false);
    assert.equal(shouldShowReconnectAlert([], false), false);
  });
});

describe("isReconnectError", () => {
  it("reads the server's reconnect code", () => {
    assert.equal(isReconnectError(Object.assign(new Error("x"), { code: "reconnect" })), true);
    assert.equal(isReconnectError(Object.assign(new Error("x"), { code: "other" })), false);
    assert.equal(isReconnectError(new Error("x")), false);
    assert.equal(isReconnectError(null), false);
    assert.equal(isReconnectError("reconnect"), false);
  });
});

describe("markConnectionInvalid", () => {
  it("flags only the matching connection and does not mutate the input", () => {
    const input = [active, { id: "c", status: "active" as const }];
    const output = markConnectionInvalid(input, "a");
    assert.equal(output[0].status, "invalid");
    assert.equal(output[1].status, "active");
    assert.equal(input[0].status, "active");
  });
});

describe("backupErrorMessage", () => {
  it("uses a readable message", () => {
    assert.equal(backupErrorMessage(new Error("Couldn't list backups."), "fallback"), "Couldn't list backups.");
  });

  it("never shows raw status text or non-errors", () => {
    assert.equal(backupErrorMessage(new Error("DriveApiError status=401"), "fallback"), "fallback");
    assert.equal(backupErrorMessage(new Error("failed status=502"), "fallback"), "fallback");
    assert.equal(backupErrorMessage("boom", "fallback"), "fallback");
    assert.equal(backupErrorMessage(new Error(""), "fallback"), "fallback");
  });
});
