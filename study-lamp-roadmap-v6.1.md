# Study Lamp — Roadmap v6.1 (Hardening + Two-Way Google Workspace with Confirmation + Remaining Features)

Supersedes v5 (R1–R13, which the codebase now reflects at roughly 94%) and the unfinished part of v4.1 (S16–S23).
Based on a read of the latest `src.zip` (406 files) and `GOOGLE_WORKSPACE_INTEGRATION_PLAN.md`.
I did **not** run the app, `tsc`, lint, tests or a build, and I had no network access. Claims about Google APIs come from my knowledge of Google's documentation and are marked **(verify)** where a wrong guess would cost you a rework. Every step starts with a diagnostic so you can confirm before building.

> **What changed in v6.1 (your request).** Google integration is now **two-way** instead of one-way, and **every write or modification needs your confirmation first**, in both directions.
>
> - Calendar and Tasks goal sync (W3, W4): one-way push becomes two-way sync with a preview, conflict handling and confirmation.
> - Docs and Sheets: still imported read-only (W1), plus a new append-only write-back step (W1b), also confirmed.
> - New shared step **C1**: the preview → confirm → apply machinery with a server-side signed token, so no route can write silently.
> - W5 gains a sync history; removal and disconnect keep their extra confirmations.
> - Decisions D3, D4, D7, D8 changed; D9–D12 added. Global Rules gained rules 13–15.
> - Changed or new text is marked **(v6.1)**.

---

## 0. Product decisions that stay FINAL

- No PowerPoint tab, viewer or outline route.
- AI language is `en` | `bn` only. No Arabic, no RTL.
- Drive keeps the narrow `drive.file` scope. Never widen it.
- **Two-way, but never silent (v6.1).** Google integration works in both directions (Study Lamp → Google and Google → Study Lamp). Every write or modification, in either direction, is previewed and needs an explicit user confirmation first. Reading from Google to check for changes needs no confirmation; writing does.
- Nothing is deleted on either side automatically. A delete is always a separate, extra-confirmed action.
- The confirmation is enforced **on the server** (signed plan token, see C1), not only in the UI.

---

## 1. Analysis of `GOOGLE_WORKSPACE_INTEGRATION_PLAN.md`

The plan is a sensible generic outline. It was written without the code, so several parts do not fit this repo and a few are missing. All the file paths it lists do exist (`src/app/api/drive/`, `src/lib/server/`, `src/lib/driveClient.ts`, `src/app/settings/drive/page.tsx`, `src/lib/firestore/goals.ts`, `src/app/goals/page.tsx`, `src/types/index.ts`, `firestore.rules`, `docs/deploy.md`, `.env.example`). `README.md` is not in the zip.

### 1.1 What to keep

