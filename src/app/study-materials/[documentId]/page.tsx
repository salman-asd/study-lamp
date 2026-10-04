"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SummaryPane } from "@/components/video/SummaryPane";
import { AiLanguagePicker } from "@/components/ai/AiLanguagePicker";
import { useAiLanguage } from "@/hooks/useAiLanguage";
import { mergeReaderProgress, type ReaderProgressInput } from "@/lib/readerProgress";
import {
  getPersonalDocumentAnnotations,
  getPersonalDocumentClient,
  savePersonalDocumentAnnotations,
  updatePersonalDocumentReadingProgress,
} from "@/lib/firestore/personalDocuments";
import { getNote, getSummary, saveNote, saveSummary } from "@/lib/firestore/notes";
import { getSignedDriveUrls, refreshSignedDriveUrl } from "@/lib/driveClient";
import type { PersonalDocument, QuizQuestion } from "@/types";
import { BookOpenText, Download, ExternalLink, ListChecks, NotebookPen, Sparkles } from "lucide-react";
import { toast } from "sonner";

const PdfReader = dynamic(
  () => import("@/components/documents/PdfReader").then((module) => module.PdfReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);
const DocxReader = dynamic(
  () => import("@/components/documents/DocxReader").then((module) => module.DocxReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);
const XlsxReader = dynamic(
  () => import("@/components/documents/XlsxReader").then((module) => module.XlsxReader),
  {
    ssr: false,
    loading: () => <div className="space-y-3 rounded-md border border-border p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-[60vh] w-full" /></div>,
  },
);

export default function StudyMaterialDetailPage() {
  return (
    <RequireAuth>
      <StudyMaterialDetailContent />
    </RequireAuth>
  );
}

function StudyMaterialDetailContent() {
  const { documentId } = useParams<{ documentId: string }>();
  const { user } = useAuth();
  const { language, setLanguage, languageReady } = useAiLanguage();
  const [doc, setDoc] = React.useState<PersonalDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [summary, setSummary] = React.useState("");
  const [note, setNote] = React.useState("");
  const [notePageNumber, setNotePageNumber] = React.useState<number | null>(null);
  const [annotations, setAnnotations] = React.useState<unknown[]>([]);
  const [requestedPage, setRequestedPage] = React.useState<number | null>(null);
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
  const [signedStreamUrl, setSignedStreamUrl] = React.useState<string | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const [mobileStudyOpen, setMobileStudyOpen] = React.useState(false);
  const progressSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationSaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgress = React.useRef<ReaderProgressInput | null>(null);
  const pendingAnnotations = React.useRef<unknown[] | null>(null);

  React.useEffect(() => {
    (async () => {
      if (!user || !documentId) return;
      setLoading(true);
      try {
        const [fetchedDoc, cachedSummary, cachedNote, cachedAnnotations] = await Promise.all([
          getPersonalDocumentClient(user.uid, documentId),
          getSummary(user.uid, `d_${documentId}`),
          getNote(user.uid, `d_${documentId}`),
          getPersonalDocumentAnnotations(user.uid, documentId),
        ]);
        setDoc(fetchedDoc);
        setSummary(cachedSummary?.content ?? "");
        setNote(cachedNote?.content ?? "");
        setNotePageNumber(cachedNote?.pageNumber ?? null);
        setAnnotations(cachedAnnotations);
      } catch (error: any) {
        toast.error(error?.message || "Failed to load this document.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user, documentId]);

  React.useEffect(() => {
    let active = true;
    setSignedStreamUrl(null);
    setStreamError(null);
    if (!user || !doc || doc.fileType === "pptx") return () => { active = false; };
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const [url] = await getSignedDriveUrls(idToken, user.uid, [{
          fileId: doc.driveFileId,
          connectionId: doc.driveConnectionId,
          purpose: "stream",
        }]);
        if (active) setSignedStreamUrl(url);
      } catch (error) {
        if (active) setStreamError(error instanceof Error ? error.message : "Couldn't prepare the document preview.");
      }
    })();
    return () => { active = false; };
  }, [user, doc]);

  // Sends the pending reading position right now (debounce timer, tab hidden, page closing, unmount).
  const flushReaderProgress = React.useCallback(() => {
    if (progressSaveTimer.current) {
      clearTimeout(progressSaveTimer.current);
      progressSaveTimer.current = null;
    }
    const pending = pendingProgress.current;
    pendingProgress.current = null;
    if (!pending || !user || !doc) return;
    void updatePersonalDocumentReadingProgress(user.uid, doc.id, pending, doc.fileType).catch((error) => {
      toast.error(error?.message || "Couldn't save reading progress.");
    });
  }, [user, doc]);

  React.useEffect(() => () => {
    flushReaderProgress();
    if (annotationSaveTimer.current) {
      clearTimeout(annotationSaveTimer.current);
      if (user && doc && pendingAnnotations.current) {
        void savePersonalDocumentAnnotations(user.uid, doc.id, pendingAnnotations.current).catch(() => {});
      }
    }
  }, [user, doc, flushReaderProgress]);

  // The 2 s debounce would lose the last position when the tab is closed or backgrounded, so flush on those events.
  React.useEffect(() => {
    const onPageHide = () => flushReaderProgress();
    const onVisibility = () => { if (window.document.visibilityState === "hidden") flushReaderProgress(); };
    window.addEventListener("pagehide", onPageHide);
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushReaderProgress]);

  /** Shared by the PDF, Word and Excel readers; each reports only the fields that belong to its type. */
  function queueReaderProgress(progress: ReaderProgressInput) {
    if (!user || !doc) return;
    pendingProgress.current = mergeReaderProgress(pendingProgress.current, progress);
    if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current);
    progressSaveTimer.current = setTimeout(flushReaderProgress, 2_000);
  }

  function queueAnnotationSave(nextAnnotations: unknown[]) {
    if (!user || !doc) return;
    pendingAnnotations.current = nextAnnotations;
    setAnnotations(nextAnnotations);
    if (annotationSaveTimer.current) clearTimeout(annotationSaveTimer.current);
    annotationSaveTimer.current = setTimeout(() => {
      annotationSaveTimer.current = null;
      const pending = pendingAnnotations.current;
      pendingAnnotations.current = null;
      if (pending) void savePersonalDocumentAnnotations(user.uid, doc.id, pending).catch((error) => {
        toast.error(error?.message || "Couldn't save PDF annotations.");
      });
    }, 2_000);
  }

  async function refreshSignedStreamUrl(): Promise<string> {
    if (!user || !doc) throw new Error("Sign in again to reconnect to Google Drive.");
    const idToken = await user.getIdToken();
    return refreshSignedDriveUrl(idToken, user.uid, {
      fileId: doc.driveFileId,
      connectionId: doc.driveConnectionId,
      purpose: "stream",
    });
  }

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
        body: JSON.stringify({ pageNumber, pageText, language }),
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
        body: JSON.stringify({ language }),
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
        body: JSON.stringify({ summary: summary || null, language }),
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

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/quiz-attempts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          videoId: `d_${documentId}`,
          categoryId: doc.categoryId || undefined,
          source: "document",
          score,
          totalQuestions: total,
          answers: questions.map((question) => ({
            questionId: question.id,
            chosenOptionId: selectedAnswers[question.id] || "",
            wasCorrect: selectedAnswers[question.id] === question.correctOptionId,
          })),
        }),
      });
      if (!response.ok) toast.error("Couldn't save your quiz result");
    } catch {
      toast.error("Couldn't save your quiz result");
    }
  }

  async function handleDownload() {
    if (!user || !doc) return;
    try {
      const idToken = await user.getIdToken();
      const [url] = await getSignedDriveUrls(idToken, user.uid, [{
        fileId: doc.driveFileId,
        connectionId: doc.driveConnectionId,
        purpose: "download",
      }]);
      window.location.href = url;
    } catch {
      toast.error("Couldn't prepare the download.");
    }
  }

  async function handlePlainText(): Promise<string> {
    if (!user || !documentId) throw new Error("Sign in again to load document text.");
    const idToken = await user.getIdToken();
    const response = await fetch(`/api/documents/${documentId}/text`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.text !== "string") throw new Error(data.error || "Couldn't load the plain text view.");
    return data.text;
  }

  if (loading) {
    return <AppShell><div className="mx-auto max-w-4xl space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-[500px] w-full" /></div></AppShell>;
  }

  if (!doc) {
    return <AppShell><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Document not found.</p></div></AppShell>;
  }

  const driveViewUrl = `https://drive.google.com/file/d/${doc.driveFileId}/view`;

  return (
    <AppShell>
      <div className="mx-auto max-w-[96rem] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words font-display text-2xl font-semibold">{doc.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{doc.fileType.toUpperCase()} · Google Drive</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AiLanguagePicker value={language} onChange={setLanguage} disabled={!languageReady || generatingSummary || generatingQuiz || explainingPage} />
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="mr-1.5 h-4 w-4" />Download
            </Button>
            <Button asChild variant="outline" size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Drive</a></Button>
          </div>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.9fr)]">
          <section className="min-w-0">
            {doc.fileType === "pdf" ? (
              <PdfReader
                documentTitle={doc.title}
                sourceUrl={signedStreamUrl}
                initialError={streamError}
                driveViewUrl={driveViewUrl}
                onDownload={handleDownload}
                refreshSourceUrl={refreshSignedStreamUrl}
                initialPage={doc.readerProgress?.lastPage ?? 1}
                initialZoom={doc.readerProgress?.zoom ?? 1}
                requestedPage={requestedPage}
                onPageJumpHandled={() => setRequestedPage(null)}
                onProgress={queueReaderProgress}
                savedAnnotations={annotations}
                onAnnotationsChange={queueAnnotationSave}
                onExplainPage={handleExplainPage}
                explainingPage={explainingPage}
              />
            ) : (
              <DocumentPreview
                document={doc}
                sourceUrl={signedStreamUrl}
                sourceError={streamError}
                driveViewUrl={driveViewUrl}
                onDownload={handleDownload}
                onPlainText={handlePlainText}
                progress={doc.readerProgress ?? null}
                onProgress={queueReaderProgress}
              />
            )}
          </section>

          <aside className="hidden min-w-0 lg:block">
            <DocumentStudyTools
              summary={summary}
              note={note}
              questions={questions}
              selectedAnswers={selectedAnswers}
              quizSubmitted={quizSubmitted}
              quizResult={quizResult}
              generatingSummary={generatingSummary}
              generatingQuiz={generatingQuiz}
              activeTab={studyTab}
              explanation={explanation}
              explanationPage={explanationPage}
              explainingPage={explainingPage}
              showExplain={doc.fileType === "pdf"}
              showPageNotes={doc.fileType === "pdf"}
              notePageNumber={notePageNumber}
              onSummaryChange={setSummary}
              onSummaryBlur={handleSummaryBlur}
              onNoteChange={setNote}
              onNoteBlur={handleNoteBlur}
              onNotePageNumberChange={setNotePageNumber}
              onJumpToNotePage={() => { if (notePageNumber) setRequestedPage(notePageNumber); }}
              onTabChange={setStudyTab}
              onGenerateSummary={handleGenerateSummary}
              onGenerateQuiz={handleGenerateQuiz}
              onAnswer={(questionId, answerId) => setSelectedAnswers((previous) => ({ ...previous, [questionId]: answerId }))}
              onSubmitQuiz={handleQuizSubmit}
            />
          </aside>
        </div>

        <div className="lg:hidden">
          <Button type="button" variant="outline" className="w-full gap-2" onClick={() => setMobileStudyOpen(true)}>
            <BookOpenText className="h-4 w-4" /> Summary, quiz, and notes
          </Button>
          <Dialog open={mobileStudyOpen} onOpenChange={setMobileStudyOpen}>
            <DialogContent className="bottom-0 left-0 top-auto max-h-[86dvh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-lg p-4 sm:hidden">
              <DialogHeader><DialogTitle>Study panel</DialogTitle></DialogHeader>
              <DocumentStudyTools
                summary={summary}
                note={note}
                questions={questions}
                selectedAnswers={selectedAnswers}
                quizSubmitted={quizSubmitted}
                quizResult={quizResult}
                generatingSummary={generatingSummary}
                generatingQuiz={generatingQuiz}
                activeTab={studyTab}
                explanation={explanation}
                explanationPage={explanationPage}
                explainingPage={explainingPage}
                showExplain={doc.fileType === "pdf"}
                showPageNotes={doc.fileType === "pdf"}
                notePageNumber={notePageNumber}
                onSummaryChange={setSummary}
                onSummaryBlur={handleSummaryBlur}
                onNoteChange={setNote}
                onNoteBlur={handleNoteBlur}
                onNotePageNumberChange={setNotePageNumber}
                onJumpToNotePage={() => { if (notePageNumber) setRequestedPage(notePageNumber); }}
                onTabChange={setStudyTab}
                onGenerateSummary={handleGenerateSummary}
                onGenerateQuiz={handleGenerateQuiz}
                onAnswer={(questionId, answerId) => setSelectedAnswers((previous) => ({ ...previous, [questionId]: answerId }))}
                onSubmitQuiz={handleQuizSubmit}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </AppShell>
  );
}

