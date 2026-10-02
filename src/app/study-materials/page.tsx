"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DriveImportPanel } from "@/components/drive/DriveImportPanel";
import { SearchableTagMultiSelect, TagCategoryPicker } from "@/components/shared/TagCategoryPicker";
import {
  deletePersonalDocument,
  listPersonalDocuments,
  updatePersonalDocumentClassification,
} from "@/lib/firestore/personalDocuments";
import { listCategories, listTags } from "@/lib/firestore/categoriesTags";
import { listDriveConnections } from "@/lib/driveClient";
import { driveThumbnailMarker } from "@/lib/driveThumbnailMarker";
import { useSignedDriveThumbnail } from "@/hooks/useSignedDriveThumbnail";
import { countStudyMaterials, filterAndSortStudyMaterials } from "@/lib/documentFilters";
import type { StudyMaterialSort, StudyMaterialTypeFilter } from "@/lib/documentFilters";
import type { DrivePickerKind } from "@/lib/driveMime";
import type { Category, DriveConnectionSummary, PersonalDocument, Tag } from "@/types";
import { FileText, FileSpreadsheet, LayoutGrid, List, Plus, Presentation, SlidersHorizontal, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";

const VIEW_STORAGE_KEY = "study-materials-view";
const TYPE_TABS: Array<{ value: StudyMaterialTypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word" },
  { value: "xlsx", label: "Excel" },
];
const TYPE_LABEL: Record<PersonalDocument["fileType"], string> = {
  pdf: "PDF",
  docx: "Word",
  pptx: "PowerPoint",
  xlsx: "Excel",
};
const TYPE_ICON: Record<PersonalDocument["fileType"], React.ReactNode> = {
  pdf: <FileText className="h-5 w-5 text-red-500" />,
  docx: <FileText className="h-5 w-5 text-blue-500" />,
  pptx: <Presentation className="h-5 w-5 text-orange-500" />,
  xlsx: <FileSpreadsheet className="h-5 w-5 text-emerald-600" />,
};
const IMPORT_OPTIONS: Record<StudyMaterialTypeFilter, { kinds: DrivePickerKind[]; accept: string }> = {
  all: { kinds: ["pdf", "docx", "pptx", "xlsx"], accept: ".pdf,.docx,.pptx,.xlsx" },
  pdf: { kinds: ["pdf"], accept: ".pdf" },
  docx: { kinds: ["docx"], accept: ".docx" },
  pptx: { kinds: ["pptx"], accept: ".pptx" },
  xlsx: { kinds: ["xlsx"], accept: ".xlsx" },
};

export default function StudyMaterialsPage() {
  return (
    <RequireAuth>
      <Suspense fallback={<div className="p-6"><Skeleton className="h-10 w-full" /></div>}>
        <StudyMaterialsContent />
      </Suspense>
    </RequireAuth>
  );
}

function StudyMaterialsContent() {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedType = searchParams.get("type") as StudyMaterialTypeFilter | null;
  const activeType: StudyMaterialTypeFilter = TYPE_TABS.some((tab) => tab.value === requestedType)
    ? requestedType as StudyMaterialTypeFilter
    : "all";
  const [documents, setDocuments] = React.useState<PersonalDocument[]>([]);
  const [categories, setCategories] = React.useState<Category[]>([]);
  const [tags, setTags] = React.useState<Tag[]>([]);
  const [connections, setConnections] = React.useState<DriveConnectionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [importOpen, setImportOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<StudyMaterialSort>("recent");
  const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
  const [classificationTarget, setClassificationTarget] = React.useState<PersonalDocument | null>(null);
  const [editCategoryId, setEditCategoryId] = React.useState<string | null>(null);
  const [editTagIds, setEditTagIds] = React.useState<string[]>([]);
  const [savingClassification, setSavingClassification] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setDocuments(await listPersonalDocuments(user.uid));
    } catch (error: any) {
      toast.error(error?.message || "Failed to load your study materials.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!user) return;
    void Promise.all([
      listCategories(user.uid).catch(() => []),
      listTags().catch(() => []),
      user.getIdToken().then((idToken) => listDriveConnections(idToken)).catch(() => []),
    ]).then(([nextCategories, nextTags, nextConnections]) => {
      setCategories(nextCategories);
      setTags(nextTags);
      setConnections(nextConnections.filter((connection) => connection.status !== "invalid"));
    });
  }, [user]);

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === "grid" || stored === "list") setViewMode(stored);
    } catch {}
  }, []);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
    } catch {}
  }, [viewMode]);

  function changeType(nextType: string) {
    if (!TYPE_TABS.some((tab) => tab.value === nextType)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("type", nextType);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  async function handleDelete(documentId: string, title: string) {
    if (!user) return;
    if (!confirm(`Remove "${title}" from Study Lamp? The file stays in your Google Drive.`)) return;
    try {
      await deletePersonalDocument(await user.getIdToken(), documentId);
      setDocuments((previous) => previous.filter((document) => document.id !== documentId));
    } catch (error: any) {
      toast.error(error?.message || "Failed to remove this document.");
    }
  }

  function openClassificationEditor(document: PersonalDocument) {
    setClassificationTarget(document);
    setEditCategoryId(document.categoryId ?? null);
    setEditTagIds(document.tagIds ?? []);
  }

  async function saveClassification() {
    if (!user || !classificationTarget) return;
    setSavingClassification(true);
    try {
      const classification = { categoryId: editCategoryId, tagIds: editTagIds };
      await updatePersonalDocumentClassification(user.uid, classificationTarget.id, classification);
      setDocuments((previous) => previous.map((document) => document.id === classificationTarget.id
        ? { ...document, ...classification }
        : document));
      setClassificationTarget(null);
    } catch (error: any) {
      toast.error(error?.message || "Couldn't save document categories and tags.");
    } finally {
      setSavingClassification(false);
    }
  }

  const counts = countStudyMaterials(documents);
  const visibleDocuments = filterAndSortStudyMaterials(documents, {
    type: activeType,
    query,
    categoryId: categoryId || null,
    tagIds,
    sort,
  });
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));
  const connectionEmails = new Map(connections.map((connection) => [connection.id, connection.googleEmail]));
  const importOptions = IMPORT_OPTIONS[activeType];

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold">Study Materials</h1>
            <p className="text-sm text-muted-foreground">Your PDFs, Word documents, presentations, and spreadsheets.</p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setImportOpen(true)}>
            <Plus className="h-4 w-4" /> Add material
          </Button>
        </header>

        <Tabs value={activeType} onValueChange={changeType}>
          <TabsList aria-label="Study material type" className="w-full max-w-full justify-start overflow-x-auto">
            {TYPE_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-2">
                {tab.label}<span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs tabular-nums">{counts[tab.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={activeType} className="space-y-4">
            <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_12rem_minmax(13rem,auto)_11rem_auto]">
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles" aria-label="Search study materials" />
                <Select value={categoryId || "all"} onValueChange={(value) => setCategoryId(value === "all" ? "" : value)}>
                  <SelectTrigger aria-label="Filter by category"><SelectValue placeholder="All categories" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <SearchableTagMultiSelect tags={tags} selectedTagIds={tagIds} onChange={setTagIds} />
                <Select value={sort} onValueChange={(value) => setSort(value as StudyMaterialSort)}>
                  <SelectTrigger aria-label="Sort study materials"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Recently added</SelectItem>
                    <SelectItem value="title">Title</SelectItem>
                    <SelectItem value="size">File size</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-end gap-1">
                  <Button type="button" variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" title="Grid view" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}>
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {(categoryId || tagIds.length > 0 || query) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span>{visibleDocuments.length} matching {visibleDocuments.length === 1 ? "item" : "items"}</span>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setQuery(""); setCategoryId(""); setTagIds([]); }}>Clear filters</Button>
                </div>
              )}
            </div>

            {loading ? (
              <div className={viewMode === "grid" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2"}>
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-36 w-full" />
              </div>
            ) : visibleDocuments.length === 0 ? (
              <EmptyState
                type={activeType}
                hasDocuments={documents.length > 0}
                onAdd={() => setImportOpen(true)}
                onClear={() => { setQuery(""); setCategoryId(""); setTagIds([]); }}
              />
            ) : (
              <div className={viewMode === "grid" ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2"}>
                {visibleDocuments.map((document) => (
                  <Card key={document.id} className="group min-w-0 overflow-hidden">
                    <CardContent className={viewMode === "grid" ? "p-0" : "flex min-w-0 items-center gap-4 p-3"}>
                      <DocumentThumbnail document={document} viewMode={viewMode} />
                      <div className={viewMode === "grid" ? "min-w-0 space-y-2 p-4" : "min-w-0 flex-1 space-y-1.5"}>
                        <div className="flex min-w-0 items-start gap-2">
                          <Link href={`/study-materials/${document.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                            <span className="line-clamp-2 break-words">{document.title}</span>
                          </Link>
                          <Badge variant="outline" className="shrink-0 gap-1.5">
                            {TYPE_ICON[document.fileType]}{TYPE_LABEL[document.fileType]}
                          </Badge>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{formatFileSize(document.sizeBytes)}</span>
                          <span>{formatDocumentDate(document)}</span>
                          <span className="max-w-48 truncate">{connectionEmails.get(document.driveConnectionId) || "Google Drive"}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {document.categoryId && categoryNames.has(document.categoryId) && <Badge variant="secondary">{categoryNames.get(document.categoryId)}</Badge>}
                          {(document.tagIds ?? []).map((id) => tagNames.get(id)).filter((name): name is string => Boolean(name)).map((name) => <Badge key={`${document.id}-${name}`} variant="outline">{name}</Badge>)}
                        </div>
                        <div className="flex justify-end gap-1">
                          <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => openClassificationEditor(document)}>
                            <Tags className="h-3.5 w-3.5" /> Organize
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => void handleDelete(document.id, document.title)} aria-label={`Remove ${document.title}`} title="Remove from Study Materials">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add a study material</DialogTitle></DialogHeader>
          <DriveImportPanel
            kinds={importOptions.kinds}
            accept={importOptions.accept}
            allowFolders={false}
            onImported={() => { setImportOpen(false); void load(); }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(classificationTarget)} onOpenChange={(open) => { if (!open) setClassificationTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Organize document</DialogTitle></DialogHeader>
          {user && classificationTarget && (
            <div className="space-y-4">
              <p className="truncate text-sm text-muted-foreground">{classificationTarget.title}</p>
              <TagCategoryPicker
                userId={user.uid}
                categoryId={editCategoryId}
                tagIds={editTagIds}
                onCategoryChange={setEditCategoryId}
                onTagsChange={setEditTagIds}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setClassificationTarget(null)}>Cancel</Button>
                <Button type="button" onClick={() => void saveClassification()} disabled={savingClassification}>{savingClassification ? "Saving..." : "Save"}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function DocumentThumbnail({ document, viewMode }: { document: PersonalDocument; viewMode: "grid" | "list" }) {
  const className = viewMode === "grid"
    ? "relative aspect-[16/9] w-full overflow-hidden bg-muted"
    : "relative h-16 w-24 shrink-0 overflow-hidden rounded-sm bg-muted";
  // Thumbnail bytes live server-side; the card resolves a marker to a short-lived
  // signed URL, exactly like video thumbnails. Documents imported before the
  // marker existed derive it from their Drive ids (the route self-heals).
  const marker = document.thumbnailUrl
    || (document.driveFileId && document.driveConnectionId ? driveThumbnailMarker(document.driveFileId, document.driveConnectionId) : null);
  const signedSrc = useSignedDriveThumbnail(marker);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [marker]);
  return (
    <div className={className}>
      {signedSrc && !failed ? (
        <Image src={signedSrc} alt="" fill unoptimized onError={() => setFailed(true)} sizes={viewMode === "grid" ? "(max-width: 640px) 100vw, 33vw" : "96px"} className="object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center">{TYPE_ICON[document.fileType]}</div>
      )}
    </div>
  );
}

function EmptyState({
  type,
  hasDocuments,
  onAdd,
  onClear,
}: {
  type: StudyMaterialTypeFilter;
  hasDocuments: boolean;
  onAdd: () => void;
  onClear: () => void;
}) {
  if (hasDocuments) {
    return (
      <div className="space-y-2 py-12 text-center">
        <p className="font-medium">No matching study materials</p>
        <Button type="button" variant="outline" size="sm" onClick={onClear}>Clear filters</Button>
      </div>
    );
  }
  const message: Record<StudyMaterialTypeFilter, string> = {
    all: "No study materials yet — pick one from Drive.",
    pdf: "No PDFs yet — pick one from Drive.",
    docx: "No Word documents yet — pick one from Drive.",
    pptx: "No PowerPoint files yet — pick one from Drive.",
    xlsx: "No Excel files yet — pick one from Drive.",
  };
  return (
    <div className="space-y-3 py-12 text-center">
      <p className="font-medium">{message[type]}</p>
      <Button type="button" size="sm" className="gap-1.5" onClick={onAdd}><Plus className="h-4 w-4" /> Add material</Button>
    </div>
  );
}

function formatFileSize(sizeBytes?: number | null): string {
  if (sizeBytes == null || !Number.isFinite(sizeBytes)) return "Size unavailable";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = sizeBytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatDocumentDate(document: PersonalDocument): string {
  try {
    const date = document.createdAt?.toDate();
    return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : "Date unavailable";
  } catch {
    return "Date unavailable";
  }
}
