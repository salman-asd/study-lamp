import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateQuizAttemptInput } from "./quizAttempt";

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