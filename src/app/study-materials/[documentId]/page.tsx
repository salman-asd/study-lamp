"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryPane } from "@/components/video/SummaryPane";
import { getPersonalDocumentClient } from "@/lib/firestore/personalDocuments";
import { getSummary, saveSummary } from "@/lib/firestore/notes";
import { driveStreamUrl } from "@/lib/driveClient";
import type { PersonalDocument, QuizQuestion } from "@/types";
import { Download, ExternalLink, Sparkles, ListChecks } from "lucide-react";
import { toast } from "sonner";

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
  const [doc, setDoc] = React.useState<PersonalDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [summary, setSummary] = React.useState("");
  const [generatingSummary, setGeneratingSummary] = React.useState(false);
  const [questions, setQuestions] = React.useState<QuizQuestion[] | null>(null);
  const [generatingQuiz, setGeneratingQuiz] = React.useState(false);
  const [revealed, setRevealed] = React.useState<Record<string, string | null>>({});

  React.useEffect(() => {
    (async () => {
      if (!user || !documentId) return;
      setLoading(true);
      try {
        const [fetchedDoc, cachedSummary] = await Promise.all([
          getPersonalDocumentClient(user.uid, documentId),
          getSummary(user.uid, `d_${documentId}`),
        ]);
        setDoc(fetchedDoc);
        setSummary(cachedSummary?.content ?? "");
      } catch (error: any) {
        toast.error(error?.message || "Failed to load this document.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user, documentId]);

  async function handleSummaryBlur() {
    if (!user || !documentId) return;
    await saveSummary(user.uid, `d_${documentId}`, summary).catch((error) => toast.error(error?.message || "Failed to save summary."));
  }

  async function handleGenerateSummary() {
    if (!user || !documentId) return;
    setGeneratingSummary(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/documents/${documentId}/summary`, { method: "POST", headers: { Authorization: `Bearer ${idToken}` } });
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
    if (!user || !documentId) return;
    setGeneratingQuiz(true);
    setRevealed({});
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/documents/${documentId}/quiz`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ summary: summary || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate a quiz.");
      setQuestions(data.questions);
    } catch (error: any) {
      toast.error(error?.message || "Failed to generate a quiz.");
    } finally {
      setGeneratingQuiz(false);
    }
  }

  if (loading) {
    return <AppShell><div className="mx-auto max-w-4xl space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-[500px] w-full" /></div></AppShell>;
  }

  if (!doc) {
    return <AppShell><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Document not found.</p></div></AppShell>;
  }

  const streamUrl = driveStreamUrl(doc.driveFileId, doc.driveConnectionId);
  const downloadUrl = driveStreamUrl(doc.driveFileId, doc.driveConnectionId, true);
  const driveViewUrl = `https://drive.google.com/file/d/${doc.driveFileId}/view`;

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold">{doc.title}</h1>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={async () => { const idToken = await user!.getIdToken(); window.location.href = `${downloadUrl}&idToken=${encodeURIComponent(idToken)}`; }}>
              <Download className="mr-1.5 h-4 w-4" />Download
            </Button>
            <Button asChild variant="outline" size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Drive</a></Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            <DocumentPreview document={doc} streamUrl={streamUrl} driveViewUrl={driveViewUrl} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold">Summary</h2>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleGenerateSummary} loading={generatingSummary} loadingText="Generating…">
                <Sparkles className="h-4 w-4" /> Generate
              </Button>
            </div>
            <SummaryPane value={summary} onChange={setSummary} onBlur={handleSummaryBlur} emptyHint="No summary yet — generate one from the file's contents." />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-semibold">Quiz</h2>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleGenerateQuiz} loading={generatingQuiz} loadingText="Generating…">
                <ListChecks className="h-4 w-4" /> Generate quiz
              </Button>
            </div>
            {!questions && <p className="text-sm text-muted-foreground">No quiz yet — generate one from the file&apos;s contents.</p>}
            {questions && (
              <div className="space-y-4">
                {questions.map((q, i) => (
                  <div key={q.id} className="rounded-md border border-border p-3">
                    <p className="mb-2 text-sm font-medium">{i + 1}. {q.prompt}</p>
                    <div className="space-y-1.5">
                      {q.options.map((opt) => {
                        const pick = revealed[q.id];
                        const isPicked = pick === opt.id;
                        const isCorrect = opt.id === q.correctOptionId;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setRevealed((prev) => ({ ...prev, [q.id]: opt.id }))}
                            className={`block w-full rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                              pick
                                ? isCorrect ? "border-success bg-success/10" : isPicked ? "border-destructive bg-destructive/10" : "border-border"
                                : "border-border hover:bg-muted/50"
                            }`}
                          >
                            {opt.text}
                          </button>
                        );
                      })}
                    </div>
                    {revealed[q.id] && <p className="mt-2 text-xs text-muted-foreground">{q.explanation}</p>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * PDF renders in a native browser PDF viewer via a plain <iframe> pointed
 * at our own ownership-checked stream proxy (Phase 16/18) — no pdf.js
 * bundle needed, every modern browser already ships one.
 *
 * Word/PowerPoint/Excel have no such native renderer, so Preview embeds
 * Drive's own `/preview` page instead (Phase 19) — this only works while
 * the viewer is signed into the same Google account the file lives in
 * (normally true, since it's usually their own upload/import), and
 * deliberately never carries our proxy URL or any token into that iframe.
 */
function DocumentPreview({ document, streamUrl, driveViewUrl }: { document: PersonalDocument; streamUrl: string; driveViewUrl: string }) {
  const { user } = useAuth();
  const [authedStreamUrl, setAuthedStreamUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    if (document.fileType !== "pdf" || !user) return;
    user.getIdToken().then((idToken) => { if (active) setAuthedStreamUrl(`${streamUrl}&idToken=${encodeURIComponent(idToken)}`); });
    return () => { active = false; };
  }, [document.fileType, streamUrl, user]);

  if (document.fileType === "pdf") {
    if (!authedStreamUrl) return <div className="flex h-[70vh] w-full items-center justify-center text-sm text-muted-foreground">Loading preview…</div>;
    return <iframe src={authedStreamUrl} title={document.title} className="h-[70vh] w-full rounded-b-lg border-0" />;
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
