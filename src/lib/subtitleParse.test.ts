import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSubtitleFileName, parseSubtitleText } from "./subtitleParse";

describe("parseSubtitleText", () => {
  it("strips cue numbers and timestamps from an .srt file", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:02,500",
      "Hello and welcome.",
      "",
      "2",
      "00:00:02,500 --> 00:00:05,000",
      "Today we're covering plants.",
    ].join("\n");

    assert.equal(parseSubtitleText(srt), "Hello and welcome.\nToday we're covering plants.");
  });

  it("strips the WEBVTT header, cue timing lines, and inline tags from a .vtt file", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<c>Hello</c> and welcome.",
      "",
      "NOTE this is a comment",
      "00:00:02.000 --> 00:00:04.000",
      "Today we're covering plants.",
    ].join("\n");

    assert.equal(parseSubtitleText(vtt), "Hello and welcome.\nToday we're covering plants.");
  });

  it("collapses consecutive duplicate lines from word-by-word VTT cues", () => {
    const vtt = [
      "00:00:00.000 --> 00:00:01.000",
      "Hello",
      "00:00:01.000 --> 00:00:02.000",
      "Hello",
      "00:00:02.000 --> 00:00:03.000",
      "Hello there",
    ].join("\n");

    assert.equal(parseSubtitleText(vtt), "Hello\nHello there");
  });

  it("returns an empty string for blank input", () => {
    assert.equal(parseSubtitleText(""), "");
  });
});

describe("isSubtitleFileName", () => {
  it("accepts .srt and .vtt regardless of case", () => {
    assert.equal(isSubtitleFileName("captions.srt"), true);
    assert.equal(isSubtitleFileName("captions.VTT"), true);
  });

  it("rejects other extensions", () => {
    assert.equal(isSubtitleFileName("notes.txt"), false);
    assert.equal(isSubtitleFileName("video.mp4"), false);
  });
});
