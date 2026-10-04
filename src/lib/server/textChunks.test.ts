import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { joinTextChunks, splitTextIntoChunks, TEXT_CHUNK_MAX_BYTES } from "./textChunks";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("splitTextIntoChunks", () => {
  it("returns one chunk for short text and none for empty text", () => {
    assert.deepEqual(splitTextIntoChunks("hello"), ["hello"]);
    assert.deepEqual(splitTextIntoChunks(""), []);
  });

  it("keeps every chunk within the byte limit and round-trips exactly (Bengali, 3 bytes/char)", () => {
    const text = "বাংলা ভাষা ".repeat(40_000); // ~ 1 MB of UTF-8
    const chunks = splitTextIntoChunks(text);
    assert.ok(chunks.length >= 4);
    assert.ok(chunks.every((chunk) => bytes(chunk) <= TEXT_CHUNK_MAX_BYTES));
    assert.equal(joinTextChunks(chunks), text);
  });

  it("never splits a UTF-16 surrogate pair", () => {
    const text = "a😀".repeat(1000);
    const chunks = splitTextIntoChunks(text, 7); // forces cuts between 4-byte emoji
    for (const chunk of chunks) {
      assert.ok(bytes(chunk) <= 7);
      assert.equal(chunk, Buffer.from(chunk, "utf8").toString("utf8"), "no lone surrogates");
    }
    assert.equal(joinTextChunks(chunks), text);
  });

  it("rejects an impossible limit", () => {
    assert.throws(() => splitTextIntoChunks("x", 3));
  });
});
