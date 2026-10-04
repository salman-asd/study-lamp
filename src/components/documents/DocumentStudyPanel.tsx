"use client";

import * as React from "react";
import { BookOpenText, ListChecks, NotebookPen, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SummaryPane } from "@/components/video/SummaryPane";
import type { QuizQuestion } from "@/types";
import type { DocumentStudy } from "@/hooks/useDocumentStudy";

interface DocumentStudyPanelProps {
  study: DocumentStudy;
  /** PDF documents get the page-explanation tab and page-numbered notes. */
  isPdf: boolean;
  onJumpToNotePage: () => void;
}

function toolsProps({ study, isPdf, onJumpToNotePage }: DocumentStudyPanelProps) {
  return {
    summary: study.summary,
    note: study.note,
    questions: study.questions,
    selectedAnswers: study.selectedAnswers,
    quizSubmitted: study.quizSubmitted,
    quizResult: study.quizResult,
    generatingSummary: study.generatingSummary,
    generatingQuiz: study.generatingQuiz,
    activeTab: study.studyTab,
    explanation: study.explanation,
    explanationPage: study.explanationPage,
    explainingPage: study.explainingPage,
    showExplain: isPdf,
    showPageNotes: isPdf,
    notePageNumber: study.notePageNumber,
    onSummaryChange: study.setSummary,
    onSummaryBlur: study.handleSummaryBlur,
    onNoteChange: study.setNote,
    onNoteBlur: study.handleNoteBlur,
    onNotePageNumberChange: study.setNotePageNumber,
    onJumpToNotePage,
    onTabChange: study.setStudyTab,
    onGenerateSummary: study.handleGenerateSummary,
    onGenerateQuiz: study.handleGenerateQuiz,
    onAnswer: (questionId: string, answerId: string) => study.setSelectedAnswers((previous) => ({ ...previous, [questionId]: answerId })),
    onSubmitQuiz: study.handleQuizSubmit,
  };
}

/** Desktop sidebar: summary, quiz, notes and (PDF only) page explanation tabs. */
export function DocumentStudyPanel(props: DocumentStudyPanelProps) {
  return (
    <aside className="hidden min-w-0 lg:block">
      <DocumentStudyTools {...toolsProps(props)} />
    </aside>
  );
}

/** Mobile entry point: a button that opens the same tools in a bottom sheet. */
export function DocumentStudyMobileSheet(props: DocumentStudyPanelProps) {
  const [mobileStudyOpen, setMobileStudyOpen] = React.useState(false);
  return (
    <div className="lg:hidden">
      <Button type="button" variant="outline" className="w-full gap-2" onClick={() => setMobileStudyOpen(true)}>
        <BookOpenText className="h-4 w-4" /> Summary, quiz, and notes
      </Button>
      <Dialog open={mobileStudyOpen} onOpenChange={setMobileStudyOpen}>
        <DialogContent className="bottom-0 left-0 top-auto max-h-[86dvh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-lg p-4 sm:hidden">
          <DialogHeader><DialogTitle>Study panel</DialogTitle></DialogHeader>
          <DocumentStudyTools {...toolsProps(props)} />
        </DialogContent>
      </Dialog>
    </div>
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
