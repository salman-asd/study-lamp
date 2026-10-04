import crypto from "crypto";

// Server-only. Never import this file from a "use client" component or
// anything that ends up in a browser bundle — encryptApiKey/decryptApiKey
// read a server secret and must only ever run inside API routes (see
// src/app/api/ai/connections/route.ts and friends, Phase 2).
//
// Uses Node's built-in crypto (no new dependency) with AES-256-GCM:
// authenticated encryption, so a tampered ciphertext fails to decrypt
// instead of silently producing garbage that gets sent to a provider.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV, the size GCM is designed for
const AUTH_TAG_LENGTH = 16;
const KEY_ENV_VAR = "AI_CONNECTION_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV_VAR = "AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS";

// Generate a key with: openssl rand -base64 32
// Set it as a server-only env var (no NEXT_PUBLIC_ prefix), the same way
// this repo already handles YOUTUBE_API_KEY / FACEBOOK_PAGE_ACCESS_TOKEN.
function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key (AES-256).`);
  }
  return key;
}

function getKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw) {
    throw new Error(
      `${KEY_ENV_VAR} is not configured. Generate one with "openssl rand -base64 32" and set it as a server-only environment variable.`
    );
  }
  return decodeKey(raw, KEY_ENV_VAR);
}

/**
 * Encrypts a plaintext provider API key for storage in the
 * users/{uid}/aiConnections/{connectionId} document. Call this only from a
 * server-side API route, right before writing to Firestore — never persist
 * the plaintext anywhere, and never log it.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Single base64 blob: iv || authTag || ciphertext. Keeping everything
  // needed to decrypt in one field keeps the Firestore document shape
  // simple (see AiConnection.encryptedApiKey in src/types/index.ts).
  return `v1:${Buffer.concat([iv, authTag, ciphertext]).toString("base64")}`;
}

/**
 * Decrypts a value previously produced by encryptApiKey. Call this only at
 * the moment a connection is actually used — to call the provider (Phase 5)
 * or to run a "Test Connection" check (Phase 2) — never to serve a value
 * back to the client. Throws if the payload was tampered with or the key is
 * wrong (GCM authentication failure), which callers should treat as "this
 * connection is broken," not silently ignore.
 */
export function decryptApiKey(payload: string): string {
  const versioned = payload.startsWith("v1:");
  if (!versioned && /^[a-z]\d*:/i.test(payload)) {
    throw new Error("Unsupported encrypted credential version.");
  }
  const encoded = versioned ? payload.slice(3) : payload;
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) throw new Error("Encrypted credential is invalid.");

  for (const name of [KEY_ENV_VAR, PREVIOUS_KEY_ENV_VAR]) {
    const configuredKey = process.env[name];
    if (!configuredKey) continue;
    let key: Buffer;
    try {
      key = decodeKey(configuredKey, name);
    } catch {
      continue;
    }

    try {
      const iv = raw.subarray(0, IV_LENGTH);
      const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Try the previous rotation key for older stored credentials.
    }
  }

  throw new Error("Could not decrypt the stored credential with the configured encryption keys.");
}

/**
 * Produces the safe-to-return projection of a raw API key (e.g.
 * "••••••••ab12"), computed once from the plaintext at connection-creation
 * time and stored as AiConnection.maskedKey. This means listing/reading
 * connections (Phase 2's GET /api/ai/connections) never needs to call
 * decryptApiKey at all — decryption stays reserved for the two cases above.
 */
export function maskApiKey(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••••••${trimmed.slice(-4)}`;
}
