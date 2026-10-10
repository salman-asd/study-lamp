# Study Lamp — Roadmap v10.1 (Fit, Choose: Responsive UI, Reader Layout, Viewer Choice, General Settings)

Companion to v8 and v9. v8 (free tier, smoothness, features) and v9 (one Google connection) stay valid. v10.1 covers the seven questions asked after v9 was implemented. It updates v10: the Backup 401 diagnostic step was removed because the error went away without a code change (a small hardening step stays, see H1). For every question, the recommendation given here is adopted as the final decision.

No code was changed to produce this file. Everything below was read from the uploaded zip. Nothing was run (no `tsc`, no tests, no browser, no live Google call). Every **(verify)** item must be checked on a throwaway Google account or in a real browser.

---

## 1. Your seven questions, answered

### Q1. What does "Refresh thumbnails" do? (Settings → Google → Drive card)

The button calls `POST /api/drive/thumbnails/backfill` in a loop (25 items per call, 5 at a time) until `remaining` is 0. Each call does two jobs, oldest first:

1. **Migrates old thumbnails.** Documents that still carry a base64 `thumbnailData` field get that image moved into the server-only `driveThumbs` collection, and the field is deleted from the document (this is the R3/D16 work that keeps documents small).
2. **Fetches missing thumbnails.** For Drive items that were **never attempted** (`thumbnailAttemptedAt == null`), the server reads the file's `thumbnailLink` from Drive, downloads the image and stores it in `driveThumbs`. Every item is marked "attempted" afterwards, **even if it failed**, so one bad file cannot block the queue.

Two honest problems with it today:

- **The name is misleading.** It does not refresh thumbnails that already exist, and it does not retry the ones that failed (they are marked attempted). It only fills gaps. After it says "up to date", a file whose thumbnail failed once stays without an image until someone opens it (the thumbnail route self-heals on view).
- **The user is told nothing.** No text explains what it does, how many are missing, or how many failed.

Fix in step H2: rename to **"Fetch missing thumbnails"**, add one explanation line, show counts, and add a separate **"Retry failed"** action that resets the attempt flag. The existing prune route (`/api/drive/thumbnails/prune`) has no button in `DriveCard.tsx` (verify with a search); offer it as "Clean up unused thumbnails" in the same card.

### Q2. Backup page error: `DriveApiError status=401` → 502 "Couldn't list backups from Drive."

**Status: resolved on its own, no code change.** The diagnostic step from v10 is removed, and so are the root-cause suspects. I cannot tell from the code why it happened (a stale or half-granted connection that was refreshed later is possible, but that is a guess).

What is still worth fixing, because it is inconsistent in the code and will show the same ugly result next time:

- A persistent Drive 401 (after the one retry in `runWithDriveToken`) becomes HTTP 502 with a generic message. The same pattern is in `backup/route.ts` (POST) and probably `backup/restore`. A 401 that survives a fresh token means "reconnect", not "bad gateway".
- `settings/backup/page.tsx` hides connections with `status === "invalid"`, so a broken connection looks like "no connection" instead of "needs reconnect".
- The same page uses `catch (error: any)` four times, against the "no `as any` on boundaries" rule.

These three are now step H1 (small, no diagnostic, no live Google check needed).

### Q3. PDF viewer feels small, horizontal scroll, no way to hide the study panel

Cause, from the code:

