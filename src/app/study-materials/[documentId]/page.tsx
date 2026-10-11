"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AiLanguagePicker } from "@/components/ai/AiLanguagePicker";
import { DocumentReaderSwitch } from "@/components/documents/DocumentReaderSwitch";
import { GoogleAppendMenu } from "@/components/documents/GoogleAppendMenu";
import { DocumentStudyDrawer, DocumentStudyMobileSheet, DocumentStudyPanel } from "@/components/documents/DocumentStudyPanel";
import { ReaderToolbar } from "@/components/documents/ReaderToolbar";
import { ViewerMenu } from "@/components/documents/ViewerMenu";
import { useGeneralPrefs } from "@/components/settings/GeneralPrefsProvider";
import {
  previewUrl, readViewerOverride, resolveViewer, typeLabelPlural, viewerOptionsFor, viewerPrefKey, writeViewerOverride, type ViewerKind,
} from "@/lib/documentViewer";
import type { GeneralPrefs } from "@/lib/generalPrefs";
import type { ViewerPrefKey } from "@/lib/documentViewer";
import { pageGridClass, readerHeightClass, resolveStudyDock, type StudyDock } from "@/lib/readerLayout";
import { useDocumentProgress } from "@/hooks/useDocumentProgress";
import { useDocumentStudy } from "@/hooks/useDocumentStudy";
import { getPersonalDocumentAnnotations, getPersonalDocumentClient } from "@/lib/firestore/personalDocuments";
import { getNote, getSummary } from "@/lib/firestore/notes";
import { getSignedDriveUrls, refreshGoogleDocumentMeta, refreshSignedDriveUrl } from "@/lib/driveClient";
import { formatGoogleModified, googleNativeLabel, googleOpenUrl } from "@/lib/googleLinks";
import type { PersonalDocument } from "@/types";
import { BookOpenText, Download, ExternalLink, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/googleSettings";

export default function StudyMaterialDetailPage() {
  return (
    <RequireAuth>
      <StudyMaterialDetailContent />
    </RequireAuth>
  );
}

function useViewportWidth(): number {
  const [width, setWidth] = React.useState(1280);
  React.useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

function StudyMaterialDetailContent() {
  const { documentId } = useParams<{ documentId: string }>();
  const { user } = useAuth();
  const [doc, setDoc] = React.useState<PersonalDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [requestedPage, setRequestedPage] = React.useState<number | null>(null);
  const [signedStreamUrl, setSignedStreamUrl] = React.useState<string | null>(null);
  const [streamError, setStreamError] = React.useState<string | null>(null);
  const { prefs, setPref } = useGeneralPrefs();
  const viewportWidth = useViewportWidth();
  const [focus, setFocus] = React.useState(false);
  const [transientDock, setTransientDock] = React.useState<StudyDock | null>(null);
  const [viewerOverride, setViewerOverride] = React.useState<ViewerKind | null>(null);
  const study = useDocumentStudy(user, documentId, doc);
  const { setSummary, setNote, setNotePageNumber } = study;
  const { annotations, setAnnotations, annotationStatus, queueReaderProgress, queueAnnotationSave } = useDocumentProgress(user, doc);

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
      } catch (error: unknown) {
        toast.error(errorMessage(error, "Failed to load this document."));
      } finally {
        setLoading(false);
      }
    })();
  }, [user, documentId, setSummary, setNote, setNotePageNumber, setAnnotations]);

  // "Just this document" choice, kept only for this browser tab.
  React.useEffect(() => {
    setViewerOverride(documentId ? readViewerOverride(typeof window === "undefined" ? null : window.sessionStorage, documentId) : null);
  }, [documentId]);

  React.useEffect(() => {
    if (!focus) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const viewer: ViewerKind = doc ? resolveViewer(doc, prefs, viewerOverride) : "reader";
  const embeddedUrl = doc && viewer !== "reader" ? previewUrl(doc, viewer) : null;

  // Google-native files: check Drive once per open and keep the stored "last changed" time current.
  const googleNativeId = doc?.googleNative ? doc.id : null;
  React.useEffect(() => {
    if (!user || !googleNativeId) return;
    let active = true;
    void (async () => {
      try {
        const result = await refreshGoogleDocumentMeta(await user.getIdToken(), googleNativeId);
        if (active && result.changed) setDoc((current) => (current && current.id === googleNativeId ? { ...current, modifiedTime: result.modifiedTime } : current));
      } catch {
        // Best effort: the reader shows its own error if the file can't be opened.
      }
    })();
    return () => { active = false; };
  }, [user, googleNativeId]);

  React.useEffect(() => {
    let active = true;
    setSignedStreamUrl(null);
    setStreamError(null);
    // A Google preview needs no signed Study Lamp link, so none is requested for it.
    if (!user || !doc || doc.fileType === "pptx" || embeddedUrl) return () => { active = false; };
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        const [url] = await getSignedDriveUrls(idToken, user.uid, [{
          fileId: doc.driveFileId,
          connectionId: doc.driveConnectionId,
          purpose: doc.googleNative ? "export" : "stream",
        }]);
        if (active) setSignedStreamUrl(url);
      } catch (error) {
        if (active) setStreamError(error instanceof Error ? error.message : "Couldn't prepare the document preview.");
      }
    })();
    return () => { active = false; };
  }, [user, doc, embeddedUrl]);

  async function refreshSignedStreamUrl(): Promise<string> {
    if (!user || !doc) throw new Error("Sign in again to reconnect to Google Drive.");
    const idToken = await user.getIdToken();
    return refreshSignedDriveUrl(idToken, user.uid, {
      fileId: doc.driveFileId,
      connectionId: doc.driveConnectionId,
      purpose: doc.googleNative ? "export" : "stream",
    });
  }

  async function handleDownload() {
    if (!user || !doc) return;
    try {
      const idToken = await user.getIdToken();
      const [url] = await getSignedDriveUrls(idToken, user.uid, [{
        fileId: doc.driveFileId,
        connectionId: doc.driveConnectionId,
        purpose: doc.googleNative ? "export_download" : "download",
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
  const nativeLabel = doc.googleNative ? googleNativeLabel(doc.mimeType) : null;
  const googleUrl = doc.googleNative ? googleOpenUrl(doc.mimeType, doc.driveFileId) : null;
  const lastChanged = doc.googleNative ? formatGoogleModified(doc.modifiedTime) : null;
  const jumpToNotePage = () => { if (study.notePageNumber) setRequestedPage(study.notePageNumber); };
  const dock: StudyDock = transientDock ?? resolveStudyDock(prefs.studyDock, viewportWidth);
  const viewerOptions = viewerOptionsFor(doc);
  const prefKey = viewerPrefKey(doc);
  const onGooglePreview = viewer !== "reader" && !!embeddedUrl;
  const studyIsPdf = doc.fileType === "pdf" && !onGooglePreview;
  const changeDock = (next: StudyDock) => { setTransientDock(null); void setPref("studyDock", next); };
  const chooseForDocument = (kind: ViewerKind) => {
    setViewerOverride(kind);
    writeViewerOverride(window.sessionStorage, doc.id, kind);
  };
  const chooseForAll = (kind: ViewerKind) => {
    setViewerOverride(null);
    writeViewerOverride(window.sessionStorage, doc.id, null);
    if (prefKey) void setPref(prefKey, kind as GeneralPrefs[ViewerPrefKey]);
  };

  return (
    <AppShell focusMode={focus}>
      <div className="mx-auto max-w-[96rem] space-y-4">
        {focus && (
          <Button type="button" variant="secondary" size="sm" className="fixed right-3 top-3 z-40 gap-1.5 shadow" onClick={() => setFocus(false)}><Minimize2 className="h-4 w-4" />Exit focus (Esc)</Button>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words font-display text-2xl font-semibold">{doc.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{nativeLabel ?? doc.fileType.toUpperCase()} · Google Drive{lastChanged ? ` · Last changed in Google ${lastChanged}` : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AiLanguagePicker value={study.language} onChange={study.setLanguage} disabled={!study.languageReady || study.generatingSummary || study.generatingQuiz || study.explainingPage} />
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="mr-1.5 h-4 w-4" />Download
            </Button>
            <GoogleAppendMenu doc={doc} />
            {googleUrl && <Button asChild variant="outline" size="sm"><a href={googleUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Google</a></Button>}
            <Button asChild variant="outline" size="sm"><a href={driveViewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-1.5 h-4 w-4" />Open in Drive</a></Button>
          </div>
        </div>

        <ReaderToolbar dock={dock} onDockChange={changeDock} focus={focus} onFocusChange={setFocus}>
          <ViewerMenu
            options={viewerOptions}
            active={viewer}
            isDefault={viewerOverride === null || !viewerOptions.includes(viewerOverride)}
            typeLabel={typeLabelPlural(doc)}
            onJustThisDocument={chooseForDocument}
            onUseForAll={chooseForAll}
          />
          {onGooglePreview && <span className="text-xs text-muted-foreground">Annotations, Explain this page, page jump and progress are off in the Google preview. Summary, quiz and notes still work.</span>}
        </ReaderToolbar>

        <div className={`grid min-w-0 gap-4 ${pageGridClass(dock)}`}>
          <section className="min-w-0 space-y-3">
            <DocumentReaderSwitch
              doc={doc}
              signedStreamUrl={signedStreamUrl}
              streamError={streamError}
              driveViewUrl={driveViewUrl}
              annotations={annotations}
              requestedPage={requestedPage}
              explainingPage={study.explainingPage}
              onDownload={handleDownload}
              onPlainText={handlePlainText}
              refreshSourceUrl={refreshSignedStreamUrl}
              onPageJumpHandled={() => setRequestedPage(null)}
              onProgress={queueReaderProgress}
              onAnnotationsChange={queueAnnotationSave}
              annotationStatus={annotationStatus}
              onExplainPage={study.handleExplainPage}
              viewer={viewer}
              previewUrl={embeddedUrl}
              openInGoogleUrl={googleUrl}
              onUseReader={() => chooseForDocument("reader")}
              pdfHeightClass={readerHeightClass(dock, focus)}
              zoomPref={prefs.readerZoom}
            />
            {dock === "bottom" && <DocumentStudyDrawer study={study} isPdf={studyIsPdf} onJumpToNotePage={jumpToNotePage} onHide={() => changeDock("hidden")} />}
          </section>

          {dock === "right" && <DocumentStudyPanel study={study} isPdf={studyIsPdf} onJumpToNotePage={jumpToNotePage} />}
        </div>

        {dock === "hidden" && (
          <Button type="button" className="fixed bottom-4 right-4 z-30 hidden h-11 gap-2 rounded-full shadow-lg lg:inline-flex" onClick={() => setTransientDock("bottom")}>
            <BookOpenText className="h-4 w-4" />Study
          </Button>
        )}

        <DocumentStudyMobileSheet study={study} isPdf={studyIsPdf} onJumpToNotePage={jumpToNotePage} />
      </div>
    </AppShell>
  );
}
