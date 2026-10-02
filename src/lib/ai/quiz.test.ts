import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseQuizQuestionsFromText, parseRoadmapPlanFromText, withResponseLanguage } from "./aiService";
import { buildQuizPrompt } from "./prompts";

describe("parseQuizQuestionsFromText", () => {
  it("parses a valid JSON quiz response with the expected shape", () => {
    const result = parseQuizQuestionsFromText([
      "```json",
      "[",
      "  {",
      "    \"id\": \"q1\",",
      "    \"prompt\": \"What is the main idea?\",",
      "    \"options\": [{ \"id\": \"a\", \"text\": \"Alpha\" }, { \"id\": \"b\", \"text\": \"Beta\" }],",
      "    \"correctOptionId\": \"a\",",
      "    \"explanation\": \"Alpha is correct because it matches the transcript.\"",
      "  }",
      "]",
      "```",
    ].join("\n"));

    assert.deepEqual(result, [{
      id: "q1",
      prompt: "What is the main idea?",
      options: [{ id: "a", text: "Alpha" }, { id: "b", text: "Beta" }],
      correctOptionId: "a",
      explanation: "Alpha is correct because it matches the transcript.",
    }]);
  });

  it("accepts markdown-fenced JSON with surrounding explanation text", () => {
    const result = parseQuizQuestionsFromText([
      "Here is the quiz you asked for:",
      "```json",
      "[",
      "  {",
      "    \"id\": \"q1\",",
      "    \"prompt\": \"What is the main idea?\",",
      "    \"options\": [{ \"id\": \"a\", \"text\": \"Alpha\" }, { \"id\": \"b\", \"text\": \"Beta\" }],",
      "    \"correctOptionId\": \"a\",",
      "    \"explanation\": \"Alpha is correct because it matches the transcript.\"",
      "  }",
      "]",
      "```",
      "Thanks!",
    ].join("\n"));

    assert.equal(result.length, 1);
    assert.equal(result[0].prompt, "What is the main idea?");
  });

  it("accepts a raw JSON array with leading or trailing prose", () => {
    const result = parseQuizQuestionsFromText([
      "Here is the quiz:",
      "[",
      "  {",
      "    \"id\": \"q1\",",
      "    \"prompt\": \"What is the main idea?\",",
      "    \"options\": [{ \"id\": \"a\", \"text\": \"Alpha\" }, { \"id\": \"b\", \"text\": \"Beta\" }],",
      "    \"correctOptionId\": \"a\",",
      "    \"explanation\": \"Alpha is correct because it matches the transcript.\"",
      "  }",
      "]",
      "Thanks!",
    ].join("\n"));

    assert.equal(result.length, 1);
    assert.equal(result[0].prompt, "What is the main idea?");
  });

  it("rejects malformed JSON or missing required fields", () => {
    assert.throws(() => parseQuizQuestionsFromText("not-json"), /Invalid quiz response/);
    assert.throws(() => parseQuizQuestionsFromText(JSON.stringify([{ prompt: "oops" }])), /Invalid quiz response/);
    assert.throws(() => parseQuizQuestionsFromText(JSON.stringify([{
      prompt: "What is correct?",
      options: [{ id: "a", text: "Alpha" }, { id: "b", text: "Beta" }],
      correctOptionId: "missing",
      explanation: "The answer is in the lesson.",
    }])), /Invalid quiz response/);
  });

  it("prioritizes transcript over saved summary, and both over title and description, in the quiz prompt", () => {
    const prompt = buildQuizPrompt({
      title: "Intro to plants",
      description: "A short overview of plant biology.",
      transcript: "Plants use chlorophyll to capture sunlight. The roots absorb water.",
      summary: "<h3>Summary</h3><p>Plants use chlorophyll to capture sunlight.</p>",
    });

    assert.ok(prompt.includes("Transcript:"));
    assert.ok(prompt.includes("Saved summary"));
    assert.ok(prompt.includes("Title:"));
    assert.ok(prompt.includes("Description:"));
    assert.ok(prompt.indexOf("Transcript:") < prompt.indexOf("Saved summary"));
    assert.ok(prompt.indexOf("Saved summary") < prompt.indexOf("Title:"));
  });

  it("enforces a fixed question-type mix: recall, conceptual, application, reasoning", () => {
    const prompt = buildQuizPrompt({
      title: "Intro to plants",
      transcript: "Plants use chlorophyll to capture sunlight.",
    });

    assert.ok(/direct\/recall/i.test(prompt));
    assert.ok(/conceptual/i.test(prompt));
    assert.ok(/application/i.test(prompt) && /new scenario/i.test(prompt));
    assert.ok(/reasoning\/inference/i.test(prompt));
    assert.ok(/answerable from the material alone/i.test(prompt));
  });
});

describe("parseRoadmapPlanFromText", () => {
  it("parses an unfenced roadmap object even though it contains nested arrays", () => {
    const result = parseRoadmapPlanFromText(JSON.stringify({
      basic: [{ title: "Basics", description: "Learn foundations.", order: 1 }],
      intermediate: [{ title: "Practice", description: "Build projects.", order: 1 }],
      advanced: [{ title: "Mastery", description: "Apply advanced concepts.", order: 1 }],
    }));

    assert.equal(result.basic[0].title, "Basics");
    assert.equal(result.intermediate[0].title, "Practice");
    assert.equal(result.advanced[0].title, "Mastery");
  });
});

describe("withResponseLanguage", () => {
  it("defaults AI prompts to English", () => {
    assert.match(withResponseLanguage("Generate a summary."), /Respond in English/);
  });

  it("requests Bengali learner-facing text while preserving JSON structure", () => {
    const prompt = withResponseLanguage("Return {\"title\":\"string\"}.", "bn");
    assert.match(prompt, /Respond in Bengali \(Bangla\)/);
    assert.match(prompt, /Keep JSON keys, IDs, and required structural values unchanged/);
  });
});