function DocumentStudyTools({
  summary,
  note,
  questions,
  selectedAnswers,
  quizSubmitted,
  quizResult,
  generatingSummary,
  generatingQuiz,
  activeTab,
  explanation,
  explanationPage,
  explainingPage,
  showExplain,
  showPageNotes,
  notePageNumber,
  onSummaryChange,
  onSummaryBlur,
  onNoteChange,
  onNoteBlur,
  onNotePageNumberChange,
  onJumpToNotePage,
  onTabChange,
  onGenerateSummary,
  onGenerateQuiz,
  onAnswer,
  onSubmitQuiz,
}: {
  summary: string;
  note: string;
  questions: QuizQuestion[] | null;
  selectedAnswers: Record<string, string>;
  quizSubmitted: boolean;
  quizResult: { score: number; total: number } | null;
  generatingSummary: boolean;
  generatingQuiz: boolean;
  activeTab: string;
  explanation: string;
  explanationPage: number | null;
  explainingPage: boolean;
  showExplain: boolean;
  showPageNotes: boolean;
  notePageNumber: number | null;
  onSummaryChange: (value: string) => void;
  onSummaryBlur: () => void;
  onNoteChange: (value: string) => void;
  onNoteBlur: () => void;
  onNotePageNumberChange: (value: number | null) => void;
  onJumpToNotePage: () => void;
  onTabChange: (value: string) => void;
  onGenerateSummary: () => void;
  onGenerateQuiz: () => void;
  onAnswer: (questionId: string, answerId: string) => void;
  onSubmitQuiz: () => void;
}) {
  return (
    <Card className="min-w-0">
      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="sticky top-0 z-10 flex w-full justify-start rounded-none rounded-t-md border-b border-border bg-card">
          <TabsTrigger value="summary" className="gap-1.5"><BookOpenText className="h-4 w-4" />Summary</TabsTrigger>
          <TabsTrigger value="quiz" className="gap-1.5"><ListChecks className="h-4 w-4" />Quiz</TabsTrigger>
          <TabsTrigger value="notes" className="gap-1.5"><NotebookPen className="h-4 w-4" />Notes</TabsTrigger>
          {showExplain && <TabsTrigger value="explain" className="gap-1.5"><Sparkles className="h-4 w-4" />Explain</TabsTrigger>}
        </TabsList>
        <CardContent className="max-h-[calc(100vh-14rem)] space-y-4 overflow-y-auto p-4">
          <TabsContent value="summary" className="mt-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">Summary</h2>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={onGenerateSummary} loading={generatingSummary} loadingText="Generating…">
                <Sparkles className="h-4 w-4" /> Generate
              </Button>
            </div>
            <SummaryPane value={summary} onChange={onSummaryChange} onBlur={onSummaryBlur} emptyHint="No summary yet — generate one from the file's contents." />
          </TabsContent>

          <TabsContent value="quiz" className="mt-0 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">Quiz</h2>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={onGenerateQuiz} loading={generatingQuiz} loadingText="Generating…">
                <ListChecks className="h-4 w-4" /> Generate
              </Button>
            </div>
            {!questions && <p className="text-sm text-muted-foreground">No quiz yet — generate one from the file&apos;s contents.</p>}
            {questions?.map((question, index) => (
              <div key={question.id} className="rounded-md border border-border p-3">
                <p className="mb-2 text-sm font-medium">{index + 1}. {question.prompt}</p>
                <div className="space-y-1.5">
                  {question.options.map((option) => {
                    const isPicked = selectedAnswers[question.id] === option.id;
                    const isCorrect = option.id === question.correctOptionId;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onAnswer(question.id, option.id)}
                        disabled={quizSubmitted}
                        aria-pressed={isPicked}
                        className={`block w-full rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                          quizSubmitted
                            ? isCorrect ? "border-success bg-success/10" : isPicked ? "border-destructive bg-destructive/10" : "border-border"
                            : isPicked ? "border-primary bg-accent/10" : "border-border hover:bg-muted/50"
                        }`}
                      >{option.text}</button>
                    );
                  })}
                </div>
                {quizSubmitted && <p className="mt-2 text-xs text-muted-foreground">{question.explanation}</p>}
              </div>
            ))}
            {questions && !quizSubmitted && <Button onClick={onSubmitQuiz} className="w-full">Submit quiz</Button>}
            {quizSubmitted && quizResult && <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">Result: {quizResult.score} / {quizResult.total} correct</div>}
          </TabsContent>

          <TabsContent value="notes" className="mt-0 space-y-3">
            <h2 className="font-display text-base font-semibold">Notes</h2>
            {showPageNotes && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-32 flex-1 space-y-1">
                  <Label htmlFor="document-note-page">Page (optional)</Label>
                  <Input
                    id="document-note-page"
                    type="number"
                    min={1}
                    max={100000}
                    value={notePageNumber ?? ""}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      onNotePageNumberChange(Number.isInteger(value) && value > 0 ? value : null);
                    }}
                    onBlur={onNoteBlur}
                    placeholder="Page number"
                  />
                </div>
                {notePageNumber && <Button type="button" variant="outline" size="sm" onClick={onJumpToNotePage}>Go to page</Button>}
              </div>
            )}
            <textarea
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              onBlur={onNoteBlur}
              placeholder="Write a note about this document…"
              className="min-h-60 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </TabsContent>
          {showExplain && (
            <TabsContent value="explain" className="mt-0 space-y-3">
              <h2 className="font-display text-base font-semibold">Page explanation{explanationPage ? ` · Page ${explanationPage}` : ""}</h2>
              {explainingPage ? <p className="text-sm text-muted-foreground">Preparing an explanation…</p> : explanation ? (
                <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-sm leading-6">{explanation}</div>
              ) : <p className="text-sm text-muted-foreground">Choose “Explain this page” in the reader to get a page-specific explanation.</p>}
            </TabsContent>
          )}
        </CardContent>
      </Tabs>
    </Card>
  );
}

