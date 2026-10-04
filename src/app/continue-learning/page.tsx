"use client";

import * as React from "react";
import Link from "next/link";
import { PlayCircle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { ResumeGroupCard, ResumeGroupPanel, ResumeHero } from "@/components/continue/ResumeCards";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllVideos } from "@/hooks/useAllVideos";
import { listPersonalDocuments } from "@/lib/firestore/personalDocuments";
import { buildResumeGroups, summarizeResume, timestampMillis } from "@/lib/resumeGroups";
import { isResumeEligible } from "@/lib/watchProgress";
import { describeReaderProgress, isMeaningfulProgress } from "@/lib/readerProgress";
import type { PersonalDocument } from "@/types";
import { formatDistanceToNowStrict } from "date-fns";
import { BookOpenText, FileSpreadsheet, FileText, FileType2 } from "lucide-react";

export default function ContinueLearningPage() {
  return (
    <RequireAuth>
      <ContinueLearningContent />
    </RequireAuth>
  );
}

function ContinueLearningContent() {
  const { user } = useAuth();
  const { loading, videos } = useAllVideos(user?.uid);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [documents, setDocuments] = React.useState<PersonalDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    if (!user) return () => { active = false; };
    void listPersonalDocuments(user.uid).then((items) => {
      if (!active) return;
      // PDF, Word and Excel documents with a real saved position (not just "opened at the top").
      setDocuments(items.filter((item) => (item.fileType === "pdf" || item.fileType === "docx" || item.fileType === "xlsx")
          && item.readerProgress?.updatedAt && isMeaningfulProgress(item.readerProgress))
        .sort((a, b) => timestampMillis(b.readerProgress?.updatedAt) - timestampMillis(a.readerProgress?.updatedAt)));
    }).catch(() => {
      if (active) setDocuments([]);
    }).finally(() => {
      if (active) setDocumentsLoading(false);
    });
    return () => { active = false; };
  }, [user]);

  // Resume queue: videos with real progress, most recently watched first (ties: furthest along).
  const queue = React.useMemo(
    () =>
      videos
        .filter((v) => !!v.state && isResumeEligible(v.state))
        .sort(
          (a, b) =>
            timestampMillis(b.state?.lastWatchedAt) - timestampMillis(a.state?.lastWatchedAt) ||
            (b.state?.watchedPercentage || 0) - (a.state?.watchedPercentage || 0),
        ),
    [videos],
  );

  // ONE card per playlist, all in a single responsive grid. (Previously every playlist was its own
  // full-width section holding a single card, so cards stacked one per row with empty space beside them.)
  const groups = React.useMemo(() => buildResumeGroups(queue), [queue]);
  const totals = summarizeResume(groups);
  const openGroup = groups.find((g) => g.key === openKey) ?? null;
  const hero = queue[0];
  // A single in-progress video is already fully served by the hero; a grid of one card would just repeat it.
  const showGrid = groups.length > 1 || (groups[0]?.videos.length ?? 0) > 1;

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="font-display text-2xl font-semibold">Continue Watching</h1>
          <p className="text-sm text-muted-foreground">
            {loading || groups.length === 0
              ? "Resume videos you've started, grouped by playlist."
              : `${totals.videos} video${totals.videos === 1 ? "" : "s"} in progress across ${totals.playlists} playlist${totals.playlists === 1 ? "" : "s"}, most recently watched first.`}
          </p>
        </div>

        {loading && (
          <div className="space-y-8">
            <Skeleton className="h-56 w-full rounded-2xl" />
            <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-3">
                  <Skeleton className="mt-3 aspect-video w-full rounded-xl" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        )}

        {!loading && !documentsLoading && queue.length === 0 && documents.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
            <PlayCircle className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 font-display text-lg font-semibold">Nothing to resume yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Start a video, PDF, Word or Excel file and it shows up here with your exact position saved.
            </p>
            <Button asChild className="mt-4"><Link href="/playlists">Go to my playlists</Link></Button>
          </div>
        )}

        {!loading && hero && <ResumeHero video={hero} />}

        {!documentsLoading && documents.length > 0 && (
          <section aria-label="Continue reading" className="space-y-4">
            <h2 className="font-display text-lg font-semibold">Continue Reading</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {documents.map((document) => {
                const progress = document.readerProgress!;
                const savedAt = timestampMillis(progress.updatedAt);
                const fileType = document.fileType === "docx" || document.fileType === "xlsx" ? document.fileType : "pdf";
                const TypeIcon = fileType === "xlsx" ? FileSpreadsheet : fileType === "docx" ? FileType2 : FileText;
                const iconTone = fileType === "xlsx" ? "bg-emerald-500/10 text-emerald-600" : fileType === "docx" ? "bg-blue-500/10 text-blue-600" : "bg-red-500/10 text-red-600";
                return (
                  <Card key={document.id} className="min-w-0">
                    <CardContent className="flex h-full flex-col gap-3 p-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-sm ${iconTone}`}><TypeIcon className="h-5 w-5" aria-hidden /></div>
                        <div className="min-w-0 flex-1">
                          <Link href={`/study-materials/${document.id}`} className="line-clamp-2 font-medium hover:underline">{document.title}</Link>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {describeReaderProgress(progress, fileType)}{savedAt ? ` · saved ${formatDistanceToNowStrict(new Date(savedAt))} ago` : ""}
                          </p>
                        </div>
                      </div>
                      <Button asChild size="sm" className="mt-auto w-full gap-2">
                        <Link href={`/study-materials/${document.id}`}><BookOpenText className="h-4 w-4" />Continue reading</Link>
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {!loading && showGrid && (
          <section aria-label="Playlists in progress" className="space-y-4">
            {groups.length > 1 && <h2 className="font-display text-lg font-semibold">Your playlists</h2>}
            <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {groups.map((group, index) => (
                <ResumeGroupCard
                  key={group.key}
                  group={group}
                  priority={index < 4}
                  open={openKey === group.key}
                  onToggle={() => setOpenKey((current) => (current === group.key ? null : group.key))}
                />
              ))}
            </div>
            {openGroup && <ResumeGroupPanel group={openGroup} onClose={() => setOpenKey(null)} />}
          </section>
        )}
      </div>
    </AppShell>
  );
}
