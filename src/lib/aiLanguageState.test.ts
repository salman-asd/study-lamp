import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLanguageOverridden, nextOverride, resolveEffectiveLanguage, resolveRequestLanguage } from "./aiLanguageState";
import { isBengaliText, langAttributeFor } from "./bengali";
import { languageInstruction } from "./ai/prompts";
import { isAiLanguage, resolveAiLanguage, type AiPreferences } from "./server/aiPreferences";

describe("per-picker language override", () => {
  it("follows the default until the user manually picks something else", () => {
    assert.equal(resolveEffectiveLanguage("bn", null), "bn");
    assert.equal(resolveEffectiveLanguage("en", null), "en");
    // Default changes in Settings -> AI while the picker is untouched: it follows.
    assert.equal(resolveEffectiveLanguage("bn", nextOverride("en", "en")), "bn");
  });

  it("keeps a manual override when the default changes", () => {
    const override = nextOverride("bn", "en");
    assert.equal(override, "en");
    assert.equal(resolveEffectiveLanguage("bn", override), "en");
    assert.equal(resolveEffectiveLanguage("en", override), "en");
    assert.equal(isLanguageOverridden("bn", override), true);
  });

  it("picking the default again clears the override", () => {
    assert.equal(nextOverride("bn", "bn"), null);
    assert.equal(isLanguageOverridden("bn", null), false);
  });
});

describe("languageInstruction", () => {
  it("asks for the right language and keeps JSON structure unchanged", () => {
    assert.match(languageInstruction("en"), /entire response in English/);
    assert.match(languageInstruction("bn"), /Bengali \(Bangla/);
    assert.match(languageInstruction("bn"), /Do not translate the source material/);
    for (const language of ["en", "bn"] as const) assert.match(languageInstruction(language), /JSON keys, IDs and required structural values unchanged/);
  });
});

describe("resolveAiLanguage", () => {
  const saved = (generatingLanguage: "en" | "bn"): ((uid: string) => Promise<AiPreferences>) => async () => ({ speechToTextEnabled: false, generatingLanguage });

  it("falls back to the saved default only when no language is sent", async () => {
    assert.equal(await resolveAiLanguage("uid", undefined, saved("bn")), "bn");
    assert.equal(await resolveAiLanguage("uid", undefined, saved("en")), "en");
  });

  it("uses an explicit EN/BN request over the saved default", async () => {
    assert.equal(await resolveAiLanguage("uid", "en", saved("bn")), "en");
    assert.equal(await resolveAiLanguage("uid", "bn", saved("en")), "bn");
  });

  it("rejects anything else (routes answer 400 'language must be en or bn.')", async () => {
    for (const bad of ["ar", "EN", "", null, 5, {}]) assert.equal(await resolveAiLanguage("uid", bad, saved("en")), null);
    assert.equal(isAiLanguage("ar"), false);
  });
});

describe("Bengali helpers", () => {
  it("detects Bengali text by Unicode range", () => {
    assert.equal(isBengaliText("বাংলা ভাষা"), true);
    assert.equal(isBengaliText("Mixed text with বাংলা"), true);
    assert.equal(isBengaliText("English only"), false);
    assert.equal(isBengaliText(""), false);
    assert.equal(isBengaliText(null), false);
    assert.equal(langAttributeFor("বাংলা"), "bn");
    assert.equal(langAttributeFor("plain"), undefined);
  });
});

describe("resolveRequestLanguage", () => {
  it("sends the effective language when the saved default loaded", () => {
    assert.equal(resolveRequestLanguage({ defaultLanguage: "bn", override: null, loadFailed: false }), "bn");
    assert.equal(resolveRequestLanguage({ defaultLanguage: "bn", override: "en", loadFailed: false }), "en");
  });
  it("sends nothing when the default failed to load and the user has not chosen, so the server uses the saved default", () => {
    assert.equal(resolveRequestLanguage({ defaultLanguage: "en", override: null, loadFailed: true }), undefined);
  });
  it("still honours a manual pick when the default failed to load", () => {
    assert.equal(resolveRequestLanguage({ defaultLanguage: "en", override: "bn", loadFailed: true }), "bn");
    assert.equal(resolveRequestLanguage({ defaultLanguage: "en", override: "en", loadFailed: true }), "en");
  });
});
