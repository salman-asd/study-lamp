import * as React from "react";
import { toast } from "sonner";
import { useAiLanguage } from "@/hooks/useAiLanguage";
import { saveNote, saveSummary } from "@/lib/firestore/notes";
import { submitQuizAttempt } from "@/lib/quizClient";
import type { PersonalDocument, QuizQuestion } from "@/types";

type StudyUser = { uid: string; getIdToken: () => Promise<string> };

/** Summary, quiz, notes and page-explanation state for one document, plus the AI language choice for those actions. */
export function useDocumentStudy(user: StudyUser | null, documentId: string | undefined, doc: PersonalDocument | null) {
  const { language, languageForRequest, setLanguage, languageReady } = useAiLanguage();
  const [summary, setSummary] = React.useState("");
  const [note, setNote] = React.useState("");
  const [notePageNumber, setNotePageNumber] = React.useState<number | null>(null);
  const [explanation, setExplanation] = React.useState("");
  const [explanationPage, setExplanationPage] = React.useState<number | null>(null);
  const [explainingPage, setExplainingPage] = React.useState(false);
  const [studyTab, setStudyTab] = React.useState("summary");
  const [generatingSummary, setGeneratingSummary] = React.useState(false);
  const [questions, setQuestions] = React.useState<QuizQuestion[] | null>(null);
  const [generatingQuiz, setGeneratingQuiz] = React.useState(false);
  const [selectedAnswers, setSelectedAnswers] = React.useState<Record<string, string>>({});
  const [quizSubmitted, setQuizSubmitted] = React.useState(false);
  const [quizResult, setQuizResult] = React.useState<{ score: number; total: number } | null>(null);

  async function handleSummaryBlur() {
    if (!user || !documentId) return;
    await saveSummary(user.uid, `d_${documentId}`, summary).catch((error) => toast.error(error?.message || "Failed to save summary."));
  }

  async function handleNoteBlur() {
    if (!user || !documentId) return;
    await saveNote(user.uid, `d_${documentId}`, note, notePageNumber).catch((error) => toast.error(error?.message || "Failed to save note."));
  }

  async function handleExplainPage(pageNumber: number, pageText: string) {
    if (!user || !documentId || !languageReady) return;
    setExplainingPage(true);
    setExplanation("");
    setExplanationPage(pageNumber);
    setStudyTab("explain");
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(`/api/documents/${documentId}/explain`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pageNumber, pageText, language: languageForRequest }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't explain this page.");
      setExplanation(data.explanation);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't explain this page.");
    } finally {
      setExplainingPage(false);
    }
  }

  async function handleGenerateSummary() {
    if (!user || !documentId || !languageReady) return;
    setGeneratingSummary(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/documents/${documentId}/summary`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ language: languageForRequest }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate a summary.");
      setSummary(data.summary);
      await saveSummary(user.uid, `d_${documentId}`, data.summary).catch(() => {});
      toast.success("Summary generated.");
    } catch (error: any) {
      toast.error(error?.message || "Failed to generate a summary.");
    } finally {
      setGeneratingSummary(false);
    }
  }

  async function handleGenerateQuiz() {
    if (!user || !documentId || !languageReady) return;
    setGeneratingQuiz(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/documents/${documentId}/quiz`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ summary: summary || null, language: languageForRequest }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate a quiz.");
      setQuestions(data.questions);
      setSelectedAnswers({});
      setQuizSubmitted(false);
      setQuizResult(null);
    } catch (error: any) {
      toast.error(error?.message || "Failed to generate a quiz.");
    } finally {
      setGeneratingQuiz(false);
    }
  }

  async function handleQuizSubmit() {
    if (!user || !documentId || !doc || !questions?.length) return;
    const total = questions.length;
    const score = questions.reduce((count, question) => (
      count + (selectedAnswers[question.id] === question.correctOptionId ? 1 : 0)
    ), 0);
    setQuizResult({ score, total });
    setQuizSubmitted(true);

    await submitQuizAttempt(user, {
      videoId: `d_${documentId}`,
      categoryId: doc.categoryId || undefined,
      source: "document",
      score,
      totalQuestions: total,
      questions: questions,
      selectedAnswers,
    });
  }

  return {
    language, setLanguage, languageReady,
    summary, setSummary, note, setNote, notePageNumber, setNotePageNumber,
    explanation, explanationPage, explainingPage,
    studyTab, setStudyTab,
    generatingSummary, generatingQuiz,
    questions, selectedAnswers, setSelectedAnswers, quizSubmitted, quizResult,
    handleSummaryBlur, handleNoteBlur, handleExplainPage, handleGenerateSummary, handleGenerateQuiz, handleQuizSubmit,
  };
}

export type DocumentStudy = ReturnType<typeof useDocumentStudy>;
