/**
 * Strips timestamps/cue numbers/formatting out of an .srt or .vtt file's
 * text, leaving just the spoken lines — good enough to feed straight into
 * the same transcript-grounded prompts YouTube captions already use (see
 * buildStarterSummaryPrompt/buildQuizPrompt).
 *
 * Deliberately tiny and dependency-free: both formats are simple enough
 * that a full parser isn't worth pulling in for this.
 */
export function parseSubtitleText(raw: string): string {
  const text = (raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");

  const cueNumberRe = /^\d+$/;
  const timeRangeRe = /-->/;
  const vttHeaderRe = /^WEBVTT/i;
  const vttMetaRe = /^(NOTE|STYLE|REGION)\b/i;

  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (vttHeaderRe.test(trimmed)) continue;
    if (vttMetaRe.test(trimmed)) continue;
    if (cueNumberRe.test(trimmed)) continue;
    if (timeRangeRe.test(trimmed)) continue;
    // Strip inline VTT tags like <c>, <b>, <00:00:01.000> cue-timing tags.
    const withoutTags = trimmed.replace(/<[^>]*>/g, "");
    if (withoutTags) kept.push(withoutTags);
  }

  // Collapse consecutive duplicate lines — a common artifact of VTT files
  // that repeat the previous cue's text while animating word-by-word.
  const deduped: string[] = [];
  for (const line of kept) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }

  return deduped.join("\n").trim();
}

/** True for filenames this parser knows how to handle. */
export function isSubtitleFileName(name: string): boolean {
  return /\.(srt|vtt)$/i.test(name.trim());
}
