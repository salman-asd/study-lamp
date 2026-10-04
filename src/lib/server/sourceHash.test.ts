import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSourceHash, hashDocumentText, PROMPT_VERSION } from "./sourceHash";

const base = { kind: "video-quiz" as const, title: "Intro", description: "d", summary: null, text: "Plants use chlorophyll.", language: "en" as const, promptVersion: "v1" };

describe("buildSourceHash", () => {
  it("is a stable SHA-256 hex digest for the same input", () => {
    assert.match(buildSourceHash(base), /^[0-9a-f]{64}$/);
    assert.equal(buildSourceHash(base), buildSourceHash({ ...base }));
  });

  it("changes when language, prompt version, text or kind changes", () => {
    const hash = buildSourceHash(base);
    assert.notEqual(buildSourceHash({ ...base, language: "bn" }), hash);
    assert.notEqual(buildSourceHash({ ...base, promptVersion: "v2" }), hash);
    assert.notEqual(buildSourceHash({ ...base, text: "Plants use chlorophyll and roots." }), hash);
    assert.notEqual(buildSourceHash({ ...base, kind: "document-quiz" }), hash);
  });

  it("does not let adjacent fields run together", () => {
    assert.notEqual(
      buildSourceHash({ ...base, title: "a", description: "b" }),
      buildSourceHash({ ...base, title: "a\nb", description: "" }),
    );
  });

  it("uses the current PROMPT_VERSION by default", () => {
    const { promptVersion: _ignored, ...withoutVersion } = base;
    assert.equal(buildSourceHash(withoutVersion), buildSourceHash({ ...withoutVersion, promptVersion: PROMPT_VERSION }));
  });

  it("hashes document text with SHA-256", () => {
    assert.match(hashDocumentText("hello"), /^[0-9a-f]{64}$/);
    assert.notEqual(hashDocumentText("a"), hashDocumentText("b"));
  });
});
