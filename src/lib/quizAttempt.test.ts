import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQuizAttemptBody, validateQuizAttemptInput } from "./quizAttempt";

const validAttempt = {
  videoId: "video-1",
  totalQuestions: 2,
  score: 1,
  answers: [
    { questionId: "question-1", chosenOptionId: "option-2", wasCorrect: true },
    { questionId: "question-2", chosenOptionId: "", wasCorrect: false },
  ],
};

describe("validateQuizAttemptInput", () => {
  it("accepts valid results and optional answer details", () => {
    const result = validateQuizAttemptInput(validAttempt);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.answers, validAttempt.answers);
  });

  it("rejects scores greater than the question count", () => {
    assert.equal(validateQuizAttemptInput({ ...validAttempt, score: 3 }).ok, false);
  });

  it("rejects non-integer counts and scores", () => {
    assert.equal(validateQuizAttemptInput({ ...validAttempt, totalQuestions: 2.5 }).ok, false);
    assert.equal(validateQuizAttemptInput({ ...validAttempt, score: 0.5 }).ok, false);
  });

  it("rejects more than 50 answers", () => {
    const answers = Array.from({ length: 51 }, (_, index) => ({
      questionId: `q${index}`,
      chosenOptionId: "a",
      wasCorrect: true,
    }));
    assert.equal(validateQuizAttemptInput({ ...validAttempt, answers }).ok, false);
  });

  it("rejects missing or overlong identifiers", () => {
    assert.equal(validateQuizAttemptInput({ ...validAttempt, videoId: " " }).ok, false);
    assert.equal(validateQuizAttemptInput({ ...validAttempt, videoId: "v".repeat(201) }).ok, false);
    assert.equal(validateQuizAttemptInput({
      ...validAttempt,
      answers: [{ questionId: "q".repeat(51), chosenOptionId: "a", wasCorrect: true }],
    }).ok, false);
    assert.equal(validateQuizAttemptInput({
      ...validAttempt,
      answers: [{ questionId: "q", chosenOptionId: "a".repeat(51), wasCorrect: true }],
    }).ok, false);
  });
});
describe("buildQuizAttemptBody", () => {
  const questions = [
    { id: "q1", correctOptionId: "a" },
    { id: "q2", correctOptionId: "b" },
    { id: "q3", correctOptionId: "c" },
  ];

  it("derives answers from the questions and marks unanswered ones as wrong", () => {
    const body = buildQuizAttemptBody({
      videoId: "v1", categoryId: "cat", playlistId: "pl", source: "personal",
      score: 1, totalQuestions: 3, questions, selectedAnswers: { q1: "a", q2: "x" },
    });
    assert.deepEqual(body.answers, [
      { questionId: "q1", chosenOptionId: "a", wasCorrect: true },
      { questionId: "q2", chosenOptionId: "x", wasCorrect: false },
      { questionId: "q3", chosenOptionId: "", wasCorrect: false },
    ]);
    assert.equal(body.videoId, "v1");
    assert.equal(body.source, "personal");
  });

  it("produces a body the server validator accepts, and omits undefined optional fields when serialised", () => {
    const body = buildQuizAttemptBody({
      videoId: "d_doc1", source: "document", score: 3, totalQuestions: 3, questions, selectedAnswers: { q1: "a", q2: "b", q3: "c" },
    });
    assert.equal(validateQuizAttemptInput(JSON.parse(JSON.stringify(body))).ok, true);
    assert.equal("categoryId" in JSON.parse(JSON.stringify(body)), false);
  });
});