/**
 * PowerPoint intentionally remains on Drive's preview surface. Word and
 * Excel use their isolated, dynamically imported in-app readers.
 */
function DocumentPreview({
  document,
  sourceUrl,
  sourceError,
  driveViewUrl,
  onDownload,
  onPlainText,
  progress,
  onProgress,
}: {
  document: PersonalDocument;
  sourceUrl: string | null;
  sourceError: string | null;
  driveViewUrl: string;
  onDownload: () => void;
  onPlainText: () => Promise<string>;
  /** Saved reading position, used only for the initial restore. */
  progress: PersonalDocument["readerProgress"];
  onProgress: (progress: ReaderProgressInput) => void;
}) {
  if (document.fileType === "docx") {
    if (!sourceUrl) return <PreviewUnavailable message={sourceError} onDownload={onDownload} />;
    return <DocxReader title={document.title} sourceUrl={sourceUrl} onDownload={onDownload} onPlainText={onPlainText} initialScrollRatio={progress?.scrollRatio} initialZoom={progress?.zoom} onProgress={onProgress} />;
  }
  if (document.fileType === "xlsx") {
    if (!sourceUrl) return <PreviewUnavailable message={sourceError} onDownload={onDownload} />;
    return <XlsxReader title={document.title} sourceUrl={sourceUrl} onDownload={onDownload} initialSheetIndex={progress?.sheetIndex} initialRowIndex={progress?.rowIndex} onProgress={onProgress} />;
  }
  return (
    <iframe
      src={`https://drive.google.com/file/d/${document.driveFileId}/preview`}
      title={document.title}
      className="h-[70vh] w-full rounded-b-lg border-0"
      allow="autoplay"
    />
  );
}

function PreviewUnavailable({ message, onDownload }: { message: string | null; onDownload: () => void }) {
  return (
    <div className="flex h-[68vh] min-h-[28rem] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message || "Preparing a secure document preview…"}</p>
      {message && <Button type="button" size="sm" onClick={onDownload}><Download className="mr-1.5 h-4 w-4" />Download</Button>}
    </div>
  );
}
