"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useAuth } from "@/components/auth/AuthProvider";
import { useAiLanguageContext } from "@/components/ai/AiLanguageProvider";
import { useGeneralPrefs } from "@/components/settings/GeneralPrefsProvider";
import { useTour } from "@/components/tour/TourProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateAiPreferences } from "@/lib/aiPreferencesClient";
import { VIEWER_COPY, VIEWER_LABELS, type ViewerPrefKey } from "@/lib/documentViewer";
import type { GeneralPrefs } from "@/lib/generalPrefs";
import { Check, Loader2 } from "lucide-react";

export default function GeneralSettingsPage() {
  return (
    <RequireAuth>
      <AppShell>
        <GeneralSettingsContent />
      </AppShell>
    </RequireAuth>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h2 className="font-display text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="space-y-3">{children}</div>
      </CardContent>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function PrefSelect<K extends keyof GeneralPrefs>({
  prefKey, label, options, valueOf, parse, width = "w-44",
}: {
  prefKey: K;
  label: string;
  options: Array<{ value: string; label: string }>;
  valueOf: (value: GeneralPrefs[K]) => string;
  parse: (value: string) => GeneralPrefs[K];
  width?: string;
}) {
  const { prefs, setPref } = useGeneralPrefs();
  return (
    <Select value={valueOf(prefs[prefKey])} onValueChange={(value) => void setPref(prefKey, parse(value))}>
      <SelectTrigger className={width} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function ViewerRow({ prefKey, title, previewKind, previewLabel }: {
  prefKey: ViewerPrefKey; title: string; previewKind: "drive-preview" | "google-preview"; previewLabel: string;
}) {
  const { prefs, setPref } = useGeneralPrefs();
  const value: string = prefs[prefKey];
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Row label={title}>
        <Select value={value} onValueChange={(next) => void setPref(prefKey, next as GeneralPrefs[ViewerPrefKey])}>
          <SelectTrigger className="w-48" aria-label={`Default viewer for ${title}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="reader">{VIEWER_LABELS.reader} (default)</SelectItem>
            <SelectItem value={previewKind}>{previewLabel}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          <p className="font-medium text-foreground">{VIEWER_LABELS.reader}</p>
          <p>+ {VIEWER_COPY.reader.pros}</p>
          <p>− {VIEWER_COPY.reader.cons}</p>
        </div>
        <div>
          <p className="font-medium text-foreground">{previewLabel}</p>
          <p>+ {VIEWER_COPY.preview.pros}</p>
          <p>− {VIEWER_COPY.preview.cons}</p>
        </div>
      </div>
    </div>
  );
}

function GeneralSettingsContent() {
  const router = useRouter();
  const { user, profile, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { saveState } = useGeneralPrefs();
  const { defaultLanguage, setDefaultLanguage } = useAiLanguageContext();
  const { startTour, resetAll } = useTour();
  const [mounted, setMounted] = React.useState(false);
  const [languageSaving, setLanguageSaving] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  async function changeLanguage(language: "en" | "bn") {
    if (!user || language === defaultLanguage) return;
    const previous = defaultLanguage;
    setDefaultLanguage(language);
    setLanguageSaving(true);
    try {
      // Same API and same data as Settings -> AI Connections: one source of truth.
      const saved = await updateAiPreferences(await user.getIdToken(), { generatingLanguage: language });
      setDefaultLanguage(saved.generatingLanguage);
    } catch (error) {
      setDefaultLanguage(previous);
      toast.error(error instanceof Error ? error.message : "Couldn't save the language.");
    } finally {
      setLanguageSaving(false);
    }
  }

  const status = saveState === "saving" || languageSaving
    ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span>
    : saveState === "saved"
      ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status"><Check className="h-3 w-3" />Saved</span>
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">General</h1>
          <p className="mt-1 text-sm text-muted-foreground">Settings that apply across Study Lamp. Every change is saved as you make it.</p>
        </div>
        <div className="min-h-5">{status}</div>
      </div>

      <Section title="Appearance" description="Light, dark, or follow your device.">
        <Row label="Theme">
          {mounted ? (
            <Select value={theme ?? "system"} onValueChange={setTheme}>
              <SelectTrigger className="w-40" aria-label="Theme"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          ) : <div className="h-10 w-40" />}
        </Row>
      </Section>

      <Section title="Language" description="Default language for everything the AI generates. You can change it for one generation next to each Generate button.">
        <Row label="Default AI language">
          <Select value={defaultLanguage} onValueChange={(value) => { if (value === "en" || value === "bn") void changeLanguage(value); }} disabled={languageSaving}>
            <SelectTrigger className="w-24" aria-label="Default AI language"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="en">EN</SelectItem>
              <SelectItem value="bn">BN</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <Section title="Study Materials" description="How your study materials list opens.">
        <Row label="Default view">
          <PrefSelect prefKey="studyViewMode" label="Default view" valueOf={(v) => v} parse={(v) => (v === "list" ? "list" : "grid")} options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]} width="w-40" />
        </Row>
        <Row label="Default sort">
          <PrefSelect prefKey="studySort" label="Default sort" valueOf={(v) => v} parse={(v) => (v === "title" || v === "size" ? v : "recent")} options={[{ value: "recent", label: "Recently added" }, { value: "title", label: "Title" }, { value: "size", label: "File size" }]} width="w-44" />
        </Row>
      </Section>

      <Section title="Reading" description="How documents open. You can also switch the viewer on the document page itself.">
        <Row label="Study panel position" hint="Where Summary, Quiz and Notes sit on large screens. Automatic puts it beside the page on very wide screens and under it otherwise. Phones always use a bottom sheet.">
          <PrefSelect prefKey="studyDock" label="Study panel position" valueOf={(v) => v ?? "auto"} parse={(v) => (v === "right" || v === "bottom" || v === "hidden" ? v : null)} options={[{ value: "auto", label: "Automatic" }, { value: "right", label: "Right" }, { value: "bottom", label: "Bottom" }, { value: "hidden", label: "Hidden" }]} />
        </Row>
        <Row label="Default PDF zoom">
          <PrefSelect prefKey="readerZoom" label="Default PDF zoom" valueOf={(v) => v} parse={(v) => (v === "fit-page" || v === "actual" ? v : "fit-width")} options={[{ value: "fit-width", label: "Fit width" }, { value: "fit-page", label: "Fit page" }, { value: "actual", label: "100 %" }]} width="w-40" />
        </Row>
        <p className="pt-1 text-sm font-medium">Default viewer</p>
        <ViewerRow prefKey="viewerPdf" title="PDFs" previewKind="drive-preview" previewLabel={VIEWER_LABELS["drive-preview"]} />
        <ViewerRow prefKey="viewerGoogleDoc" title="Google Docs" previewKind="google-preview" previewLabel={VIEWER_LABELS["google-preview"]} />
        <ViewerRow prefKey="viewerGoogleSheet" title="Google Sheets" previewKind="google-preview" previewLabel={VIEWER_LABELS["google-preview"]} />
        <ViewerRow prefKey="viewerOffice" title="Word and Excel files" previewKind="drive-preview" previewLabel={VIEWER_LABELS["drive-preview"]} />
        <p className="text-xs text-muted-foreground">PowerPoint files always open in the Drive preview.</p>
      </Section>

      <Section title="Help" description="Guided tours and hints.">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => startTour("welcome", { force: true })}>Replay welcome tour</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { void resetAll().then(() => toast.success("Tours reset — they'll be offered again.")); }}>Reset dismissed hints</Button>
        </div>
      </Section>

      <Section title="Account" description="The account you are signed in with.">
        <Row label={profile?.email ?? user?.email ?? "Signed in"}>
          <Button type="button" variant="outline" size="sm" onClick={async () => { await logout(); router.push("/login"); toast.success("Logged out"); }}>Sign out</Button>
        </Row>
      </Section>
    </div>
  );
}
