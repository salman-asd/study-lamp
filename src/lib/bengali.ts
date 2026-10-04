/** Bengali Unicode block (U+0980-U+09FF). */
const BENGALI_PATTERN = /[\u0980-\u09FF]/;

/** True when the text contains any Bengali characters; used to mark AI output with lang="bn". */
export function isBengaliText(text: string | null | undefined): boolean {
  return !!text && BENGALI_PATTERN.test(text);
}

/** `lang` attribute value for a piece of displayed text, or undefined to inherit. */
export function langAttributeFor(text: string | null | undefined): "bn" | undefined {
  return isBengaliText(text) ? "bn" : undefined;
}
