export interface QuizAttemptAnswerInput {
  questionId: string;
  chosenOptionId: string;
  wasCorrect: boolean;
}

export interface QuizAttemptInput {
  videoId: string;
  totalQuestions: number;
  score: number;
  categoryId?: string;
  playlistId?: string;
  source?: "shared" | "personal" | "document";
  answers?: QuizAttemptAnswerInput[];
}

/** The minimal question shape needed to grade an attempt. */
export interface GradableQuizQuestion {
  id: string;
  correctOptionId: string;
}

export interface QuizAttemptPayload {
  videoId: string;
  categoryId?: string;
  playlistId?: string;
  source: NonNullable<QuizAttemptInput["source"]>;
  score: number;
  totalQuestions: number;
  questions: GradableQuizQuestion[];
  selectedAnswers: Record<string, string>;
}

/** Builds the JSON body POSTed to /api/quiz-attempts (the answers array is derived from the questions). */
export function buildQuizAttemptBody(payload: QuizAttemptPayload): QuizAttemptInput {
  return {
    videoId: payload.videoId,
    categoryId: payload.categoryId,
    playlistId: payload.playlistId,
    source: payload.source,
    score: payload.score,
    totalQuestions: payload.totalQuestions,
    answers: payload.questions.map((question) => ({
      questionId: question.id,
      chosenOptionId: payload.selectedAnswers[question.id] || "",
      wasCorrect: payload.selectedAnswers[question.id] === question.correctOptionId,
    })),
  };
}

export type QuizAttemptValidationResult =
  | { ok: true; value: QuizAttemptInput }
  | { ok: false; error: string };

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined | null {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function validateQuizAttemptInput(body: unknown): QuizAttemptValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A valid quiz result is required." };
  }

  const record = body as Record<string, unknown>;
  const videoId = typeof record.videoId === "string" ? record.videoId.trim() : "";
  const { score, totalQuestions } = record;
  if (!videoId || videoId.length > 200) {
    return { ok: false, error: "A valid videoId is required." };
  }
  if (!Number.isInteger(totalQuestions) || (totalQuestions as number) < 1 || (totalQuestions as number) > 50) {
    return { ok: false, error: "totalQuestions must be an integer from 1 to 50." };
  }
  if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > (totalQuestions as number)) {
    return { ok: false, error: "score must be an integer between 0 and totalQuestions." };
  }

  const categoryId = optionalString(record, "categoryId", 200);
  const playlistId = optionalString(record, "playlistId", 200);
  if (categoryId === null || playlistId === null) {
    return { ok: false, error: "categoryId and playlistId must be strings of at most 200 characters." };
  }

  const source = record.source;
  if (source !== undefined && source !== "shared" && source !== "personal" && source !== "document") {
    return { ok: false, error: "source must be shared, personal, or document." };
  }

  let answers: QuizAttemptAnswerInput[] | undefined;
  if (record.answers !== undefined) {
    if (!Array.isArray(record.answers) || record.answers.length > 50) {
      return { ok: false, error: "answers must be an array containing at most 50 items." };
    }
    answers = [];
    for (const answer of record.answers) {
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
        return { ok: false, error: "Each answer must be a valid answer record." };
      }
      const item = answer as Record<string, unknown>;
      const questionId = typeof item.questionId === "string" ? item.questionId.trim() : "";
      const chosenOptionId = typeof item.chosenOptionId === "string" ? item.chosenOptionId.trim() : null;
      if (!questionId || questionId.length > 50 || chosenOptionId === null || chosenOptionId.length > 50 || typeof item.wasCorrect !== "boolean") {
        return { ok: false, error: "Each answer requires valid questionId, chosenOptionId, and wasCorrect values." };
      }
      answers.push({ questionId, chosenOptionId, wasCorrect: item.wasCorrect });
    }
  }

  return {
    ok: true,
    value: {
      videoId,
      totalQuestions: totalQuestions as number,
      score: score as number,
      ...(categoryId ? { categoryId } : {}),
      ...(playlistId ? { playlistId } : {}),
      ...(source ? { source } : {}),
      ...(answers ? { answers } : {}),
    },
  };
}