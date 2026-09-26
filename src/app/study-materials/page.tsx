"use client";

import * as React from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { DriveImportPanel } from "@/components/drive/DriveImportPanel";
import { listPersonalDocuments, deletePersonalDocument } from "@/lib/firestore/personalDocuments";
import type { PersonalDocument } from "@/types";
import { FileText, Plus, Trash2, FileSpreadsheet, Presentation } from "lucide-react";
import { toast } from "sonner";

const FILE_TYPE_ICON: Record<PersonalDocument["fileType"], React.ReactNode> = {
  pdf: <FileText className="h-5 w-5 text-red-500" />,
  docx: <FileText className="h-5 w-5 text-blue-500" />,
  pptx: <Presentation className="h-5 w-5 text-orange-500" />,
  xlsx: <FileSpreadsheet className="h-5 w-5 text-emerald-500" />,
};

const FILE_TYPE_LABEL: Record<PersonalDocument["fileType"], string> = {
  pdf: "PDF", docx: "Word", pptx: "PowerPoint", xlsx: "Excel",
};

export default function StudyMaterialsPage() {
  return (
    <RequireAuth>
      <StudyMaterialsContent />
    </RequireAuth>
  );
}

function StudyMaterialsContent() {
  const { user } = useAuth();
  const [documents, setDocuments] = React.useState<PersonalDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [importOpen, setImportOpen] = React.useState(false);

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

  React.useEffect(() => { load(); }, [load]);

  async function handleDelete(documentId: string, title: string) {
    if (!user) return;
    if (!confirm(`Remove "${title}" from Study Lamp? The file stays in your Google Drive.`)) return;
    try {
      await deletePersonalDocument(user.uid, documentId);
      setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    } catch (error: any) {
      toast.error(error?.message || "Failed to remove this document.");
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold">Study Materials</h1>
            <p className="text-sm text-muted-foreground">PDFs and Office documents, with the same AI summary/quiz tools your videos have.</p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setImportOpen(true)}>
            <Plus className="h-4 w-4" /> Add material
          </Button>
        </div>

        {loading && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {!loading && documents.length === 0 && (
          <Card>
            <CardContent className="space-y-2 p-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No study materials yet</p>
              <p>Import a PDF, Word, PowerPoint, or Excel file from Google Drive to get started.</p>
              <Button size="sm" className="mt-2 gap-1.5" onClick={() => setImportOpen(true)}><Plus className="h-4 w-4" /> Add material</Button>
            </CardContent>
          </Card>
        )}

        {!loading && documents.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {documents.map((docItem) => (
              <Card key={docItem.id} className="group relative">
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="mt-0.5 shrink-0">{FILE_TYPE_ICON[docItem.fileType]}</div>
                  <Link href={`/study-materials/${docItem.id}`} className="min-w-0 flex-1">
                    <p className="truncate font-medium">{docItem.title}</p>
                    <Badge variant="outline" className="mt-1">{FILE_TYPE_LABEL[docItem.fileType]}</Badge>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => handleDelete(docItem.id, docItem.title)}
                    aria-label="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add a study material</DialogTitle></DialogHeader>
          <DriveImportPanel
            accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
            allowFolders={false}
            onImported={() => { setImportOpen(false); load(); }}
          />
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