| Plan item | Why it fits |
|---|---|
| Opt-in, off by default | Keeps risk low. **(v6.1)** One-way becomes two-way with every write confirmed; see 1.5. |
| Do not touch pre-existing events or tasks | Keep, but see 1.2 #4 for how to *enforce* it. |
| No automatic remote deletion | Keep, in **both** directions (nothing is deleted automatically in Google or in Study Lamp). Matters more because goals are deleted client-side (1.3 #3). |
| Encrypted refresh tokens, server-only collection, rules `if false` | Exactly the existing `driveConnections` pattern. |
| Signed OAuth state, nonce cookie, rate limits | Already built for Drive; reuse the pattern. |
| Incremental authorization, partial-permission handling | Keep. Google's granular consent lets users untick scopes, so this is a real case. |
| Test list (state, isolation, mapping, duplicates, dates, token failures) | Keep as the base of each step's tests. |
| Check Google OAuth verification before production | Keep, with specifics in 1.4. |

### 1.2 What does not fit this codebase (change it)

1. **Docs and Sheets do not need new scopes or a new OAuth connection.**
   The plan routes Docs/Sheets through the Docs API and Sheets API with a new "Workspace" grant. But the existing Drive connection already has `drive.file`, and the Google Picker already hands the app per-file access to whatever the user picks. Drive's `files.export` can turn a picked Google Doc into `.docx` and a picked Google Sheet into `.xlsx` **(verify that `drive.file` allows export of a Picker-selected native file)**.
   The app already has a DOCX reader, an XLSX reader, text extraction for both, summary, quiz, notes, explain and reading progress. Exporting to those formats reuses all of it, preserves sheet names and rows/columns (an `.xlsx` keeps its tabs), and needs **no new scope, no new consent screen change and no verification**. This is the biggest simplification: Reading Docs and Sheets becomes step W1 and ships first. **(v6.1)** Writing back to them (append-only, confirmed) is the new step W1b and does need the Docs and Sheets APIs (see #3).
2. **A single "Workspace connection" for all four products is wrong-sized.**
   Only Calendar and Tasks need a new grant. Docs and Sheets stay on the Drive connection.
3. **The plan says to enable the Docs API and Sheets API.** For *reading*, the export approach does not need them. **(v6.1)** For two-way write-back (W1b) they are needed, so enable them at W1b, not earlier. The Calendar API and Tasks API are enabled at W2. Each API is turned on only when the step that uses it starts (least surface).
4. **"Do not modify arbitrary existing events" is stated but not enforced.**
   Best enforcement: create a dedicated secondary calendar and use the narrowest Calendar scope, `calendar.app.created`, so the app physically cannot see the user's other calendars **(verify the scope name and that it allows `calendars.insert` plus event writes on that calendar)**. Tasks has no narrow scope, so isolate by a dedicated task list named "Study Lamp" and by only ever touching IDs recorded in the mapping.
5. **The plan has no trigger design.** Goals are written straight from the browser with the client SDK (`src/lib/firestore/goals.ts`), and there is no server write path or Cloud Function. There are four call sites: `src/app/goals/page.tsx` (add/update/toggle/remove), `src/app/roadmap/components/RoadmapEditor.tsx` and `src/app/roadmap/page.tsx` (add), and `src/app/admin/users/[userId]/page.tsx` (toggle). So sync has to be client-triggered. **(v6.1)** After a goal mutation the client asks the server for a read-only **preview**, the user confirms, and only then does the server apply it (see 1.5). A manual "Check for changes" does the same for everything, and it is also how changes made in Google are discovered. `addGoal` currently returns `void`, so it must return the new id.
6. **Mapping must not live on the goal document.** `firestore.rules` for `goals` only validates title, notes, priority and completed, so any client could write extra fields. Store mappings in a server-only collection (`users/{uid}/googleSync/{goalId}`). **(v6.1)** The mapping also stores the last-synced values (`base`), which two-way comparison needs.
7. **"Time-zone handling" is simpler than the plan implies.** `Goal.targetDate` is a plain `"YYYY-MM-DD"` string. Calendar all-day events use `start.date` / `end.date` (end is exclusive, so +1 day) with no time zone, and Google Tasks stores only the date part of `due`. So the rule is: never parse goal dates with `new Date(string)`; do string/UTC date arithmetic only. That removes the Dhaka (UTC+6) off-by-one risk.
8. **Idempotency can be partly free for Calendar.** The Calendar API accepts a client-chosen event `id`. Derive it deterministically from `uid + goalId` and a retried insert returns 409 instead of creating a duplicate. Google Tasks has no client-chosen id, so Tasks needs a two-phase write plus a marker in the notes (see W4).
9. **"Update README.md"** — there is no README in the zip. Put the setup guide in `docs/google-workspace.md` and update `docs/deploy.md`, `docs/security.md` and `.env.example`.
10. **The "ready-to-use prompt" asks for phases A–G in one go.** That conflicts with your goal of integrating step by step. v6 replaces it with one prompt per step.

### 1.3 What the plan misses (specific to this repo)

1. **Key rotation:** `scripts/reencrypt.ts` and `docs/security.md` cover `aiConnections`, `systemAiConnections` and `driveConnections`. A new `googleConnections` collection must be added to both, otherwise rotating `AI_CONNECTION_ENCRYPTION_KEY` silently breaks Calendar/Tasks.
2. **Backup:** `src/lib/server/driveBackup.ts` backs up goals. Credentials, sync mappings and Google-native document records need explicit include/exclude rules (F5).
3. **Goal deletion is invisible to the server** (client `deleteDoc`). So the mapping record survives and the remote event/task is orphaned. The plan's "do not auto-delete" policy therefore needs an *orphan report* plus an explicit user-confirmed "Remove from Google" action.
4. **Revocation side effect:** if Calendar/Tasks use the **same OAuth client ID** as Drive, calling Google's revoke endpoint when the user disconnects Calendar may revoke the whole grant, including Drive **(verify)**. Safest design: a separate OAuth client for Workspace (decision D1).
5. **Existing helpers to reuse, not rewrite:** `withAuthedRoute`, `RATE_LIMITS` presets, `DriveTokenCache`, `runWithDriveToken`, `encryptApiKey`, the `remaining` loop pattern from the thumbnail backfill, and the `driveSignedUrl` HMAC pattern.
6. **`refreshAccessToken` is hard-wired to `GOOGLE_DRIVE_CLIENT_ID/SECRET`** (`src/lib/server/googleDrive.ts`), so it needs a small generalisation (client credentials as a parameter) rather than a copy.
7. **Native Google files have no `md5Checksum` and no `size`.** `driveRevisionKey` already falls back to `modifiedTime`, so the text/quiz cache still invalidates correctly. The UI must tolerate `sizeBytes: null`.
8. **CSP:** Calendar/Tasks calls are server-side, so `next.config.js` needs no change. Picker and `docs.google.com` framing are already allowed.
9. **(v6.1) Pulling changes into goals means a server write to `goals`.** Today goals are only written from the browser, and the rules validate title, notes, priority and completed. The server (Admin SDK) bypasses those rules, so the apply step must re-implement the same limits (read the goals rules block; **verify** the title length and the `priority` values). Also check whether the goals page reads with a listener or a one-time fetch **(verify)**, because pulled changes must show up without a manual reload.
10. **(v6.1) Stale previews.** Between the preview and the confirm click, the goal or the Google item can change. The apply step compares against what the user actually saw (fingerprints) and skips anything that changed; see C1.

### 1.4 Google Cloud and verification facts to plan around (all **verify**)

- Calendar `calendar.app.created` and Tasks `tasks` are sensitive-class scopes. Production use by more than ~100 users needs Google OAuth verification. Docs/Sheets via W1 add nothing.
- If the OAuth consent screen is in **"Testing"** status, refresh tokens for any non-basic scope expire after **7 days**. That already affects the Drive connection. Check the publishing status before you test W2.
- In Testing mode only listed test users can connect.
- Keep redirect URIs aligned: local, Vercel preview and production each need an authorised URI for the new callback.
- **(v6.1) Two-way reading, all to verify:** `calendar.app.created` should allow `events.list` on the calendar the app created; an `If-Match` etag header on `events.patch` and `tasks.patch` should make a write fail when the item changed meanwhile; `tasks.list` with `showDeleted=true` should return deleted tasks. The W3/W4 diagnostics test each one. If a header is not honoured, the plan's re-read-and-compare (fingerprints) covers it.
- **(v6.1) Docs and Sheets write-back under `drive.file`:** the Docs API and Sheets API should accept `drive.file` for files the user picked in the Picker **(verify; W1b step 0 tests it and stops if not)**.

### 1.5 Two-way design with confirmation (v6.1, new)

**Principle.** Study Lamp may *read* from Google freely (read-only calls) to find out what changed. It may *write* (to Google, or to your goals) only after you have seen the exact change and pressed Apply.

**Flow, the same for every step (W1b, W3, W4, W5):**

```
1. Check (read-only)  -> server reads goals + Google items, compares with the last-synced snapshot
2. Preview            -> list of proposed changes, each "old -> new", with its direction
3. Confirm            -> you tick what you accept; conflicts and deletions need an extra decision
4. Apply (write)      -> server re-checks every item is unchanged since the preview, then writes only what you accepted
5. Record             -> mapping updated, entry added to the sync history
```

**Server enforcement.** Step 1 returns a signed, 15-minute **plan token** listing a fingerprint for every proposed item. Step 4 refuses anything that is not in the token, was not accepted, or changed since the preview. There is no route that writes without a token. The UI dialog is a convenience; the check that matters is on the server.

**Three-way comparison.** For each field, compare *base* (the value at the last sync), *local* (the goal now) and *remote* (Google now):

| base / local / remote | Result |
|---|---|
| Only local changed | Proposal: push to Google |
| Only remote changed | Proposal: pull into Study Lamp |
| Both changed to the same value | Nothing to write; only the stored base is updated |
| Both changed to different values | **Conflict**: you pick Study Lamp's value, Google's value, or skip. No automatic winner |
| No base yet (first link) and values differ | Conflict (same handling) |

**What syncs in each direction.**

| Field | Calendar | Tasks | Direction |
|---|---|---|---|
| Title | Event title (a leading "✓ " is ignored when comparing) | Task title | Two-way |
| Target date | All-day event date | Due date (date part only) | Two-way |
| Completed | "✓ " prefix on the event title | Task status | Tasks: two-way. Calendar: push-only (the prefix is display; removing it in Google does not re-open the goal) |
| Notes, priority | Event description | Task notes | Push-only (Study Lamp adds lines such as "Priority" and a marker, so they are not read back) |

**Items that exist on one side only.**

- New goal in Study Lamp → proposal "create in Google" (Calendar needs a target date; Tasks does not).
- New event or task you created yourself in the "Study Lamp" calendar/list → proposal "import as goal" (unticked by default; "Ignore" remembers the choice).
- Goal deleted in Study Lamp → the Google item stays and is listed as an orphan; removal only through the explicit W5 action.
- Event or task deleted in Google → proposal with three choices: **Unlink** (default; keep the goal, stop syncing it), **Re-create in Google**, or **Delete the goal here** (extra confirmation).

**Edge cases handled by rule, not by guesswork.** An event that is no longer all-day, or spans several days, is shown as "can't be applied" with the reason. Remote values that fail goal validation (title too long, bad date) are never truncated silently. Study Lamp's own writes never come back as "changes", because the base is updated after every apply.

---

## 2. Decisions for you (answer before the matching step)

| ID | Question | Recommendation | Needed before |
|---|---|---|---|
| D1 | Separate OAuth client for Workspace, or reuse the Drive client? | **Separate client** (same Cloud project). Independent grants and revocation. | W2 |
| D2 | Google Docs/Sheets: live-on-open or frozen snapshot? | **Live on open.** Each open exports the current version; the text cache and quiz cache invalidate on `modifiedTime`. No background refresh. | W1 |
| D3 | Deletion policy **(v6.1)** | Never automatic, in either direction. Only explicit, extra-confirmed actions: "Remove from Google" (W5) and "Delete the goal here" when an item was deleted in Google. | C1 / W3 |
| D4 | Completed goal on Calendar | Keep the event, prefix the title with a check mark. **(v6.1)** Push-only: removing the mark in Google does not re-open the goal. Tasks completion is two-way. | W3 |
| D5 | Where do events go? | Dedicated "Study Lamp" secondary calendar. | W3 |
| D6 | Goal without a target date | Calendar: no event. Tasks: create the task with no due date. | W3 / W4 |
| D7 | Sync trigger **(v6.1)** | After a goal change the client asks for a preview and shows "Review changes"; plus a manual "Check for changes"; on opening Goals, a read-only check at most every 10 minutes. No automatic writes. A daily cron, later and only if you want it, may run the read-only check, never the apply. | W3 |
| D8 | User deletes the event/task in Google **(v6.1)** | Shown as a proposal: Unlink (default) / Re-create in Google / Delete the goal here (extra confirm). Never automatic. | W3 / W4 |
| D9 | Confirmation level **(v6.1, new)** | Every write in both directions needs confirmation. This is the only mode built. A later opt-in "auto-apply Study Lamp → Google" is possible but not part of this roadmap. | C1 |
| D10 | Conflict policy **(v6.1, new)** | Always ask; there is no automatic winner. Default choice is Skip. | C1 |
| D11 | Import new Google events/tasks as goals **(v6.1, new)** | Yes, as proposals, unticked by default, with "Ignore". | W3 / W4 |
| D12 | Docs/Sheets write-back **(v6.1, new)** | Append-only: add a summary, notes or quiz review to the end of a picked Doc, or quiz-result rows to a "Study Lamp log" tab of a picked Sheet. Never edit or delete existing content. | W1b |

If you do not answer, each step uses the recommendation and says so in its report.

---

## 3. Carry-over from v5 (gaps found in the code audit)

| ID | Gap | Where |
|---|---|---|
| A | About 41 `console.error(..., err)` calls log the whole error object, not just `err.name`. | `src/app/api/**`, `src/lib/server/**`, `src/lib/ai/**` |
| B | Only 31 of 48 routes use `withAuthedRoute`. Not migrated: `ai/system-settings`, `ai/quota`, `ai/system-connections*`, `quiz-attempts` (no rate limit at all), `find-user`, `roadmaps/adopt`, `external-playlist`, `youtube-*`, `facebook-video*`. `findDriveOwnedRecord` (R12 step 6) was never created. Video and dashboard pages are still 590 / 647 / 611 lines. | see list |
| C | Missing tests: 10k-row XLSX; `languageInstruction` per language; `resolveAiLanguage("ar") -> null`. | `documentText.test.ts`, new tests |
| D | `firebase-admin.ts` uses a `Proxy` for lazy init (v5 asked for Proxy-free). Works today. | `src/lib/server/firebase-admin.ts` |
| E | Deleting a document does not delete its `driveThumbs/{connectionId}_{fileId}` doc. Videos/playlists probably the same. | `api/documents/[id]/route.ts` |
| F | `next.config.js` `remotePatterns` still allows `hostname: '**'`. | `next.config.js` |
| G | Comment in `next.config.js` mentions Netlify; deployment is Vercel. | `next.config.js` |
| H | Streak is shown but never computed in normal use. | `lib/firestore/users.ts`, dashboard |

---

## 4. Roadmap at a glance

| Step | Title | Depends on |
|---|---|---|
| **H1** | Route and logging hygiene (gaps A, B, C) | none |
| **H2** | Cleanups (gaps D, E, F, G) | none |
| **C1** | Confirmed-change core: preview → confirm → apply, shared **(v6.1, new)** | H1 |
| **W1** | Google Docs and Sheets import, read-only (existing Drive connection, no new scope) | H1 |
| **W1b** | Write back to Docs and Sheets: append-only, confirmed **(v6.1, new)** | W1, C1 |
| **W2** | Workspace connection foundation + `/settings/google` shell | H1 (D1) |
| **W3** | Calendar goal sync: **two-way, every write confirmed** **(v6.1)** | W2, C1 (D2–D11) |
| **W4** | Tasks goal sync: **two-way, every write confirmed** **(v6.1)** | W2, C1 (W3 recommended) |
| **W5** | Reconcile, orphan report, sync history, explicit remote removal, docs **(v6.1)** | W3, W4 |
| **F1** | Streak and activity ledger (old S19, fixes gap H) | none |
| **F2** | Today Plan (old S16) | F1 optional |
| **F3** | Flashcards from quiz mistakes (old S18) | none |
| **F4** | AI study resources (old S17) | W1 optional |
| **F5** | Backup v2 (old S20) | W4 |
| **F6** | Export: Markdown and Anki TSV (old S23) | F4 |
| **F7** | Next.js major upgrade (old S21) | all features done |
| **F8** | PWA (old S22) | F7 |

**Recommended order:** H1 → H2 → C1 → W1 → W1b → W2 → W3 → W4 → W5 → F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8.
**Parallel-safe:** {H1, H2, C1, F1, F3} can run together. The W track and the F track are independent; do W first because you asked for it, then F.

```
H1 -> C1 -> W1b
H1 -> W1 -> W1b
H1 -> W2 -> W3 -> W5
          -> W4 -> W5
C1 -> W3, W4
W4 -> F5
F1 -> F2
F3
F4 -> F6
F1..F6 -> F7 -> F8
```

---

## 5. How to use the prompts

Paste the **Global Rules** once per session, then **one step prompt at a time**. Finish the step's test before the next one. If a path in "Read first" does not exist, the agent must search the repo and say so.

### Global Rules block

```
You are working in an existing Next.js 14 (App Router) project called Study Lamp
(Firebase Auth + Firestore, Tailwind, Radix UI, sonner, driver.js, Tiptap,
EmbedPDF, docx-preview, SheetJS). Source is under src/. Server-only code is in
src/lib/server/ and uses the Firebase ADMIN SDK (adminDb / adminAuth from
src/lib/server/firebase-admin.ts). Client code uses the Firebase CLIENT SDK
(src/lib/firebase.ts). API routes authenticate with
`Authorization: Bearer <Firebase ID token>`; new routes use withAuthedRoute
(src/lib/server/routeHelpers.ts) with a RATE_LIMITS preset
(src/lib/server/rateLimit.ts). Drive stream/thumbnail routes authenticate with
HMAC-signed URLs (src/lib/server/driveSignedUrl.ts). Google APIs are called with
plain fetch (no `googleapis` package), like src/lib/server/googleDrive.ts.

Product decisions that are FINAL:
- No PowerPoint tab, viewer or outline route.
- AI response language is "en" | "bn" only.
- Drive keeps the drive.file scope. Never widen it.
- Google integration is two-way, but never silent: every write or modification to
  Google, and every change to a Study Lamp goal that comes from Google data, is
  previewed and needs explicit user confirmation first. Nothing is deleted on
  either side automatically.

Rules:
1. READ FIRST. Open every file listed under "Read first". Never invent paths or
   APIs; search the repo when something is missing and tell me.
2. Smallest change that satisfies the task. No unrelated refactors, renames or
   reformatting. Keep existing exports working unless the task says otherwise.
3. NEVER use the client Firebase SDK inside src/app/api/** or src/lib/server/**.
4. Never print, log, commit or paste secrets or tokens. Server secrets never get
   a NEXT_PUBLIC_ prefix. Never log response bodies from Google or AI providers;
   log status codes and error names only.
5. Every API route authenticates BEFORE touching data (or verifies a signature
   where the task says so), validates every input (type, length, charset), and
   returns generic error messages.
6. Any new Firestore collection or field needs explicit rules in
   firestore.rules (default is deny). Server-written data: client write false.
7. Never use `new Date("YYYY-MM-DD")` for goal dates. Goal.targetDate is a
   date-only string; use string/UTC arithmetic helpers.
8. No broad catch that turns a failure into success. A failed Google call must
   surface as an explicit status or error, never as empty data or "synced".
9. Reuse existing UI patterns (src/components/ui/*, sonner toasts, Skeleton).
10. New libraries: prefer none. If one is needed, check current version and
    licence, pin it, and state both.
11. Add unit tests for pure logic. `npm test` runs scripts/runTests.mjs (every
    *.test.ts under src/); copy the pattern of an existing test.
12. Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Report honestly. If you
    cannot run something, say so; do not claim it passed.
13. Two-way sync is allowed; silent writes are not. Any write to Google (create,
    update, delete, append) and any change to a Study Lamp goal that comes from
    Google data MUST go through preview -> confirm -> apply (C1: signed plan token,
    per-item fingerprint). No route, hook, effect, cron or fire-and-forget call may
    write without a valid, user-confirmed token. Read-only checks need no
    confirmation.
14. Never delete on either side automatically. A delete is its own item and needs
    its own extra confirmation.
15. Preview/plan endpoints perform ZERO writes (to Google and to goals). Add a test
    for each integration proving the write functions are never called during a
    preview.
16. End with: files changed / manual test steps / anything you were unsure of.
```

---

# PART A — Hardening (v5 carry-over)

## STEP H1 — Route and logging hygiene

**Fixes:** gaps A, B, C. **Depends on:** none.

**Prompt:**
```
TASK H1 — consistent route helper use, safe logging, missing tests.
Read first: src/lib/server/routeHelpers.ts (+ test), src/lib/server/rateLimit.ts,
every route.ts under src/app/api (grep -L withAuthedRoute), src/lib/ai/errors.ts,
src/lib/server/requireAuth.ts, src/app/api/quiz-attempts/route.ts,
src/app/api/find-user/route.ts, src/app/api/ai/quota/route.ts,
src/lib/server/driveOwnership.ts, src/lib/server/driveThumbnails.ts.

1. Safe logging (gap A): add src/lib/server/logError.ts exporting
   logServerError(label: string, err: unknown): logs the label plus err.name
   (and a numeric status when err has one, e.g. DriveApiError) and NOTHING else —
   no message, stack or response body. Replace every raw
   console.error("...", err) in src/app/api/**, src/lib/server/** and src/lib/ai/**
   (about 41; list them). Keep the AiServiceError code logging in
   roadmap/clarify. Unit-test logError with a fake console.
2. Route migration (gap B): move these to withAuthedRoute without changing any
   response shape or status: ai/system-settings, ai/quota, ai/system-connections,
   ai/system-connections/[id], ai/system-connections/[id]/test, quiz-attempts,
   find-user (keep its 20/min limit), roadmaps/adopt, external-playlist,
   youtube-duration, youtube-playlist, youtube-playlist-search, facebook-video,
   facebook-video/thumbnail. If a route needs an admin check, add an `admin: true`
   option to withAuthedRoute rather than repeating the check inline. Do NOT touch
   drive/auth/callback, drive/stream and drive/thumbnail (they authenticate by
   redirect or signed URL).
3. quiz-attempts currently has no rate limit: apply the default preset.
4. Duplicate owner lookup (R12 step 6): check whether driveOwnership.ts and
   driveThumbnails.ts still both query for the owning record. If yes, extract
   findDriveOwnedRecord(uid, fileId, connectionId) and use it in both; if the
   duplication is already gone, say so and skip.
5. Missing tests (gap C): a generated 10,000-row workbook in documentText.test.ts
   (result capped at 5,000 rows, "Sheet: name" header kept); languageInstruction
   for "en" and "bn"; resolveAiLanguage(undefined -> saved default, "bn" -> "bn",
   "ar" -> null).
Do not reformat untouched files.
```
**Test:** `grep -rn "console.error" src/app/api src/lib/server src/lib/ai` shows only `logServerError`-style calls; `routes without withAuthedRoute` is down to the three signed/redirect routes; `npm test` green.

---

## STEP H2 — Cleanups

**Fixes:** gaps D, E, F, G. **Depends on:** none.

**Prompt:**
```
TASK H2 — small cleanups. One commit per numbered item.
Read first: next.config.js, src/components/video/VideoThumbnail.tsx (skipOptimizer),
src/lib/video-platforms/providers.ts, src/app/share/[type]/[token]/page.tsx,
src/app/api/documents/[id]/route.ts, src/lib/server/driveThumbnails.ts,
src/app/api/drive/thumbnails/backfill/route.ts, src/lib/server/driveOwnership.ts,
src/lib/server/firebase-admin.ts.

1. Image hosts (F): remove `{ hostname: '**' }` from images.remotePatterns. Grep every
   place a remote thumbnail URL can come from (YouTube, Facebook, Vimeo, any other
   provider in providers.ts, the share page) and keep exactly those hosts.
   Drive thumbnails are same-origin and unoptimised, so they are unaffected.
   List the hosts you kept and anything that now falls back to the broken-image UI.
2. Orphaned thumbnails (E): videos and playlists are deleted from the browser, so
   no server hook exists. Add a prune pass to POST /api/drive/thumbnails/backfill
   (or a sibling route): list up to 50 docs in users/{uid}/driveThumbs, check with
   findOwnedDriveFiles whether any video or document still references
   (connectionId, fileId), and delete the unreferenced ones. Return {pruned,
   remaining}. A thumbnail shared by two records must NOT be deleted while one
   still uses it. Also delete the thumbnail inline in DELETE /api/documents/[id]
   when no other record uses it. Unit-test the pure "which ids are unreferenced"
   function.
3. Comment fix (G): replace the Netlify comment in next.config.js with the Vercel
   reality.
4. Admin Proxy (D): do not rewrite. Grep for any place adminDb/adminAuth is passed
   to a library or compared with instanceof. If none, add a short comment in
   firebase-admin.ts stating the Proxy is intentional and why, and close this item.
5. Optional, only if time remains: extract shared quiz/summary hooks from
   src/app/video/[videoId]/page.tsx (590 lines) and
   src/app/playlists/[playlistId]/[videoId]/page.tsx (647 lines). No behaviour change.
```
**Test:** all thumbnail sources still render; delete a PDF and then run the backfill → its `driveThumbs` doc is gone, another record's thumbnail for the same file survives.

---

# PART B — Google Workspace, one step at a time

Each step below ships and is tested on its own. **C1** is pure code (no Google calls) and gives every later write step its confirmation screen and server-side check, so build it first. W1 needs no Google Cloud changes. **W1b** needs the Docs and Sheets APIs enabled. W2 needs the one-time OAuth setup (Calendar, Tasks). W3 and W4 are independent of each other.

## STEP C1 — Confirmed-change core (shared by W1b, W3, W4, W5) **(v6.1, new)**

**Depends on:** H1. **Google Cloud changes:** none. **New env vars:** none (the plan token reuses `DRIVE_URL_SIGNING_SECRET` with its own domain prefix; use a new variable instead if you prefer separation). Nothing in this step talks to Google.

**Why a separate step:** two-way sync plus "confirm every write" is the same machinery for Docs, Sheets, Calendar and Tasks. Building it once, with tests, means no later step can add a write path that skips confirmation.

**Prompt:**
```
TASK C1 — build the shared "preview -> confirm -> apply" machinery. Pure logic, one
signing helper, one UI component, rules for server-only collections. No Google calls.
Read first: src/lib/server/driveSignedUrl.ts (+ test; HMAC and domain-separation pattern),
src/lib/server/routeHelpers.ts, src/lib/server/rateLimit.ts, src/components/ui/dialog*
(and alert-dialog if present), src/types/index.ts (Goal), firestore.rules,
src/lib/isoDate.ts (create it if it does not exist yet).

1. Date helpers in src/lib/isoDate.ts: isValidIsoDate (regex plus a Date.UTC round trip,
   so "2026-02-30" is invalid), addDaysToIsoDate(date, n) with Date.UTC only, and
   isoDatePart(rfc3339) (first 10 characters, validated). NEVER call new Date("YYYY-MM-DD")
   on a goal date.
2. src/lib/sync/threeWay.ts (pure):
   decideField({base, local, remote}) -> "unchanged" | "push" | "pull" | "converged" | "conflict"
   - local === remote: "unchanged" if equal to base, else "converged" (bookkeeping only)
   - local !== base and remote === base: "push"
   - remote !== base and local === base: "pull"
   - both differ from base and from each other: "conflict"
   - base unknown (first link) and local !== remote: "conflict" (never pick a winner)
   Values are string | boolean | null.
3. src/lib/sync/plan.ts types and helpers:
   PlanItem {itemId, kind, target, goalId?, remoteId?, title, fields:[{name, before, after,
   direction}], risk: "normal"|"destructive", fingerprint}.
   kinds: push_create, push_update, pull_update, pull_create, conflict, remote_deleted,
   attention (read-only, cannot be applied), append (for W1b).
   itemId = stable hash of (target, goalId or remoteId, kind).
   fingerprint = sha256 of kind + ids + fields + a fingerprint of the LOCAL value + the
   REMOTE version (etag or revisionId). If the goal or the Google item changes after the
   preview, the fingerprint changes.
4. src/lib/server/planToken.ts: signPlanToken({uid, scope: "calendar"|"tasks"|"docs_append"|
   "sheets_append"|"remove", items:[{itemId, fingerprint}], exp}) and verifyPlanToken.
   HMAC-SHA256 with DRIVE_URL_SIGNING_SECRET, input prefixed "sync-plan.v1|" (domain
   separation), TTL 15 minutes, timingSafeEqual. verify returns the item list or a typed
   error: expired | tampered | wrong_user | wrong_scope.
5. src/lib/server/applyGate.ts (pure core, writers injected):
   applyConfirmed({token, accepted, resolutions, confirmedDestructive, freshPlan, writers}).
   An item is applied ONLY if ALL of these hold:
   a) its itemId is in the verified token;
   b) it is in `accepted`;
   c) the freshly recomputed plan still contains an item with the same itemId AND the same
      fingerprint (otherwise status "stale", nothing written);
   d) a conflict has an explicit resolution ("use_study_lamp" | "use_google" | "skip");
   e) a destructive item is also listed in confirmedDestructive.
   Returns per-item {itemId, status: "applied"|"stale"|"skipped"|"failed", code?}.
   A failed write is "failed", never "applied" (Global Rule 8).
6. Sync log: users/{uid}/googleSyncLog/{autoId} {at, scope, direction, itemKind, goalId?,
   titleSnapshot, fields:[{name, before, after}] (goal fields only: title, targetDate,
   completed; never tokens, never document text), result}. Helper logSyncApplied(); prune
   to the newest 200 per user when over 220. Also users/{uid}/googleIgnored/{target_remoteId}
   {at} for "Ignore". firestore.rules: `allow read, write: if false` for googleSyncLog and
   googleIgnored.
7. Rate limits: RATE_LIMITS.googleSync = {limit: 30} (preview/plan reads) and
   RATE_LIMITS.googleApply = {limit: 20}.
8. UI src/components/google/ConfirmChangesDialog.tsx (generic; every later step uses it).
   Props: title, items: PlanItem[], onConfirm({accepted, resolutions, confirmedDestructive}), busy.
   - Groups: "Study Lamp -> Google", "Google -> Study Lamp", "Conflicts", "Deleted in Google",
     "Can't be applied" (attention items: reason only, no checkbox).
   - Each item: checkbox, title, field rows "old value -> new value", the direction written in
     words (not colour only), and an "Open in Google" link when a validated URL exists.
   - Defaults: normal push/pull ticked; pull_create NOT ticked; conflicts NOT ticked (radio:
     "Keep Study Lamp's", "Keep Google's", "Skip", default Skip); destructive items NOT ticked
     and need an extra checkbox "I understand this deletes <what>".
   - Confirm button states counts and direction, e.g. "Apply 3 changes to Google and 2 to Study
     Lamp"; disabled when nothing is selected. Default focus on Cancel. Esc closes with nothing
     written. Fully keyboard accessible.
   - Footer text: "Nothing changes until you press Apply."
9. Tests: decideField truth table (including no base); fingerprint stable for identical input
   and different when any field, local value or remote version changes; token (valid, expired,
   tampered item list, wrong user, wrong scope, a Drive signed-URL token rejected by this
   verifier and the reverse); applyConfirmed (not accepted -> untouched, stale -> skipped,
   conflict without resolution -> skipped, destructive without the second confirm -> skipped,
   failing writer -> "failed", writers never called for ids outside the token); log pruning;
   isoDate (month end, Dec 31 -> Jan 1, leap day, invalid dates, RFC3339 first 10 characters).
```
**Test:** unit tests pass. Render the dialog once with a fake plan on a temporary dev-only page (remove it afterwards): Cancel has focus, Esc closes, nothing is sent over the network until Apply, conflicts and deletions start unticked, and the button text matches the counts.

---

## STEP W1 — Google Docs and Google Sheets as Study Materials

**Depends on:** H1. **Decision:** D2 (live on open). **New scopes:** none. **New env vars:** none. **Google APIs to enable:** none beyond the Drive API you already use.

**How it works:** the user picks a Google Doc or Sheet in the existing Drive Picker. The server exports it through Drive (`files.export`) to `.docx` / `.xlsx` and feeds the bytes to the readers and text extraction you already built. The record is stored as a normal Study Materials document with `fileType: "docx" | "xlsx"` and a `googleNative: true` flag, so tabs, notes, summary, quiz, explain and reading progress all work unchanged.

**Prompt:**
```
TASK W1 — import Google Docs and Google Sheets through the existing Drive
connection (drive.file). No new OAuth scope, no new env var, no Docs/Sheets API.
Read first: src/lib/driveMime.ts, src/components/drive/DrivePickerButton.tsx,
src/components/drive/DriveImportPanel.tsx, src/app/api/drive/import/files/route.ts,
src/lib/server/driveImportUtils.ts (+ test; importableDocumentType,
partitionDriveFiles), src/lib/server/googleDrive.ts (fetchFileContent,
getFileMetadata, FILE_FIELDS, SUPPORTED_DOCUMENT_MIME_TYPES),
src/lib/server/driveSignedUrl.ts (+ test), src/app/api/drive/sign/route.ts,
src/app/api/drive/stream/[fileId]/route.ts, src/lib/driveClient.ts
(getSignedDriveUrls), src/lib/server/documentContent.ts,
src/lib/server/documentContentUtils.ts, src/lib/server/documentText.ts,
src/lib/server/driveImport.ts (documents bulk function),
src/components/documents/DocumentReaderSwitch.tsx, src/app/study-materials/page.tsx,
src/lib/documentFilters.ts, src/types/index.ts (PersonalDocument),
firestore.rules (validPersonalDocumentFields, sameDriveReferences).

0. DIAGNOSTIC FIRST (temporary, remove afterwards). Ask me to pick ONE Google Doc and
   ONE Google Sheet with the existing Picker (add the two native MIME types to a
   Picker view). Server-side, call Drive files.export for the Doc ->
   application/vnd.openxmlformats-officedocument.wordprocessingml.document and the
   Sheet -> application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
   Report status codes only. If either returns 403/404 under drive.file, STOP and
   report; do not widen the scope. (Fallback would be the Docs/Sheets read scopes
   through the W2 connection; that is my decision.)
1. driveMime.ts: add kinds "gdoc" and "gsheet" with MIME
   application/vnd.google-apps.document / .spreadsheet, plus a pure
   nativeExportMime(mimeType) -> docx/xlsx MIME or null. Google Slides and every
   other google-apps type stay unsupported (no PowerPoint product decision).
2. driveImportUtils.ts: importableDocumentType maps native Doc -> "docx" and native
   Sheet -> "xlsx"; partitionDriveFiles marks each document with googleNative.
3. Types and rules: add googleNative?: boolean to PersonalDocument; add
   optionalBool(data, 'googleNative') to validPersonalDocumentFields and make it
   immutable on update next to sameDriveReferences(). Native files have no md5 and
   no size: store md5Checksum null and sizeBytes null, mimeType = the native MIME.
4. googleDrive.ts: exportFile(accessToken, fileId, exportMime) using
   /files/{id}/export?mimeType=... with assertDriveId and an allowlist of exactly
   the two export MIME types; no Range header. Map Google's "export too large"
   (10 MB limit) 403 to a clear DriveApiError. Add ONE function
   fetchDocumentBytes(accessToken, {driveFileId, mimeType, googleNative}) that
   routes to export or media download; use it in the stream route and in
   documentContent.ts so nothing else cares about the difference.
5. Signed URLs: add purposes "export" (TTL 30 min) and "export_download" (TTL
   10 min) to driveSignedUrl.ts. /api/drive/sign accepts them (same ownership
   check). The stream route, for export purposes only: calls getFileMetadata,
   requires a native Doc or Sheet, derives the export MIME SERVER-SIDE (never from a
   query parameter), returns the bytes with the right Content-Type, no Range, and
   Content-Disposition: attachment only for export_download. Keep nosniff and
   Referrer-Policy. A non-native file with an export purpose -> 400.
6. Import: /api/drive/import/files already partitions documents; pass googleNative
   through to the documents bulk write (and modifiedTime from the metadata).
   Duplicates are still detected by driveFileId.
7. Picker kinds: Word tab = docx + gdoc, Excel tab = xlsx + gsheet, All = everything
   supported. DriveImportPanel keeps allowFolders=false for Study Materials.
8. Readers: DocumentReaderSwitch requests purpose "export" / "export_download" when
   googleNative, shows a small "Google Doc" / "Google Sheet" badge, and an
   "Open in Google" link built from the validated file id
   (https://docs.google.com/document/d/ID/edit or /spreadsheets/d/ID/edit).
   Show the stored last-known modifiedTime as "Last changed in Google". Lists and
   cards show a Google badge and tolerate sizeBytes null ("—").
9. Text cache: extractPersonalDocumentText must work with md5 null; confirm
   driveRevisionKey falls back to modifiedTime and add a test proving a changed
   modifiedTime refreshes the cache and an unchanged one does not.
10. Errors the user must see (never an empty reader shown as success): file trashed
    or no longer accessible, permission revoked, export too large, connection
    invalid (link to /settings/drive).
11. Tests: partition with native Doc/Sheet/Slides; nativeExportMime allowlist;
    signed-URL purposes (wrong purpose, tampered, expired); fetchDocumentBytes
    routing with an injected fetch; revision key with null md5.
Do not enable or call the Docs API or Sheets API in this step. This step is read-only: never write to the Google file (writing back is W1b, behind confirmation).
```
**Test:** pick a Google Doc and a Sheet → they appear in the Word and Excel tabs with a Google badge; both open in the existing readers (the sheet keeps its tab names); edit the Doc in Google, reopen it → new content shows and the summary/quiz regenerate only after the change; Google Slides is not offered or is skipped as unsupported; revoke Drive access → a clear "reconnect" message.

---

## STEP W1b — Write back to Google Docs and Sheets (append-only, confirmed) **(v6.1, new)**

**Depends on:** W1, C1. **Decision:** D12. **New scopes:** none expected **(verify in step 0)**. **New env vars:** none. **Cloud setup (once):** enable the **Google Docs API** and the **Google Sheets API** on the same project. Same Drive connection as W1; no new OAuth client.

**What it does.** After W1, Study Lamp can *read* a Doc or Sheet you picked (export). W1b adds the other direction in a deliberately small form:

- **Docs:** "Add to Google Doc" appends a section at the END of the Doc: the AI summary, your notes, or a quiz review (the questions you got wrong).
- **Sheets:** "Add to Google Sheet" appends quiz-result rows to a tab called "Study Lamp log" (created on confirm if it is missing).
- It never edits, replaces or deletes existing content. Every append shows the exact text or rows first and needs Apply.

**Prompt:**
```
TASK W1b — confirmed, append-only write-back to Google Docs and Sheets that the user
imported in W1.
Read first: C1 files (plan.ts, planToken.ts, applyGate.ts, ConfirmChangesDialog, sync log),
W1 files (googleDrive.ts fetchDocumentBytes, documentContent.ts, documentText.ts,
DocumentReaderSwitch.tsx, PersonalDocument type), src/lib/server/driveRequest.ts and
driveTokenCache.ts (runWithDriveToken), src/lib/server/driveOwnership.ts,
src/app/study-materials/[documentId]/page.tsx and the study panel (summary, notes, quiz),
the quiz attempts storage (grep quiz-attempts; src/app/api/quiz-attempts/route.ts),
src/lib/server/rateLimit.ts, firestore.rules.

0. DIAGNOSTIC FIRST (temporary; status codes only). With ONE Google Doc and ONE Sheet imported
   via W1, call documents.get (fields=revisionId,body.content.endIndex) and spreadsheets.get
   (fields=sheets.properties.title) using the existing Drive connection token (drive.file).
   Report whether they succeed. If either returns 403/404, STOP and report; do not widen the
   scope. (The fallback would be Docs/Sheets scopes through the W2 connection; that is my
   decision.) Do any write test only on a throwaway Doc/Sheet that I name.
1. Fetch clients (no googleapis package, injected token):
   - googleDocs.ts: getDocumentEnd(docId) -> {revisionId, endIndex}; appendToDocument(docId,
     {revisionId, text, heading}) = ONE batchUpdate with writeControl.requiredRevisionId and ONLY
     these request types: insertText (at endIndex - 1) and updateParagraphStyle (heading). A
     revision mismatch maps to "changed_since_preview".
   - googleSheets.ts: listTabTitles(id); createTab(id, "Study Lamp log") via batchUpdate addSheet;
     appendRows(id, tab, rows) via values.append with valueInputOption=RAW and
     insertDataOption=INSERT_ROWS (RAW keeps a value like "=1+1" as literal text).
   - A pure allowlist function that throws if a request body contains any other request type
     (deleteContentRange, replaceAllText, updateCells, clear, and so on). Unit-test it.
2. Content is built SERVER-SIDE from stored Study Lamp data. It is never accepted as free text
   from the client, so a plan token cannot be used to write arbitrary content.
   - Doc: content in {"summary","notes","quiz_review"}; heading "Study Lamp — <ISO date>";
     text capped at 20,000 characters (the preview says so if the cap is hit). Notes (Tiptap)
     are converted to plain text by a pure function.
   - Sheet: content "quiz_results" -> rows [date, material title, quiz title, score, total,
     percent] for attempts not yet exported (track exported attempt ids server-only), max 200
     rows per apply. Tab name constant "Study Lamp log"; the header row is written only when the
     tab is created.
3. Routes (withAuthedRoute, nodejs, force-dynamic). Ownership comes from the stored
   personal-document record: driveFileId, connectionId and mimeType are taken from that record,
   NEVER from the request, and the record must have googleNative true and the matching type
   (else 400).
   - POST /api/drive/docs/append/preview {documentId, content} -> READ-ONLY. Returns {planToken,
     preview:{documentTitle, openUrl, heading, text, truncated}}. The fingerprint includes the
     revisionId and a hash of the text.
   - POST /api/drive/docs/append/apply {planToken, accepted:[itemId]} -> re-reads the revisionId,
     rebuilds the text, compares fingerprints (mismatch -> "stale", nothing written), appends,
     writes a sync log entry.
   - POST /api/drive/sheets/append/preview {documentId, content:"quiz_results"} -> {planToken,
     preview:{tab, willCreateTab, rows, rowCount}}.
   - POST /api/drive/sheets/append/apply {planToken, accepted}.
   Presets: googleSync for previews, googleApply for applies. Never return Google error bodies.
4. Avoid summarising our own additions. After an append, the file's modifiedTime changes, so the
   W1 live-on-open cache refreshes. Extractors must therefore (a) skip the sheet tab named
   "Study Lamp log", and (b) for Docs, ignore text from the first paragraph that starts with
   "Study Lamp — " to the end, for AI text extraction only (the reader still shows it).
   Unit-test both. Tell the user in the UI: "Sections added by Study Lamp are not used for
   summaries or quizzes."
5. UI (document page, only for googleNative documents): a menu "Add to Google Doc…" (Summary /
   Notes / Quiz review) or "Add to Google Sheet…" (Quiz results). It opens ConfirmChangesDialog
   in preview mode: the target file with an "Open in Google" link, the exact text or rows in a
   scrollable read-only box, the line "This adds to the end of your file. It does not change or
   delete anything already there. You can undo it with Google's version history.", and an
   Apply button "Add to Google Doc" / "Add to Google Sheet". Default focus Cancel. After success,
   a toast with "Open in Google". Errors are always visible: permission not granted for this file
   (ask to pick it again), file trashed, changed since preview (offer "Preview again"),
   connection invalid (link to /settings/drive).
6. Tests: allowlist rejects every other request type; Sheets uses RAW and INSERT_ROWS; preview
   performs no write (fake client records calls); stale revision -> nothing written; unaccepted
   item -> nothing written; the client cannot supply text; a non-native or wrong-type document
   -> 400; extraction skips the Study Lamp tab and section; exported attempts are not exported
   twice; row cap; plain-text conversion.
Never delete, replace or clear anything in a Google file.
```
**Test (use a throwaway Doc and Sheet):** open an imported Google Doc → "Add to Google Doc… → Summary" shows the exact text and nothing is written until Apply; press Apply → the section appears at the end of the Doc and the original content is untouched; edit the Doc in Google between preview and Apply → Study Lamp says "changed since preview" and writes nothing; for the Sheet, quiz rows land in a new "Study Lamp log" tab and other tabs are unchanged; run it twice → no duplicate rows; the next summary ignores the appended section.

---

## STEP W2 — Workspace connection foundation (for Calendar and Tasks)

**Depends on:** H1. **Decision:** D1. **Cloud setup:** yes (below). Nothing syncs yet; this step only connects accounts safely.

**You do first (Google Cloud Console):**
1. In the existing project, create a **second OAuth client** (type Web application) named "Study Lamp Workspace". Add authorised redirect URIs `http://localhost:3000/api/google/auth/callback`, your Vercel preview URL(s) and your production URL, each with `/api/google/auth/callback`.
2. Enable the **Google Calendar API** and the **Google Tasks API**.
3. On the OAuth consent screen add the scopes the agent prints (Calendar `calendar.app.created`, Tasks `tasks`) and add yourself as a test user. Note the publishing status (see 1.4: "Testing" means 7-day refresh tokens).
4. Add to the environment: `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET` (generate with `openssl rand -base64 32`).

**Prompt:**
```
TASK W2 — Google Workspace account connection (Calendar + Tasks scopes) with
encrypted server-only token storage, status and revoke. No sync yet.
Read first: src/lib/server/googleDrive.ts (DRIVE_SCOPE, buildAuthUrl,
exchangeCodeForTokens, refreshAccessToken, revokeToken, getGoogleAccountEmail,
signDriveState/verifyDriveState), src/lib/server/driveConnections.ts,
src/lib/server/driveTokenCache.ts, src/lib/server/driveRequest.ts,
src/app/api/drive/auth/state/route.ts, src/app/api/drive/auth/callback/route.ts,
src/app/api/drive/connections/route.ts and [id]/route.ts, src/lib/driveClient.ts
(OAuth start and connection list functions), src/app/settings/drive/page.tsx,
src/app/settings/page.tsx, src/components/layout/Sidebar.tsx (Settings group),
src/lib/server/aiEncryption.ts, scripts/reencrypt.ts, docs/security.md,
firestore.rules (driveConnections block), src/lib/server/rateLimit.ts,
src/types/index.ts (DriveConnection, DriveConnectionSummary).

1. Env + config: GOOGLE_WORKSPACE_CLIENT_ID / _CLIENT_SECRET /
   _OAUTH_STATE_SECRET; isWorkspaceConfigured(); add them to .env.example
   (server-only). If I choose to reuse the Drive client instead (decision D1),
   say so and skip the Google-side revoke on disconnect (see step 7).
2. src/lib/server/googleOAuth.ts: generic buildAuthUrl / exchangeCode /
   refreshToken / revoke that take {clientId, clientSecret, redirectPath}.
   Drive's existing functions keep their signatures and delegate to it. Drive
   behaviour and tests must not change.
3. src/lib/googleScopes.ts (shared by client and server, pure):
   calendar -> https://www.googleapis.com/auth/calendar.app.created,
   tasks -> https://www.googleapis.com/auth/tasks,
   always + https://www.googleapis.com/auth/userinfo.email.
   Helpers: scopesForFeatures(features), featuresFromGrantedScopes(scopeString),
   missingFeatures(requested, scopeString). If calendar.app.created cannot be used
   (console error or API rejects calendar creation), STOP and ask me before
   switching to a broader scope.
4. State: signWorkspaceState(uid, nonce, features) / verifyWorkspaceState with the
   HMAC input prefixed "workspace.v1|" (domain separation) and the feature list
   inside the signed payload. Cookie sl_google_nonce: httpOnly, Secure,
   SameSite=Lax, Path=/api/google/auth, Max-Age=600, cleared on every callback exit.
5. Routes (runtime nodejs, dynamic force-dynamic, withAuthedRoute except the callback):
   - POST /api/google/auth/state {features: ("calendar"|"tasks")[]} (1-2 unique
     values, anything else -> 400, preset authSensitive). Returns {url} built with
     include_granted_scopes=true, access_type=offline, prompt=consent.
   - GET /api/google/auth/callback: verify state + cookie, rate-limit, exchange
     the code, read the GRANTED scope string from the token response, compute
     grantedFeatures, upsert the connection by googleEmail MERGING the previously
     granted scopes, then redirect to /settings/google with connected=<email>
     and, if the user unticked something, missing=<feature>. Denied, expired,
     invalid state, no refresh token and too-many-attempts each get a distinct,
     plain-language message.
   - GET /api/google/connections: safe summaries only.
   - DELETE /api/google/connections/[id]: delete the stored token and revoke it
     at Google (best effort, failure does not block deletion). Remote events and
     tasks are never touched.
6. Storage: users/{uid}/googleConnections/{id} = {googleEmail,
   encryptedRefreshToken (encryptApiKey), grantedScopes: string[], status:
   "active"|"invalid", calendar: {enabled: false}, tasks: {enabled: false},
   createdAt, updatedAt, lastUsedAt}. firestore.rules: `allow read, write: if false`
   for googleConnections AND for googleSync (mapping docs, added by W3). C1 already covers googleSyncLog and googleIgnored. The summary
   returned to the browser must never contain tokens or ciphertext (test this by
   asserting the exact key set).
7. Tokens: withGoogleAccessToken(uid, connectionId, requiredFeature, operation)
   reusing DriveTokenCache and runWithDriveToken. It refuses a connection whose
   grantedScopes lack the required feature (GoogleConnectionError "scope_missing"),
   marks the connection invalid on invalid_grant, retries once after a Google 401,
   and writes lastUsedAt at most every 15 minutes. Error codes: not_found,
   invalid, network, scope_missing.
8. Key rotation: add googleConnections to scripts/reencrypt.ts (dry run counts it)
   and to docs/security.md.
9. UI: src/app/settings/google/page.tsx. A plain-language explanation of what
   Study Lamp reads and writes (it reads to check for changes; it writes only after you confirm); a connection list with email, status badge
   (Active / Needs reconnect) and the granted permissions in words; buttons
   "Allow Calendar access" and "Allow Tasks access" (incremental, one feature
   each), Reconnect, and Disconnect behind a confirm dialog that says: "Study
   Lamp will stop syncing. Anything already created in Google stays there." Toasts
   for connected / error / missing like the Drive page. Add a "Google Workspace"
   link under "Google Drive" in the Sidebar Settings group and a card on
   /settings.
10. Tests: scopesForFeatures / featuresFromGrantedScopes / missingFeatures; state
    sign/verify (valid, expired, tampered, wrong nonce, tampered features, a DRIVE
    state rejected by the workspace verifier and the reverse); summary key set; token
    path with an injected refresh function; partial-grant parsing.
11. Docs: docs/google-workspace.md (Cloud steps above, redirect URIs, test users,
    publishing status and the 7-day Testing-mode note), docs/deploy.md env list.
```
**Test:** connect with Calendar only → the page shows Calendar allowed and Tasks not allowed; click "Allow Tasks access" → both allowed; untick a permission in Google's consent screen → Study Lamp reports which one is missing; disconnect → the token doc is gone and Drive playback still works; the Firestore console shows only ciphertext; a client-SDK read of `googleConnections` is denied; `reencrypt` dry run lists the new collection.

---

## STEP W3 — Calendar goal sync (opt-in, two-way, every write confirmed) **(v6.1)**

**Depends on:** W2, C1. **Decisions:** D3–D11. **Scope used:** Calendar only (`calendar.app.created`). Tasks stays untouched in this step.

**Behaviour:** off by default. Enabling it (after a confirm) creates a secondary calendar named "Study Lamp goals". From then on:

- **Study Lamp → Google:** a new or changed goal with a target date becomes a *proposed* event create or update.
- **Google → Study Lamp:** if you move or rename an event in that calendar, it becomes a *proposed* change to the goal's date or title.
- Nothing is written to either side until you review the changes and press Apply. It never reads or edits your other calendars and never deletes anything on its own.

**Prompt:**
```
TASK W3 — two-way sync between goals and a dedicated Google Calendar, with a preview and an
explicit confirmation before EVERY write (both directions).
Read first: the C1 files (threeWay.ts, plan.ts, planToken.ts, applyGate.ts, sync log,
ConfirmChangesDialog, isoDate.ts), src/lib/firestore/goals.ts (addGoal returns void),
src/app/goals/page.tsx (handlers near L240-275), src/app/roadmap/components/RoadmapEditor.tsx
(addGoal near L152), src/app/roadmap/page.tsx (addGoal near L219), src/lib/goalUtils.ts,
src/types/index.ts (Goal), firestore.rules (goals block), the W2 files (googleScopes.ts,
googleOAuth.ts, googleConnections, withGoogleAccessToken, src/app/settings/google/page.tsx),
src/lib/server/routeHelpers.ts, src/app/api/drive/thumbnails/backfill/route.ts (the
`remaining` loop pattern).

0. DIAGNOSTIC FIRST (temporary, remove afterwards; status codes only). With a test account and
   the W2 connection: calendars.insert, events.insert (all-day), events.list on that calendar
   (showDeleted=true), events.patch with an If-Match etag header. If any call returns 403/404
   under calendar.app.created, STOP and report; do not switch to a broader scope without asking
   me. Also report whether a stale If-Match is rejected (412).
1. Pure mapping src/lib/server/calendarGoalMapping.ts:
   - buildCalendarEvent(goal, {appUrl}) -> {summary, description, start:{date}, end:{date},
     extendedProperties:{private:{studylampGoalId}}}. end = start + 1 day (an all-day end is
     EXCLUSIVE). summary = goal title with a "✓ " prefix when completed (D4). description = notes
     + "Priority: ..." + a link to {appUrl}/goals. No time of day.
   - calendarEventIdForGoal(uid, goalId): lowercase base32hex (a-v, 0-9) of the first 20 bytes
     of sha256(`studylamp:${uid}:${goalId}`). Deterministic, so a retried insert hits a 409
     instead of creating a duplicate.
   - eventToGoalFields(event) -> {title, targetDate} | {attention: reason}. Strips ONE leading
     "✓ " from the title. Accepts only an all-day event whose end is exactly start + 1 day. A
     timed, multi-day or cancelled event returns {attention} (never guess a date). Validates with
     isValidIsoDate and the goal title limit. Never new Date() on a date-only string.
   - calendarFieldsHash(fields) to skip unchanged pushes.
2. src/lib/server/googleCalendar.ts: thin fetch client, injected token: createCalendar,
   insertEvent (with id), patchEvent (optional ifMatch etag), getEvent, listEvents(calendarId,
   pageToken, showDeleted=true, maxResults=250, follow pages up to 10). Error classification:
   401 -> auth; 403 insufficient scope -> scope_missing; 403 rate limit and 429 -> retryable
   (Retry-After, exponential backoff with jitter, max 3 tries); 404/410 -> remote_missing;
   409 -> exists; 412 -> changed_remotely. Never log response bodies.
3. Mapping doc users/{uid}/googleSync/{goalId}: {titleSnapshot (<=200), calendar:{connectionId,
   calendarId, eventId, remoteEtag, base:{title, targetDate}, hash, status: "synced"|"failed"|
   "remote_deleted"|"no_date"|"unlinked", lastSyncAt, lastErrorCode}}. Server-only (rules from
   W2). `base` holds the values both sides had at the last sync. Never store mapping data on the
   goal document.
4. Planner src/lib/server/goalSyncPlan.ts (READ-ONLY). planCalendarSync(uid, {goalIds?}) reads
   goals (Admin SDK), the mappings and the remote events, then uses threeWay.ts to emit C1
   PlanItems:
   - goal with a date and no mapping -> push_create
   - mapped, only the goal changed -> push_update; only the event changed -> pull_update (fields
     title, targetDate); both changed differently -> conflict; same new value on both sides ->
     converged (update the base silently; nothing is written to Google or to the goal)
   - goal without a valid date -> nothing remote; mapping.status "no_date" (D6)
   - mapped event cancelled or 404 -> remote_deleted item with choices unlink / recreate /
     delete_goal (D8; delete_goal is destructive)
   - remote event with no mapping and no studylampGoalId -> pull_create (D11), skipping ids in
     users/{uid}/googleIgnored
   - unsupported event shape -> attention item (read-only explanation)
   - mapping whose goal no longer exists -> orphan (reported, never auto-removed)
   Returns {items, counts, remaining} (max 500 items per plan) and signs a plan token through
   C1. The planner receives a READ-ONLY client interface and must not import any write function.
5. Applier src/lib/server/goalSyncApply.ts, using C1 applyConfirmed with these writers:
   - pushCreate: insertEvent with the deterministic id; on 409 fetch it; if cancelled report
     remote_deleted, otherwise patch (adopts an event from an earlier crashed attempt). Sets
     extendedProperties.private.studylampGoalId.
   - pushUpdate: patchEvent with If-Match = the etag the user saw; 412 -> "stale".
   - pullUpdate: Admin SDK update of the goal doc, ONLY the fields title and targetDate, after
     re-validating them against the goals rules limits (read the goals rules block; verify the
     title length), inside a transaction that first checks the goal still has the value the user
     saw (else "stale").
   - pullCreate: create a goal (title, targetDate, default priority, completed false, owner uid)
     with the same validation (verify the priority enum).
   - recreate / unlink / deleteGoal as chosen; deleteGoal runs only when the item is in
     confirmedDestructive.
   - After EACH item: save the mapping (new base, etag, hash, status) and append a sync log
     entry, so a timeout loses nothing. Concurrency 3, chunks of 25.
6. Routes (withAuthedRoute, nodejs, force-dynamic, maxDuration 60 with the "adjust to the plan"
   comment):
   - PATCH /api/google/connections/[id] {calendar:{enabled:boolean}}. Enabling needs the calendar
     permission and creates (or re-finds by stored calendarId) the calendar; the UI confirm in
     item 8 comes first. If the stored calendar returns 404/410, report "calendar was deleted in
     Google" and let the user re-enable; do not silently create another. Enabling writes no events.
   - POST /api/google/sync/plan {goalIds?: string[] (max 25, ids validated)} -> read-only, preset
     googleSync, returns {planToken, items, counts, remaining}.
   - POST /api/google/sync/apply {planToken, accepted: string[], resolutions?: {itemId:
     "use_study_lamp"|"use_google"|"skip"|"unlink"|"recreate"|"delete_goal"},
     confirmedDestructive?: string[]} -> preset googleApply, returns per-item {itemId, status,
     code?}. 400 for a missing or invalid token.
   - GET /api/google/sync/status -> {enabled, calendarName, lastSyncAt, counts:{synced, failed,
     remoteDeleted, noDate, orphaned}} from stored mappings only (cheap, no Google call).
   - REMOVE the old one-way route POST /api/google/sync/goals if it exists. There must be NO route
     that writes without a plan token.
7. Client src/lib/googleClient.ts (summary, plan, apply, status). Make addGoal return the new
   goal id. Triggers (only when the integration is enabled, via a small cached flag from
   /api/google/connections so other users make no extra requests):
   a) after add / update / toggle on the goals page and after addGoal in the two roadmap call
      sites: call plan with that goalId; if it returns items, show a sonner toast "Google
      Calendar: 1 change ready to review" with a Review action that opens ConfirmChangesDialog.
      Nothing is written unless the user confirms. Dismissing is fine; the change shows up on
      the next check.
   b) on opening the Goals page: one read-only plan for everything, at most once every 10
      minutes, shown as a small banner "N changes to review".
   c) a manual "Check for changes" button in settings/google.
   Show per-item failures in plain language with a link to /settings/google. Goal deletion is not
   synced. After a pull is applied, refresh the goals list (verify listener vs one-time fetch).
8. UI (settings/google): a Calendar card with the toggle "Sync goals with Calendar" (off by
   default). Enabling opens a confirm dialog: "Study Lamp will create a calendar called 'Study
   Lamp goals'. After that, changes in either place are shown to you first. Nothing is written
   until you approve it. Your other calendars are never touched." The card then shows last check,
   counts, "Check for changes" (opens ConfirmChangesDialog), failed items with a plain reason
   (needs reconnect, permission missing, Google rate limit, deleted in Google, changed meanwhile),
   and a short "What syncs" table (title and date: both ways; completion, notes, priority: Study
   Lamp -> Google only). Never show "Synced" after a failed call.
9. Tests: the planner performs zero writes (fake client records calls); truth table through the
   planner (push, pull, converged, conflict, no base); eventToGoalFields (all-day ok, leading ✓
   stripped, timed event, multi-day, cancelled, invalid date, too-long title); buildCalendarEvent
   (end = start + 1, ✓ prefix, no time fields); event id (matches ^[a-v0-9]{5,1024}$,
   deterministic, differs by goal and by user); apply: unaccepted items untouched, stale items
   (goal changed or etag 412) skipped, conflict without a resolution skipped, delete_goal needs
   confirmedDestructive, insert 409 -> adopt, patch 404 -> remote_deleted and no recreate; a pull
   writes only title and targetDate; chunking by 25; backoff with injected timers; Study Lamp's own
   write does not reappear as a change on the next plan.
```
**Test (use a non-production Google account):**

1. Enable → confirm dialog appears first; a "Study Lamp goals" calendar is created and **no events yet**.
2. Click "Check for changes" → the dialog lists "create event" proposals; press Cancel → nothing appears in Google; press Apply → a goal dated 2026-10-10 shows as an all-day event on Oct 10 (not 9 or 11).
3. Change the goal's date in Study Lamp → toast "1 change ready to review" → Apply → the event moves.
4. Move the event in Google → "Check for changes" shows "Target date 2026-10-10 → 2026-10-12" under "Google → Study Lamp"; the goal is unchanged until you Apply; after Apply the goals page shows the new date.
5. Change the same goal's date in both places differently → a conflict item, unticked, default Skip; choose a side and Apply.
6. Edit the goal after the preview opened and before Apply → that item reports "changed since preview" and is skipped.
7. Complete the goal → proposal to add the ✓ prefix; remove the ✓ in Google → no change to the goal.
8. Run "Check for changes" three times with nothing changed → empty plan, one event per goal.
9. Delete an event in Google → "Deleted in Google" item with Unlink (default) / Re-create / Delete goal; Delete goal needs the extra tick.
10. Create a new event in the "Study Lamp goals" calendar → "Import as goal" proposal, unticked; Ignore it and it stays gone.
11. Delete a goal in Study Lamp → its event stays and the card shows 1 orphan. Revoke access in Google → "Needs reconnect". Disable the toggle → checks stop and nothing is deleted.

---

## STEP W4 — Tasks goal sync (opt-in, two-way, every write confirmed) **(v6.1)**

**Depends on:** W2, C1 (W3 recommended, because it provides the planner/applier shape and the client code). **Scope used:** Tasks only. Independent toggle: you can enable Tasks without Calendar and the reverse.

**Prompt:**
```
TASK W4 — two-way sync between goals and a dedicated Google Tasks list, with a preview and an
explicit confirmation before EVERY write (both directions). Plug into the W3 planner/applier
through the adapter interface; do not copy logic.
Read first: everything W3 added (goalSyncPlan.ts, goalSyncApply.ts, googleClient.ts, the
settings/google Calendar card, the sync routes), the C1 files, src/types/index.ts (Goal),
src/lib/goalUtils.ts, src/lib/isoDate.ts.

0. DIAGNOSTIC FIRST (temporary; status codes only): tasklists.insert, tasks.list with
   showCompleted, showHidden and showDeleted=true, tasks.patch with an If-Match header. Report
   whether showDeleted returns deleted tasks and whether a stale If-Match is rejected. If either
   is unsupported, report it and rely on re-read-and-compare (the C1 fingerprint already covers
   that).
1. src/lib/server/tasksGoalMapping.ts (pure):
   - buildTask(goal): title = goal title; notes = goal notes + "Priority: ..." + a final marker
     line "[studylamp:<goalId>]"; due = `${targetDate}T00:00:00.000Z` ONLY for a valid date
     (Google Tasks keeps just the date part, so no time of day is invented); status "completed"
     when the goal is completed; for a re-opened goal send status "needsAction" AND completed null.
   - taskToGoalFields(task) -> {title, targetDate|null, completed} | {attention: reason}:
     targetDate = isoDatePart(task.due) (first 10 characters, validated, never new Date);
     completed = (status === "completed"); title validated against the goal limits. Notes are NOT
     read back (the marker and Priority lines are ours).
   - tasksFieldsHash(fields).
2. src/lib/server/googleTasks.ts (fetch client, injected token): createTaskList("Study Lamp"),
   insertTask, patchTask (optional ifMatch), getTask, listTasks(listId, pageToken) with
   showCompleted, showHidden and showDeleted = true, maxResults 100, follow pages. Same error
   classification and backoff as W3. EVERY call takes the stored Study Lamp list id. Nothing may
   list or read the user's other task lists (the Tasks scope is broad, so this is a code-level
   rule; add a test).
3. Two-way fields: title, targetDate, completed, compared three-way against
   base = {title, targetDate, completed}. Notes and priority are push-only. Fields are independent:
   completing a task in Google while the title was edited in Study Lamp is two non-conflicting
   changes; a conflict exists only when the SAME field differs on both sides.
4. Idempotency for creates (Tasks has no client-chosen id), two-phase, executed only inside the
   apply step after the user confirmed:
   a) transaction on users/{uid}/googleSync/{goalId}: tasks.state = "creating" with an attempt
      timestamp; if another attempt is "creating" and younger than 2 minutes -> "busy";
   b) insert the task, then save taskId and state "synced";
   c) a mapping stuck in "creating" for more than 2 minutes: list the task list (all pages) and
      ADOPT the task whose notes contain the goal's marker instead of inserting a second one.
5. Planner and applier: add a Tasks adapter to the W3 structure with the same item kinds.
   Specifics:
   - a goal without a date still gets a task, without a due date (D6);
   - pull_update may change the title, the target date (including clearing it when the due date is
     removed in Google, shown explicitly as "Target date: 2026-10-10 -> (none)") and completed;
   - deleted in Google (404 or deleted flag) -> remote_deleted item with unlink / recreate /
     delete_goal choices (D8); never recreated without confirmation;
   - a task in the Study Lamp list with no marker and no mapping -> pull_create (unticked,
     D11), respecting googleIgnored;
   - patch with If-Match; 412 -> "stale";
   - pull writes to the goal doc touch ONLY title, targetDate and completed, validated and inside
     a transaction that checks the goal still equals the value the user saw.
6. Routes: extend PATCH /api/google/connections/[id] with {tasks:{enabled}} (needs the tasks
   permission; creates or re-finds the "Study Lamp" list; handle a deleted list as in W3; enabling
   writes no tasks). Extend POST /api/google/sync/plan and /apply with
   targets: ("calendar"|"tasks")[] defaulting to every enabled target; plan items carry their
   target and one plan token can cover both. The status route returns Tasks counts too.
7. UI: a Tasks card in settings/google, same pattern as Calendar. Confirm text on enabling: "Study
   Lamp will create a task list called 'Study Lamp'. After that, changes in either place are shown
   to you first. Nothing is written until you approve it. Your other lists are never touched."
   Independent toggle, "Check for changes", per-item errors, and a "What syncs" table (title, date
   and completed: both ways; notes and priority: Study Lamp -> Google only). The W3 goal-mutation
   hooks already request a plan; they now cover Tasks too.
8. Tests: buildTask (due format, no time, completed, re-open sends needsAction + completed null,
   marker present); taskToGoalFields (due with a time part, due removed, completed, invalid date,
   too-long title); two-phase create (busy, stale adoption by marker across several list pages, no
   duplicate on retry); the planner performs zero writes; truth table through the Tasks adapter
   including completion in both directions; conflict needs a resolution; independent fields do not
   conflict; 404 -> remote_deleted; target selection (calendar only, tasks only, both); independence
   of the two toggles; every Tasks call uses the stored list id; notes are never pulled.
```
**Test:**

1. Enable Tasks only → confirm dialog first; a "Study Lamp" list appears, **empty** until you Apply a plan; then one task per goal, due dates correct, no times.
2. Complete a goal in Study Lamp → proposal "completed"; Apply → the task shows completed. Re-open it → proposal; Apply → the task is pending again.
3. Tick a task done in Google → "Check for changes" shows "Completed: no → yes" under "Google → Study Lamp"; the goal changes only after Apply.
4. Rename a task in Google and change the goal's date in Study Lamp → two separate proposals, no conflict. Rename it differently in both places → conflict.
5. Remove a task's due date in Google → proposal "Target date → (none)" and nothing happens until you confirm.
6. Click "Check for changes" repeatedly and kill an Apply mid-way once → no duplicate tasks (two-phase create with marker adoption).
7. Delete a task in Google → "Deleted in Google" item with Unlink (default) / Re-create / Delete goal; nothing is recreated without your choice.
8. Add a task by hand in the "Study Lamp" list → "Import as goal" proposal, unticked.
9. Enable Calendar as well → both work independently, and one dialog can show both targets.

---

## STEP W5 — Reconcile, orphan report, sync history, explicit removal, docs **(v6.1)**

**Depends on:** W3, W4. **Decision:** D3.

**Prompt:**
```
TASK W5 — give the user safe control over what Study Lamp created or changed in Google, a
readable history of every applied change, and finish the documentation.
Read first: the W3/W4 sync code and status route, the C1 sync log and plan token code,
src/app/settings/google/page.tsx, src/lib/server/googleCalendar.ts,
src/lib/server/googleTasks.ts, docs/deploy.md, docs/security.md, docs/google-workspace.md.

1. Orphan report: GET /api/google/sync/status lists up to 50 orphans (mapping docs with no goal)
   using titleSnapshot. The settings cards show "N items in Google no longer match a goal" with a
   collapsible list.
2. Sync history: GET /api/google/sync/history?cursor=... returns the newest 50 entries from
   googleSyncLog (time, direction, target, title, fields before/after, result). Settings shows a
   collapsible "Recent changes" list, e.g. "Pulled from Google: 'Read chapter 3' date 2026-10-10 ->
   2026-10-12". Because pulled changes modify goals, this is how the user sees (and can manually
   revert) what changed. Read-only; no undo button in this roadmap.
3. Explicit removal, with the same preview/confirm pattern as C1:
   - POST /api/google/sync/remove/preview {target:"calendar"|"tasks", scope:"orphans"|"all"} ->
     read-only; returns the exact list of titles and a plan token (scope "remove").
   - POST /api/google/sync/remove {planToken, confirmCount}. It deletes ONLY the remote
     events/tasks whose ids are recorded in this user's mapping docs, in chunks of 25 with backoff,
     and never anything else. confirmCount must equal the current count (stale confirm -> 409 with
     the fresh count). A 404/410 counts as already gone. Update mappings (status "removed"), write
     sync log entries and report {removed, alreadyGone, failed}.
4. UI: a "Remove from Google..." button behind a dialog that lists the first 20 titles and the
   total, states that it cannot be undone from Study Lamp, and defaults focus to Cancel.
5. Disconnect dialog (from W2): when mapping docs exist, add an UNCHECKED option "Also remove N
   events/tasks that Study Lamp created", executed through the same preview and token BEFORE the
   token is deleted. Goals that were changed from Google data stay as they are.
6. Do NOT build a background cron. Document in docs/google-workspace.md how a daily Vercel Cron
   could later run the read-only PLAN (never the apply, so it cannot write) and set a "changes
   waiting" flag, protected by a CRON_SECRET, and leave it unimplemented.
7. Docs: complete docs/google-workspace.md: setup, redirect URIs, scopes and why, the
   consent-screen publishing note, how users connect / enable / check / review / apply /
   disconnect, and the data lifecycle table:
   | Event | What happens |
   | Goal created or edited in Study Lamp | Proposal; written to Google only after you confirm |
   | Event or task edited in Google | Proposal; the goal changes only after you confirm |
   | Both edited | Conflict; you choose, default Skip |
   | Goal completed | Tasks: proposal to mark completed. Calendar: proposal to add the check mark |
   | Goal deleted | Google item stays; listed as an orphan; removable only via "Remove from Google" |
   | Item deleted in Google | Proposal: unlink / re-create / delete the goal (extra confirm) |
   | New item created by hand in the Study Lamp calendar/list | Proposal to import as a goal, unticked |
   | Append to a Doc or Sheet (W1b) | Exact text/rows previewed; appended only after you confirm |
   | Disconnect | Token deleted; Google items stay unless the box is ticked; goals stay |
   Add troubleshooting (invalid_grant, 7-day token expiry in Testing mode, rate limits, deleted
   calendar/list, "changed since preview"). Update docs/deploy.md (env list; APIs to enable:
   Calendar, Tasks, Docs, Sheets) and docs/security.md (plan-token signing and its domain prefix,
   googleSync, googleSyncLog and googleIgnored are server-only, key rotation).
8. Tests: removal only touches mapped ids; confirmCount mismatch -> 409 with the fresh count; a
   removal without a valid token -> 400; 404 handled; orphan detection pure function; history
   paging; disconnect with and without the option.
```
**Test:** delete two goals, press "Remove from Google" → the dialog lists exactly those two titles; Cancel changes nothing; Apply removes exactly those two events/tasks and nothing else; a stale confirm count is rejected; "Recent changes" shows every earlier pull and push with before/after values; disconnect with the box ticked removes everything Study Lamp created, unticked leaves Google untouched.