- The detail page uses `grid lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.9fr)]`. From 1024 px wide the study panel is **always** side by side and takes at least 20 rem. The app sidebar (about 16 rem) also stays open. On a 1280 px laptop the PDF gets roughly 600 px, which is narrower than one A4 page at 100 %.
- `PdfReader` restores the saved `zoom` from `readerProgress` (`initialZoom`) and opens the document with `scale: zoomLevel.current`. A zoom saved on a wide monitor is applied to a narrow container, so the page is wider than the viewer and a horizontal scroll bar appears. There is **no fit-width mode** in the file (searched for it; verify against the plugin's zoom API).
- On phones the panel moves into a bottom-sheet dialog, which is fine. The gap is the 1024–1500 px range.

Decision (D21, recommendation adopted): which option is better? **A bottom dock that can collapse, plus a hide button, plus fit-width.** Reasons: a PDF page is portrait, so width is what it lacks, not height. A right-side panel steals width; a bottom drawer steals only height, which scrolling gives back. The panel is only needed in short bursts (read a summary, jot a note, take a quiz), so "hidden until I ask" is the right default on small screens.

Three dock modes, one icon button group in the reader toolbar:

| Mode | Icon (lucide) | Layout | Default when |
|---|---|---|---|
| Right | `PanelRight` | today's layout | viewport ≥ 1536 px |
| Bottom | `PanelBottom` | PDF full width, panel is a resizable drawer under it, collapsed to a tab bar | 1024–1535 px |
| Hidden | `PanelRightClose` | PDF full width, small "Study" floating button reopens the panel | user choice (and phones keep the existing sheet) |

Plus a **Focus mode** button (`Maximize2`) that hides the app sidebar and header for this page and adds an Esc/exit button. And **Fit width** / **Fit page** / 100 % zoom buttons; opening a document with no saved zoom, or whenever the container width changes and the user has not zoomed manually, re-applies fit-width.

### Q4. Study Materials filter card breaks on narrow widths

Cause, from the code: the filter row is `lg:grid-cols-[minmax(14rem,1fr)_12rem_minmax(13rem,auto)_11rem_auto]`. That is about 14 + 12 + 13 + 11 rem plus the icon column, near 58 rem (about 930 px), but the **main content area** at a 1024 px window is only about 720 px (the sidebar takes the rest). The breakpoint looks at the window, not at the card, so columns overflow. The tag control makes it worse: `SearchableTagMultiSelect` has `min-w-64` (16 rem) and `flex-wrap`, so selected tags make it grow taller and it covers the sort dropdown, and the grid's last column (grid/list icons) is pushed outside the card.

Fix (step H3): a container-aware layout (flex-wrap with `basis` and `min-w-0`, or Tailwind container queries), a tag control with a fixed height that shows "N tags" instead of growing, and the view icons pinned in their own flex item that never wraps off the card.

### Q5. Language dropdown: only "EN" or "BN", smaller, default shown on hover

Cause: `AiLanguagePicker` renders `{AI_LANGUAGE_LABELS[language]}{… " · default"}` **inside** `SelectItem`, and the shared `SelectItem` wraps all its children in `SelectPrimitive.ItemText`. Radix copies the whole `ItemText` into the trigger, so the closed dropdown shows "EN · default". The trigger is `w-44`.

Fix (step H4): keep only `EN` / `BN` inside `ItemText`; show the default marker **outside** `ItemText` (a small dot or star in the open list); trigger `h-8 w-[4.25rem]`; tooltip on the trigger "Default language: EN" or "Using BN for this generation (default: EN)"; `title` on the default item "Default language". The visible text label "Language" before it can shrink to an icon (`Languages`) with the same accessible name. One shared component, so all 8 places that use it (video page, playlist video page, roadmap, interests, onboarding, study materials detail, …) change at once.

### Q6. Why not use the Google viewers? Let the user choose.

First, the two methods you named, checked against how Study Lamp works:

| | Study Lamp reader (today) | **Method 2**: Drive/Docs `…/preview` iframe | **Method 1**: `docs.google.com/viewer?url=…&embedded=true` |
|---|---|---|---|
| How it gets the file | our server streams from Drive with a signed URL, browser renders it | browser loads Google's own preview, needs **the person's browser to be signed in** to the Google account that owns the file | **Google's servers** download the file from a public URL we give them |
| Works with private files | yes | yes, but only if signed in as the right account | only by handing Google a signed link to our server |
| Works on `localhost` | yes | yes | **no** (Google cannot reach localhost) |
| Third-party cookies blocked (Safari, Chrome Incognito, strict Firefox) | not affected | **often shows a sign-in page or "no preview"** (verify) | not affected, but see next rows |
| Privacy | file never leaves Drive + our server | file stays in Google | **file is fetched by a third-party viewer service** through our signed URL |
| Official / supported | ours | embeddable preview URL is commonly used; exact guarantees are Google's (verify) | legacy and undocumented; has been unreliable, with file size limits and "preview not available" errors (verify) |
| Study Lamp features | annotations, last page, zoom, "Explain this page", jump from notes to page, progress | **none of them** (iframe is a black box) | none |
| Google Docs / Sheets | exported copy (docx/xlsx) shown in our reader, "Last changed in Google …" note | **live, always current**, native look, formulas/tabs intact | not for native Docs/Sheets |

Answer to "why not":

- **Method 1 is not worth offering.** It needs a public URL, does not work on localhost, sends a signed link to a third party, and cannot show native Docs/Sheets. It also gives up every Study Lamp feature. Decision D22: do **not** build Method 1 (revisit only if Google publishes it as a supported API).
- **Method 2 is a good optional choice, especially for Google Docs and Sheets**, where it is live and always current instead of an exported copy. It is not a good default for PDFs because it loses annotations, progress, page jump and "Explain this page", and it breaks when the browser is not signed in to the right Google account. The code already uses a Drive `/preview` iframe for the fallback case (the `DocumentPreview` component).

So: **keep today's behaviour as the default and add a "Viewer" choice with Method 2 as the alternative**, with pros and cons printed next to each choice (step H6). The choice lives in **two places**: Settings → General holds the **default per type**, and the **document viewing page** has the same per-type choice in its toolbar, so a person can switch while reading without leaving the page (details in H6). The AI summary, quiz and notes keep working in every mode because they read text through `/api/documents/{id}/text`, not through the viewer (verify).

### Q7. What should the Settings → General sub menu contain?

Today Settings has: AI Connections, Interests, Categories, Google, Backups, Storage (and Tags for admins). There is **no General page**. Several general settings are scattered: theme is a header button, tours are in a header help menu, grid/list choice is in `localStorage` on the Study Materials page, and the default AI language lives inside AI Connections.

Proposed **General** (first item in the Settings submenu, and `/settings` redirects there instead of `/settings/ai`):

| Section | Items | Where it lives today |
|---|---|---|
| Appearance | Theme: System / Light / Dark | header `ThemeToggle` (keep the header button too) |
| Language | Default AI language EN / BN (same control, same data as AI Connections) | `settings/ai` "Generating language" |
| Study Materials | Default view (grid/list), default sort, default tab | `localStorage` + page state |
| Reading | **Default** viewer per type (see Q6; the viewing page offers the same choice), study panel position (Right / Bottom / Hidden), default zoom (Fit width / Fit page / 100 %) | does not exist |
| Help | Replay welcome tour, replay page tour, reset "dismissed hints" | header help menu, `TourProvider` |
| Account | Signed-in email, Sign out | header menu |

Sidebar order after this roadmap: **General, AI Connections, Google, Interests, Categories, Backups, Storage** (Tags for admins stays). Not proposed, because nothing in the code supports it: notifications, UI language (the app UI is English only; only AI output is EN/BN), billing.

Data model: one small map `users/{uid}.generalPrefs` (under 1 KB, D16), read once per login through a cached API route (same pattern as `aiPreferencesClient`), with `localStorage` as an offline cache. Nothing per-event is written.

---

## 2. Other findings from reading the zip

| # | Finding | Why it matters | Step |
|---|---|---|---|
| 1 | The zip again contains `.env.local` **and `.env.local.old`** | Secrets leak when a zip is shared. `.env.local.old` is easy to forget | H0 |
| 2 | A Drive 401 that survives the retry is mapped to 502 and never marks the connection | Users see a raw error, no reconnect path | H1 |
| 3 | `backup/page.tsx` hides connections with `status === "invalid"`, so after a future fix the page would say "no connection" instead of "reconnect" | Confusing | H1 |
| 4 | `backup/page.tsx` uses `catch (error: any)` four times | Breaks the "no `as any` on boundaries" rule | H1 |
| 5 | "Refresh thumbnails" never retries failed items | Misleading label | H2 |
| 6 | `SearchableTagMultiSelect` has a hard `min-w-64` and grows in height | Cause of the overlap in Q4 | H3 |
| 7 | `PdfReader` has no fit-width and restores a saved absolute zoom | Cause of the horizontal scroll in Q3 | H5 |
| 8 | Reader fallback iframe already exists for non-Word/Excel files, but there is no user choice | Q6 | H6 |
| 9 | Grid/list choice lives only in `localStorage` | Not shared across devices | H7 |

---

## 3. Decisions (FINAL for v10)

- **D21** PDF page layout: three dock modes (Right / Bottom / Hidden), Focus mode, fit-width default. Choice is remembered.
- **D22** Do not build "Google Docs Viewer `viewer?url=`" (Method 1). Offer the Drive/Docs `/preview` iframe (Method 2) as an optional viewer, never as the default for PDFs.
- **D23** Default viewer for everything stays the in-app reader. The **default per type** is set in Settings → General. The **viewing page has the same per-type choice** in its toolbar: it can apply to this document only, or be saved as the new default for that type (same stored value as General, so the two never disagree).
- **D24** `users/{uid}.generalPrefs` is one small map, whitelisted and validated on the server. No new collection, no per-event writes.
- **D25** A Drive 401 that survives a fresh token means "this connection must be reconnected": mark it, answer 409 with a clear message, never 502.
- **D27** For all seven questions, the recommended option in this file is the final decision (bottom dock + hide + focus, no Method 1, in-app reader default, compact EN/BN picker, General page as listed).
- **D26** The language picker shows only `EN` / `BN`. "Default" appears only as a tooltip or a small marker in the open list.
- Everything from v8 and v9 stays: narrow scopes (`drive.file`, `calendar.app.created`, `tasks`, `userinfo.email`), preview-confirm-apply for writes to Google content, free-tier rules, one OAuth client.

---

## 4. Steps at a glance

| Step | Title | Type | Risk | Depends on |
|---|---|---|---|---|
| H0 | Secrets and environment check | manual | none | none |
| H1 | Backup page hardening (401 → reconnect, no `any`) | code | low | H0 |
| H2 | Thumbnails card: honest name, counts, retry | code | low | none |
| H3 | Study Materials filter bar that never breaks | code | low | none |
| H4 | Compact EN/BN language picker | code | low | none |
| H5 | Reader layout: dock modes, focus mode, fit-width | code | medium | none |
| H6 | Viewer choice: General default + viewing-page switch | code | medium | H7 |
| H7 | General settings page and preferences store | code | medium | none |
| H8 | Tests, docs, hygiene | code | low | all |

**Recommended order:** H0 → H4 → H3 → H2 → H1 → H5 → H7 → H6 → H8 (H1 is small and can go anywhere).
**Parallel-safe:** H2, H3 and H4 are independent and touch different files.

---

## 5. Global Rules block (short version)

Paste once per session. Use the full v8 block if you have it.

```
You are working in the existing Next.js 14 (App Router) project Study Lamp (Firebase Auth + Firestore on the
FREE Spark plan, Tailwind, Radix UI, sonner). Source is under src/. Server code is in src/lib/server/ and uses
the Firebase ADMIN SDK only. API routes authenticate with a Firebase ID token and use withAuthedRoute.
Google APIs are called with plain fetch (no googleapis package). ONE Google OAuth client is used.

FINAL decisions:
- Scopes stay narrow: drive.file, calendar.app.created, tasks, userinfo.email. Never widen them.
- Every write to the user's Google content is previewed and confirmed. Nothing is deleted automatically.
- Firestore stays free-tier friendly: documents under 20 KB, every list has limit().
- PowerPoint is out of scope. AI languages are EN and BN only.

Rules:
1. READ FIRST. Open every file under "Read first". Never invent paths or APIs. Search the repo and say so
   when something is missing.
2. Smallest change that satisfies the task. No unrelated refactors or reformatting.
3. Never use the client Firebase SDK inside src/app/api/** or src/lib/server/**.
4. Never print, log or commit secrets or tokens. Never log Google response bodies. Use logServerError(label, err).
5. Every route authenticates BEFORE touching data, validates input, returns generic error messages.
6. A failed call is never shown as success.
7. No `as any` and no `catch (e: any)` on request, response or Google-API boundaries (use `unknown`).
8. Keep old behaviour working until a step says to remove it.
9. Add unit tests for pure logic. Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Report the real output.
   If something cannot be run, say so.
10. Anything marked (verify) depends on live Google behaviour or a real browser. Say what you could not check.
11. UI work: test mentally and list the widths checked (360, 768, 1024, 1280, 1536 px, sidebar open and closed).
12. End with: files changed (by folder structure) / manual test steps / read-write cost / anything unsure /
    real command output.
```

---

## STEP H0 — Secrets and environment check (manual, no code)

About 20 minutes. Do this first.

1. The uploaded zip contains `.env.local` and `.env.local.old`. If that zip was shared anywhere (chat, email, cloud link), treat every value in both files as exposed and rotate: Google OAuth client secret, Firebase Admin private key, the AI encryption key (use `scripts/reencrypt.ts`), `DRIVE_URL_SIGNING_SECRET`, `GOOGLE_SYNC_SIGNING_SECRET`, the OAuth state secret, YouTube key, Facebook secret.
2. Delete `.env.local.old` from the project folder. Add `.env*.old` and `*.zip` to `.gitignore` if missing.
3. For future zips, exclude `.env.local`, `.env.local.old`, `node_modules`, `.next`.
4. Run `npx tsc --noEmit`, `npm run lint`, `npm test` and note the result as the baseline for this roadmap.

---

## STEP H1 — Backup page hardening (401 → reconnect, no `any`)

**Fixes:** the inconsistencies listed under Q2 (findings 2, 3, 4). No diagnostic, no live Google check. **Firestore cost:** one extra write only when a connection is found rejected (at most once per connection per hour).

```
TASK H1 — make a rejected Drive connection show "reconnect" instead of a raw error.
Read first: src/app/api/drive/backup/list/route.ts, backup/route.ts, backup/restore/**, src/lib/server/driveConnections.ts,
driveConnectionResolver.ts, driveRequest.ts, googleDrive.ts (DriveApiError), src/app/settings/backup/page.tsx,
src/lib/driveClient.ts (listDriveBackups, createDriveBackup and the error type they throw).

1. Pure helper src/lib/server/driveErrors.ts:
   mapDriveRouteError(err): { status: number; body: { error: string; code?: "reconnect" } }
     - DriveConnectionError not_found -> 404; invalid -> 409 + code "reconnect"; network -> 503
     - DriveApiError 401 (it already survived the retry) -> 409 + code "reconnect",
       "Google rejected the saved permission. Reconnect Google in Settings -> Google."
     - DriveApiError 403 -> 403 with the existing permission wording
     - anything else -> 502 generic (unchanged).
   Use it in backup/list, backup (POST), backup/restore and any other route with the same `catch -> 502` pattern
   (search for `status: 502`). Keep every other response shape.
2. markDriveConnectionRejected(uid, connectionId) in driveConnections.ts: on a surviving 401 set status "invalid" on the
   document that holds the token (use the resolver), invalidate the token cache, at most one write per connection per
   hour. It never deletes anything and never changes grantedScopes.
3. Client (settings/backup/page.tsx, driveClient.ts): keep `code` on the thrown error; replace `catch (error: any)` with
   `catch (error: unknown)` and a small message helper; do NOT filter out "invalid" connections: show them with a
   "Needs reconnect" badge, disable Back up / Restore for them, and show an inline Alert with a "Reconnect Google"
   button -> /settings/google#drive when the error code is "reconnect" or every connection is invalid.
   Never show text like "DriveApiError status=401" to the user.
4. Check the Drive card in Settings -> Google: an "invalid" connection already shows a Reconnect button (do not duplicate).
5. Tests (recording fakes): mapDriveRouteError table; 401-after-retry marks once, 403 and DriveConnectionError do not;
   which connections are usable on the backup page; no tokens in logs.
```

**Test:** with a revoked connection, Backups shows the badge and the reconnect alert, never a status code. A healthy connection behaves exactly as today.

---

## STEP H2 — Thumbnails card: honest name, counts, retry

**Fixes:** Q1, finding 5. **Firestore cost:** count queries only when the card is opened (use aggregate `count()`, bounded).

```
TASK H2 — make "Refresh thumbnails" understandable and complete.
Read first: src/components/google/DriveCard.tsx, src/lib/driveClient.ts (backfillDriveThumbnails),
src/app/api/drive/thumbnails/backfill/route.ts, thumbnails/prune/route.ts, src/lib/server/driveThumbnails.ts
(countLegacyThumbnails, countUnattemptedThumbnails, markThumbnailAttempted), src/lib/server/driveThumbnailPrune.ts,
src/hooks/useThumbnailHealing.ts.

1. New route GET /api/drive/thumbnails/status -> { missing, failed, legacy } using the existing count helpers
   plus one new count of items attempted but without a stored thumbnail (failed). Authenticated, scope
   "drive:thumbnail-status", cached in the response for 60 seconds (private, max-age=60).
2. New route POST /api/drive/thumbnails/retry-failed: resets thumbnailAttemptedAt to null for at most 50 items
   whose thumbnail is missing, returns { reset, remaining }. The existing backfill then picks them up. No deletes.
3. DriveCard: rename the button to "Fetch missing thumbnails". Under it one muted line:
   "Study Lamp saves a small preview image for each Drive file so lists load fast. This fetches previews that
   are missing. Files that have no preview in Google Drive keep an icon."
   Show "Missing: N · Failed: N" from the status route. Add "Retry failed" (only when failed > 0) and
   "Clean up unused thumbnails" (calls the existing prune route in a loop while remaining > 0, with a confirm
   dialog that states the count). The button label while running keeps "(N left)".
4. Keep the loop guard in the client so it can never spin when nothing is written.
5. Tests: pure helper that turns status counts into the card text; retry route resets at most 50.
```

**Test:** the card explains itself, shows counts, "Fetch missing thumbnails" fills gaps, "Retry failed" resets and re-fetches them, and a file without a Google preview keeps its icon without an error toast.

---

## STEP H3 — Study Materials filter bar that never breaks

**Fixes:** Q4, finding 6. **Cost:** 0.

```
TASK H3 — a filter card that adapts to the card width, not the window width.
Read first: src/app/study-materials/page.tsx (the block around "Search study materials", the grid class
lg:grid-cols-[minmax(14rem,1fr)_12rem_minmax(13rem,auto)_11rem_auto], the grid/list buttons),
src/components/shared/TagCategoryPicker.tsx (SearchableTagMultiSelect), src/components/ui/select.tsx,
tailwind.config (check whether @tailwindcss/container-queries is installed; if not, use flex-wrap, do not add a package).

1. Replace the five-column grid with a two-row flex layout:
   Row 1: Search (flex-1 min-w-0) + view toggle (grid/list, shrink-0, never wraps off the card).
   Row 2: Category, Tags, Sort, each `min-w-[10rem] flex-1 basis-[10rem]`, wrapping naturally.
   The card has `min-w-0`, no fixed pixel widths on children, no horizontal scroll at any width.
2. SearchableTagMultiSelect: remove `min-w-64`. The closed control is ONE row, h-10: shows "All tags", one tag name,
   or "N tags" (with a count badge) and truncates. Selected tags appear as removable chips in a separate
   line BELOW the filter row (not inside the control), max two lines then "+N more". The dropdown list is
   positioned under the control and has `z-30` above the sort select. Click-outside and Escape close it.
   Keep its props so the other pages that use it still compile.
3. The placeholder "Search titles" becomes "Search title, category or tag" ONLY if the search really matches those
   fields (check the filter function); otherwise keep "Search titles" and do not change behaviour.
4. Check the same widths for the tab strip (it already scrolls) and for the "Add material" header.
5. Tests: pure helper for the tag summary text ("All tags", "Name", "3 tags"); no visual test needed.
```

**Test (browser):** at 360, 768, 1024, 1280 and 1536 px, with the sidebar open and closed, nothing overlaps, the grid/list icons stay inside the card, selecting five tags does not move the sort dropdown.

---

## STEP H4 — Compact EN/BN language picker

**Fixes:** Q5. **Cost:** 0. Changes every page that uses `AiLanguagePicker`.

```
TASK H4 — show only EN or BN, make the control small, explain "default" on hover.
Read first: src/components/ai/AiLanguagePicker.tsx, src/components/ui/select.tsx, src/lib/aiLanguageState.ts
(AI_LANGUAGE_LABELS), and every caller (grep -rn AiLanguagePicker src), including settings/ai/page.tsx which has its
own Select for the default language.

1. select.tsx: add an optional `suffix?: React.ReactNode` prop to SelectItem rendered OUTSIDE
   SelectPrimitive.ItemText (right side, muted). Existing callers are unaffected. Reason: ItemText is what Radix
   copies into the trigger, so anything inside it shows in the closed control.
2. AiLanguagePicker:
   - items: children = AI_LANGUAGE_LABELS[language] only ("EN" / "BN"); for the default item pass
     suffix = a small filled dot with aria-hidden and `title="Default language"`; the item itself gets
     `title={language === defaultLanguage ? "Default language" : undefined}`.
   - trigger: `h-8 w-[4.5rem] px-2` (the word "Language" before it becomes a `Languages` icon, 14 px, with
     sr-only text "Language" so the accessible name is unchanged; keep the `label` prop for pages that pass one:
     in that case keep the visible text but allow it to hide below sm).
   - trigger tooltip: `title` = default selected: "Default language: EN"; overridden: "Using BN for this generation
     (your default is EN). Click the reset icon to go back."
   - the reset icon button stays, 32 px.
3. settings/ai page: its default-language Select (`w-36`) also loses any "default" text and uses w-24.
4. Tests: pure helper languagePickerTitle(value, defaultLanguage) for the 2 x 2 cases.
```

**Test:** the closed control shows exactly "EN" or "BN"; hovering shows "Default language: …"; the open list marks the default with a dot; width is about 72 px; keyboard and screen reader labels are unchanged.

---

## STEP H5 — Reader layout: dock modes, focus mode, fit-width

**Fixes:** Q3, finding 7. **Cost:** 0 extra writes (the dock choice is local until H7).

```
TASK H5 — give the document page more room and let the user decide where the study panel lives.
Read first: src/app/study-materials/[documentId]/page.tsx, src/components/documents/PdfReader.tsx (toolbar at the
top, the container with h-[68vh] lg:h-[calc(100vh-15rem)], zoomLevel / initialZoomRef, requestZoom, openDocumentBuffer
scale), DocumentReaderSwitch.tsx, DocumentStudyPanel.tsx (DocumentStudyMobileSheet), DocxReader.tsx, XlsxReader.tsx,
src/components/layout/AppShell.tsx (to hide sidebar/header in focus mode), the installed zoom plugin types under
node_modules/@embedpdf/** (find which zoom modes exist: fit width, fit page; verify names before using them).

1. New pure module src/lib/readerLayout.ts:
   type StudyDock = "right" | "bottom" | "hidden";
   resolveStudyDock(saved: StudyDock | null, viewportWidth: number): StudyDock
     (saved wins; otherwise >=1536 -> right, 1024..1535 -> bottom, <1024 -> hidden because phones use the existing sheet).
   readerHeightClass(dock, focus): the height classes for the reader container so that "bottom" gives the PDF
   about 70 dvh and "hidden"/focus gives calc(100dvh - 8rem).
2. Page layout (study-materials/[documentId]/page.tsx):
   - "right": today's grid, but the panel is min 20rem / max 26rem and the reader column keeps `min-w-0`.
   - "bottom": single column. The reader is full width; below it a drawer (collapsed = one 44 px tab bar with
     Summary / Quiz / Notes tabs; expanded = up to 45 dvh, scrollable, resizable by a drag handle or a
     "expand / collapse" chevron). Opening a tab expands it; the PDF stays visible above.
   - "hidden": reader full width; a floating "Study" button (bottom right, 44 px target) reopens the panel in the
     chosen mode ("bottom" if the saved mode is hidden).
   - Phones (<1024 px): keep DocumentStudyMobileSheet unchanged.
3. Toolbar (the strip above the PDF, shared with Docx/Xlsx readers through a small ReaderToolbar component):
   icon group for the dock mode (PanelRight / PanelBottom / PanelRightClose, `aria-pressed`, tooltips),
   Focus mode (Maximize2 / Minimize2), and for PDF: Fit width, Fit page, 100 %, zoom - / +.
4. Focus mode: hides the app sidebar and header for this page only (a context flag in AppShell or a data attribute),
   shows an exit button and works with Esc. State is not persisted.
5. PdfReader zoom: add `zoomMode: "fit-width" | "fit-page" | number` internally.
   - New document with no saved zoom, or a saved zoom that would be wider than the container -> fit-width.
   - Saved zoom is a manual number only if the user zoomed manually before (store `zoomMode` next to `zoom` in
     readerProgress; old documents without it are treated as "fit-width" so the horizontal scroll goes away).
   - A ResizeObserver on the container re-applies fit-width (debounced 150 ms) while the mode is fit-width, so
     hiding the panel or toggling focus mode makes the page grow without a reload.
   - Keep the existing restore of the last page. Never write progress while restoring.
6. Persist the dock choice in localStorage key "sl.studyDock" for now (H7 moves it into General settings).
7. Tests: resolveStudyDock for every width and saved value; readerHeightClass; the zoom decision function
   (saved manual zoom wider than container -> fit-width; fit-width stays fit-width after a resize).
```

**Test (browser):** open a PDF at 1280 px: it starts in "bottom" mode, no horizontal scroll, the panel opens as a drawer under the PDF; "hidden" gives the PDF the whole width; focus mode hides the app chrome; resizing the window keeps fit-width; phone layout is unchanged.

---

## STEP H7 — General settings page and preferences store

**Fixes:** Q7, finding 9. **Depends on:** none (H6 and part of H5 read from it). **Firestore cost:** 1 read per login (cached) and 1 write per change.

```
TASK H7 — add Settings -> General and one small preferences store.
Read first: src/components/layout/Sidebar.tsx (settings submenu), src/app/settings/page.tsx (redirect to /settings/ai),
src/app/settings/ai/page.tsx (Generating language section), src/components/ai/AiLanguageProvider.tsx,
src/lib/aiPreferencesClient.ts, src/lib/server/aiPreferences.ts (pattern: users/{uid}.aiSettings, validation),
src/components/theme/ThemeToggle.tsx, src/components/tour/TourProvider.tsx (startTour, resetAll),
src/components/layout/Header.tsx (help menu), src/app/study-materials/page.tsx (viewMode in localStorage),
firestore.rules (users/{uid} client access), docs/firestore-budget.md.

1. Server: src/lib/server/generalPrefs.ts with a strict whitelist and validator (pure, unit-tested):
   generalPrefs = {
     studyViewMode: "grid" | "list",
     studySort: "recent" | "title" | "size",
     studyDock: "right" | "bottom" | "hidden" | null,
     readerZoom: "fit-width" | "fit-page" | "actual",
     viewerPdf: "reader" | "drive-preview",
     viewerGoogleDoc: "reader" | "google-preview",
     viewerGoogleSheet: "reader" | "google-preview",
     viewerOffice: "reader" | "drive-preview"      // Word and Excel files
   }
   Unknown keys are dropped, invalid values fall back to defaults, and the stored map stays under 1 KB.
   Routes GET and PUT /api/preferences/general (withAuthedRoute, scope "prefs:general"); PUT merges only the keys
   sent. Stored as users/{uid}.generalPrefs with { merge: true }. Do not touch aiSettings.
2. Client: src/lib/generalPrefsClient.ts and a GeneralPrefsProvider (load once per login like AiLanguageProvider,
   expose prefs + setPref with an optimistic update and rollback on failure, localStorage cache so the first paint is
   right). Mount it next to AiLanguageProvider.
3. Page /settings/general with the sections from the roadmap table (Appearance, Language, Study Materials,
   Reading, Help, Account). Language shows the SAME control and saves through the existing AI preferences API
   (single source of truth, no copy). Theme uses the existing ThemeToggle logic. Help calls startTour / resetAll.
   Account shows the signed-in email and a Sign out button.
   Each section is a Card with one sentence of description; every control saves on change with a small
   "Saved" status, and failures show a toast and roll back.
4. Sidebar: add "General" (icon SlidersHorizontal) as the FIRST submenu entry; /settings redirects to
   /settings/general. Keep every existing link.
5. Wire the readers of the old values: Study Materials page reads studyViewMode / studySort from the provider
   (and migrates the existing localStorage value once); the document page reads studyDock and readerZoom
   (replacing the H5 localStorage key, migrating it once).
6. Tests: validator (drops unknown keys, rejects bad enum values, size under 1 KB), merge semantics, migration of the
   old localStorage values, no write when the value did not change.
```

**Test:** Settings shows General first. Changing the view mode on one device shows on another after reload. The language control in General and in AI Connections always agree. Replay tour works from General.

---

## STEP H6 — Viewer choice (in-app reader or Google preview)

**Fixes:** Q6. **Depends on:** H7 (the preference store). **Cost:** 0 extra writes.

```
TASK H6 — let the user choose how documents are shown, with pros and cons next to each choice.
Read first: src/components/documents/DocumentReaderSwitch.tsx (DocumentPreview already renders
https://drive.google.com/file/d/{id}/preview in an iframe), src/app/study-materials/[documentId]/page.tsx,
src/lib/googleLinks.ts, src/types/index.ts (PersonalDocument: fileType, googleNative, mimeType),
next.config.js and vercel.json (Content-Security-Policy frame-src / X-Frame-Options: confirm that drive.google.com
and docs.google.com may be framed; if a CSP exists, add ONLY those two hosts for frame-src; verify),
src/lib/generalPrefsClient.ts (from H7).

1. Pure module src/lib/documentViewer.ts:
   type ViewerKind = "reader" | "drive-preview" | "google-preview";
   resolveViewer(doc, prefs, perDocumentOverride?): ViewerKind with these rules:
     pdf -> prefs.viewerPdf (reader | drive-preview)
     native Google Doc -> prefs.viewerGoogleDoc (reader | google-preview)
     native Google Sheet -> prefs.viewerGoogleSheet (reader | google-preview)
     docx / xlsx files -> prefs.viewerOffice (reader | drive-preview)
     pptx -> always "drive-preview" (no in-app reader exists; PowerPoint stays out of scope otherwise).
   previewUrl(doc, kind): string | null, built only from a validated file id (reuse FILE_ID regex):
     drive-preview     -> https://drive.google.com/file/d/{id}/preview
     google-preview Doc   -> https://docs.google.com/document/d/{id}/preview
     google-preview Sheet -> https://docs.google.com/spreadsheets/d/{id}/preview   (verify it renders in an iframe;
                              if not, use .../htmlview and report which one worked)
   Never use docs.google.com/viewer?url= (decision D22) and never put a Study Lamp signed URL into any Google URL.
2. DocumentReaderSwitch: call resolveViewer; when the result is a preview kind, render a new GooglePreviewFrame
   component (iframe, `title`, `referrerPolicy="no-referrer"`, `sandbox="allow-scripts allow-same-origin allow-popups
   allow-forms"`, `allow="autoplay"` only for Drive video preview — not needed here, so omit it, h-[calc(100dvh-14rem)])
   with a 6 second "still loading" hint and a visible fallback row under it:
   "Not loading? Sign in to the right Google account in this browser, or switch to the Study Lamp reader."
   with two buttons: "Open in Google" and "Use Study Lamp reader".
3. Viewing page (study-materials/[documentId]): a "Viewer" menu in the toolbar (icon `Eye`, label shows the current
   viewer). It shows ONLY the options that exist for THIS file type (PDF: Study Lamp reader | Drive preview;
   Google Doc: reader | Google preview; Google Sheet: reader | Google preview; Word/Excel: reader | Drive preview;
   PowerPoint: no menu), each with its short pros/cons (same text as in General, one shared constant).
   Choosing an option applies at once and offers two actions:
     - "Just this document" (kept in sessionStorage per document id, never written to Firestore);
     - "Use for all <type>" (e.g. "all PDFs"), which saves the SAME generalPrefs key as Settings -> General
       (viewerPdf / viewerGoogleDoc / viewerGoogleSheet / viewerOffice) through setPref.
   A small caption under the menu says which one is active: "Default for PDFs" or "This document only".
   Because both places write the same key, changing it in one shows in the other without a reload.
4. When a preview kind is active, disable the features that cannot work and say why in a tooltip:
   annotations, "Explain this page", note-to-page jump, progress saving. Summary, quiz and notes keep working
   (they use /api/documents/{id}/text); check that nothing in the study hook depends on the PDF reader being mounted
   and fix any such dependency.
5. Settings -> General -> Reading: a "Default viewer" card with one row per type (the viewing page offers the same choice). Each option shows its pros and cons as
   two short lines, so the person can decide:
     Study Lamp reader (default)
       + Annotations, last page, zoom memory, Explain this page, works without a Google sign-in in the browser
       - Google Docs/Sheets show an exported copy (a note shows when it was last changed in Google)
     Google preview (Drive / Docs / Sheets)
       + Always the live, current Google version, native look, formulas and tabs intact
       - No annotations, progress or page tools; needs this browser to be signed in to the same Google account;
         may show a sign-in page when third-party cookies are blocked
   The PDF row only offers "Drive preview", with the same pros and cons text adapted.
6. Tests: resolveViewer table for every file type x preference x override; the viewing-page menu lists only valid options per type and "Use for all" writes the right key; previewUrl rejects bad ids and never builds
   a docs.google.com/viewer URL; pptx always resolves to drive-preview; a unit test that no resolved URL contains
   "/api/drive/stream" or a signature parameter.
```

**Test (throwaway account):** default behaviour is unchanged. Switch "Google Docs" to Google preview in General: a Google Doc opens in the live Google view. Open the same page in a private window signed out of Google: the fallback row appears and "Use Study Lamp reader" works. A PDF in Drive preview has no Explain-page button and a tooltip says why.

---

## STEP H8 — Tests, docs, hygiene

```
TASK H8 — close the gaps.
Read first: docs/google-workspace.md, docs/security.md, docs/firestore-budget.md, docs/deploy.md, README.md.

1. docs/google-workspace.md: add a troubleshooting row "Backups: Google rejected the saved permission (401)" ->
   reconnect Google, explain that the app marks the connection and shows a reconnect alert.
2. docs/firestore-budget.md: add generalPrefs (one map, under 1 KB, one read per login, one write per change) and the
   thumbnail status counts (aggregate count queries, 60 s cache).
3. docs/security.md: say that the Google preview viewer shows files through the person's own browser session, that no
   Study Lamp signed URL is ever sent to a Google viewer service, and that .env.local and .env.local.old must never be
   zipped or committed.
4. Run grep -rn "catch (error: any)\|catch (err: any)" src and fix the touched files only; report the rest as a list.
5. Run npx tsc --noEmit, npm run lint, npm test; report real output.
```

---

## 6. Manual test checklist (after all steps)

1. Backups: list loads. Revoke access in your Google account on purpose: Backups shows the reconnect badge and alert, not a status code.
2. Settings → Google → Drive: card explains thumbnails, counts look right, "Retry failed" works.
3. Study Materials at 360 / 768 / 1024 / 1280 / 1536 px: no overlap, icons inside the card.
4. Any AI action: language control shows "EN" or "BN" only; hover shows default.
5. A PDF at 1280 px: no horizontal scroll, dock buttons work, focus mode works, last page is restored.
6. Settings → General: every control saves and survives a reload and a second device.
7. Viewer choice: reader (default); in General switch Google Docs to Google preview; on a PDF page use the Viewer menu with "Just this document" and "Use for all PDFs" and check General shows the change; then the signed-out fallback.

## 7. Definition of done (every step)

1. `npx tsc --noEmit` has zero errors, `npm test` is green, `npm run lint` runs.
2. The manual test in the step passes.
3. No scope was widened. No secret was printed, logged or committed.
4. The report lists files changed (by folder structure), real command output, read/write cost, and anything uncertain.

## 8. Quick summary

- **Refresh thumbnails** only fills missing thumbnails and never retries failures: rename it, explain it, add counts and "Retry failed" (H2).
- **Backup 401** resolved on its own; only the hardening stays: a surviving 401 marks the connection and shows "Reconnect Google", invalid connections stay visible, no `any` (H1).
- **PDF space**: bottom dock + hide + focus mode + fit-width; the horizontal scroll comes from a saved absolute zoom (H5).
- **Filter card** breaks because columns follow the window, not the card, and the tag box has `min-w-64` (H3).
- **Language picker**: put "default" outside `ItemText`, shrink to about 72 px (H4).
- **Viewers**: keep the in-app reader as default; add Google preview (Method 2) as a choice with pros and cons, set per type in General (default) and switchable on the viewing page (this document, or all of that type); do not build the `viewer?url=` method (H6, H7).
- **General** holds appearance, language, study materials, reading, help and account (H7).
- Before anything else: the zip contains `.env.local` and `.env.local.old`; rotate secrets if it was shared (H0).
