/**
 * Splits long extracted text into pieces whose UTF-8 size is at most `maxBytes`,
 * so each fits in one Firestore document (1 MiB limit; Bengali uses 3 bytes per
 * character). Splits only on code point boundaries, so a UTF-16 surrogate pair
 * (emoji, rare CJK) is never cut in half. Joining the chunks returns the exact
 * original text.
 */
export const TEXT_CHUNK_MAX_BYTES = 250_000;

export function splitTextIntoChunks(text: string, maxBytes: number = TEXT_CHUNK_MAX_BYTES): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must hold at least one code point.");
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const size = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      chunks.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += units;
  }
  chunks.push(text.slice(start));
  return chunks;
}

export function joinTextChunks(chunks: readonly string[]): string {
  return chunks.join("");
}

export function chunkDocId(index: number): string {
  return `text_${index}`;
}
