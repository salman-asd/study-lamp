import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decryptApiKey, encryptApiKey } from "./aiEncryption";

function withKeys<T>(current: string | undefined, previous: string | undefined, run: () => T): T {
  const originalCurrent = process.env.AI_CONNECTION_ENCRYPTION_KEY;
  const originalPrevious = process.env.AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS;
  if (current === undefined) delete process.env.AI_CONNECTION_ENCRYPTION_KEY;
  else process.env.AI_CONNECTION_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS;
  else process.env.AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS = previous;
  try {
    return run();
  } finally {
    if (originalCurrent === undefined) delete process.env.AI_CONNECTION_ENCRYPTION_KEY;
    else process.env.AI_CONNECTION_ENCRYPTION_KEY = originalCurrent;
    if (originalPrevious === undefined) delete process.env.AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS;
    else process.env.AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS = originalPrevious;
  }
}

describe("AI credential encryption versioning", () => {
  it("writes v1-prefixed ciphertext and decrypts both versioned and legacy values", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    withKeys(key, undefined, () => {
      const encrypted = encryptApiKey("provider-secret");
      assert.match(encrypted, /^v1:/);
      assert.equal(decryptApiKey(encrypted), "provider-secret");
      assert.equal(decryptApiKey(encrypted.slice(3)), "provider-secret");
      assert.throws(() => decryptApiKey("v2:not-a-ciphertext"), /Unsupported encrypted credential version/);
    });
  });

  it("decrypts with the previous key during rotation while encrypting with the current key", () => {
    const oldKey = Buffer.alloc(32, 2).toString("base64");
    const newKey = Buffer.alloc(32, 3).toString("base64");
    let oldCiphertext = "";
    withKeys(oldKey, undefined, () => { oldCiphertext = encryptApiKey("drive-refresh-token"); });
    withKeys(newKey, oldKey, () => {
      assert.equal(decryptApiKey(oldCiphertext), "drive-refresh-token");
      assert.equal(decryptApiKey(encryptApiKey("new-ai-key")), "new-ai-key");
    });
  });
});