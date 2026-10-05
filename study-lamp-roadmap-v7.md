# Study Lamp — Roadmap v7 (Fix First, Finish, Then Extend)

Supersedes v6.1. Based on a read of the latest `src.zip` (448 files, including `study-lamp-roadmap-v6.1.md` and `docs/google-workspace.md`).

## How this audit was done (read this first)

- **Read:** every file the v6.1 steps touch, plus the sync, Drive and connection code around them.
- **Ran, in a sandbox:** `tsc --noEmit`, `npm test`, and two small probe scripts against the real planner.
- **Sandbox limits:** `cdn.sheetjs.com` (the `xlsx` tarball) is blocked, so I installed everything else without it. Errors that only come from the missing `xlsx` module are ignored below. I regenerated the lockfile in my scratch copy only; your files were not changed. No network calls to Google, no browser, no Firebase project. Anything about Google API behaviour is marked **(verify)**.
- **Results:**
  - `tsc`: **5 real type errors** (B1). `next build` type-checks and `next.config.js` does not set `ignoreBuildErrors`, so the build should fail.
  - `npm test`: 540 of 544 pass. The 4 failures are 1 real (`rateLimit.test.ts`, B27), 1 environment (`thumbnailUrlHandling.test.ts` needs Firebase env vars), and 2 sandbox-only (`xlsx` missing).
  - `npm run lint` is **not usable**: there is no ESLint config in the zip, so `next lint` opens an interactive setup prompt (B24). If the config exists in your repo and was just left out of the zip, ignore this.
- **Probe results (real code, not guesses):**
  - A goal that is already synced to Calendar is re-proposed as `push_create` every time (B5).
  - A Google-side date change (10th → 12th) is planned as "overwrite Google with Study Lamp's 10th" instead of "pull the 12th" (B4).

---

## 0. Product decisions that stay FINAL

Unchanged from v6.1:

- No PowerPoint tab, viewer or outline route. (Note: PPTX files can still be imported and are shown on Drive's preview surface. That was already the state of the code; I treat it as acceptable.)
- AI language is `en` | `bn` only.
- Drive keeps the narrow `drive.file` scope.
- Google integration is two-way but never silent. Every write, in either direction, is previewed and confirmed. Nothing is deleted automatically. Confirmation is enforced on the server.

New in v7:

- **D13 — A step is "done" only when its test passes against realistic data.** The v6.1 planner tests used remote ids shaped like `goal:<id>`, which hid B5. Tests must use the id shapes Google really returns.
- **D14 — Hotfix before anything else.** The Docs/Sheets append apply routes bypass confirmation today (B2). Disable them (return 503) until step Z2 is finished.

---

## 1. Audit result: what is implemented

"Complete" means the code exists and matches the v6.1 spec on reading it. It does not mean it works end to end.

### 1.1 Totals (84 numbered instructions across 17 steps)

| Status | Count |
|---|---|
| Complete | **27** |
| Partial | **21** |
| Not started | **33** |
| Cannot verify (the three "diagnostic first" steps need a live Google account) | **3** |

### 1.2 Per step

| Step | Status | Done / Partial / Missing | Short reason |
|---|---|---|---|
| H1 Route and logging hygiene | **Partial** | 1 / 2 / 2 | `logServerError` and safe logging done (but one call has the wrong arguments, B1). Only 4 of 14 listed routes moved to `withAuthedRoute`. `quiz-attempts` still has no rate limit. `findDriveOwnedRecord` not created. 10k-row XLSX test missing. |
| H2 Cleanups | **Partial** | 3 / 0 / 2 | Image hosts, Netlify comment and Proxy comment done. Orphaned thumbnails not handled. Optional page refactor not done. |
| C1 Confirmed-change core | **Partial** | 6 / 3 / 0 | Dates, three-way logic, plan items, signed token, apply gate and tests exist. Sync log is only types (nothing is saved). `googleIgnored` is never used. `ConfirmChangesDialog` exists but nothing renders it. |
| W1 Docs and Sheets import | **Partial** | 7 / 3 / 1 (+1 unverifiable) | Export, signed URLs, import, rules and picker kinds exist. No Google badge, no "Open in Google" link, no "last changed" line. No tests. Error mapping is wrong (B17). |
| W1b Docs/Sheets write-back | **Partial, unsafe** | 0 / 4 / 2 (+1 unverifiable) | Clients and 4 routes exist, but the apply routes write before the gate and take content from the client (B2). No UI. No tests. Sheets export finds no rows (B13). |
| W2 Workspace connection | **Nearly complete** | 10 / 1 / 0 | OAuth, scopes, state, callback, encrypted storage, key rotation, settings page, sidebar link and docs exist. Gaps: disconnect uses `window.confirm`; calendar routes assume a connection id that is never created (B3). |
| W3 Calendar two-way sync | **Partial, broken** | 0 / 7 / 2 (+1 unverifiable) | Planner, apply and routes exist but cannot work end to end (B3 to B12). Settings UI for Calendar and goal-change hooks are missing. |
| W4 Tasks two-way sync | **Not started** | 0 / 0 / 9 | No Tasks client, mapping or UI. |
| W5 Reconcile, history, removal | **Not started** | 0 / 1 / 7 | No orphan list, history, removal routes. Docs cover setup only. |
| F1 to F8 | **Not started** | 0 / 0 / 8 | No Today Plan, flashcards, AI resources, backup v2, export, Next upgrade or PWA. Streak exists but is wrong (B23). |

---

## 2. Bug and improvement register

Severity: **P0** blocks the build or breaks a safety promise. **P1** a shipped feature cannot work. **P2** should fix. **P3** polish.

### P0

| ID | Where | Problem | Fix (step) |
|---|---|---|---|
| **B1** | `sync/plan/route.ts:70`, `googleSyncState.ts:25`, `planToken.ts:91,113`, `aiModels.ts:82` | 5 TypeScript errors. `aiModels.ts` calls `logServerError(label)` but the function needs `(label, err)`; the others are `undefined` / `null` type mismatches. `next build` will fail. | Z0 |
| **B2** | `drive/docs/append/apply`, `drive/sheets/append/apply` | The route writes to Google first, then calls `applyConfirmed` with a no-op writer. Text, heading and revision id come from the **request body**. `accepted` only has to be non-empty. The token is not tied to a document id, so a token for document A works on document B. Tokens can be replayed for 15 minutes. This breaks Global Rules 13 and 15 and the W1b spec ("the client cannot supply text"). | Z2 (hotfix D14 now) |
| **B3** | `googleConnections.ts`, `sync/plan`, `sync/apply`, `connections/[id]` | Calendar code reads `googleConnections/calendar` (a literal id), but the OAuth callback saves connections under auto-generated ids. Enabling Calendar throws "not found". Calendar sync cannot start. | Z1 |
| **B4** | `sync/plan/route.ts` | The **preview writes to Firestore** (`saveGoalRemoteEvent` for every remote event). This violates Rule 15. It also overwrites the stored `base` with Google's current values on every check, so a Google change becomes the new "base". Probe result: Google's 12th vs Study Lamp's 10th becomes `push_update` (overwrite Google), never a pull. | Z1 |
| **B5** | `goalSyncPlan.ts`, `sync/plan/route.ts` | The planner looks up `remoteById.get(goal.id)`, but remote records are keyed by the Google event id (a hash from `buildCalendarEventId`). They never match, so every already-synced goal is re-proposed as `push_create` (probe result). The route also appends stored (older) records after live ones, so old values win in the `Map`. Apply would then hit a 409 from Google. | Z1 |

### P1

| ID | Where | Problem | Fix |
|---|---|---|---|
| **B6** | `sync/apply/route.ts` | The "fresh plan" at apply time is rebuilt from **stored** records, not from a live Google read, so stale detection does not look at Google. `push_update` calls `insertGoalEvent` (create) instead of `patch`. No `If-Match` etag is sent. | Z1 / Z4 |
| **B7** | `sync/apply/route.ts`, `applyGate.ts` | Writers `return` silently when the goal or remote is missing, or when "unlink" is chosen, and the gate reports `applied`. Violates Rule 8. The gate also says nothing about token items missing from the fresh plan. | Z3 |
| **B8** | `sync/apply/route.ts` | `remote_deleted` only handles "recreate". "Unlink" and "Delete goal here" are not implemented, the resolution type has no such values, and the item is marked destructive for every choice. | Z4 |
| **B9** | `sync/apply/route.ts` | A pull writes both `title` and `targetDate` from the stored record, even when only one changed. No validation against the goals limits, no transaction, no "still equals what the user saw" check, base not updated, nothing logged. | Z4 |
| **B10** | `goalSyncPlan.ts`, `lib/sync/plan.ts` | The fingerprint only includes the local **title**, so a local date change after the preview is not detected on pull items. Field rows show `before = base` rather than the current value. Conflict items show only Study Lamp's value, never Google's. One field conflicting makes the whole item a conflict. | Z3 / Z4 |
| **B11** | `goalSyncPlan.ts` | `completed` is never compared, so the "✓ " prefix (decision D4) is not synced unless title or date also changes. | Z4 |
| **B12** | `googleCalendar.ts` | No retry or backoff, no pagination (`nextPageToken` ignored), no error classification, error messages include the Google response body, `DELETE` returns 204 and `res.json()` throws on success, no `If-Match`. `getOrCreateStudyLampCalendar` matches by **name** in the user's calendar list, which can adopt a calendar the user already owns (breaks "never touch other calendars") and may not be allowed under `calendar.app.created` **(verify)**. | Z1 |
| **B13** | `googleAppend.ts`, `sheets/append/*` | The query `googleSheetExportedAt == null` matches nothing, because existing attempts do not have that field. The `quizAttempts` query (two `where` + `orderBy`) needs a composite index that is not in `firestore.indexes.json`. `markQuizAttemptsExported` is never called, and it would mark attempts that were not in the preview. The Sheets preview shows document text instead of rows. No header row, no 200-row cap, quiz title is a constant. `assertAllowedSheetRequests` exists but `createSheet` never calls it. | Z2 |
| **B14** | `googleDocs.ts`, `googleAppend.ts` | The heading is inserted twice (it is inside `text` and also added by `appendToDocument`). `updateParagraphStyle` uses a zero-length range, which the Docs API should reject **(verify)**, so the whole batch can fail. `quiz_review` only reports "Wrong answers: N" and not the questions. The "ignore our own section" rule for Docs text extraction is missing (only the Sheets tab is skipped). | Z2 |
| **B15** | `googleSyncLog.ts`, `planner` | Sync history is never saved. `googleIgnored` is never read or written. `pull_create` is never planned (events without the goal marker are filtered out). | Z3 / Z4 |
| **B16** | UI | No Calendar enable toggle, no "Check for changes", no sync status, no goal-change hooks. `ConfirmChangesDialog` is not rendered anywhere. `addGoal` still returns `void`. Disconnect uses `window.confirm`. The goals page reads with `getDocs` once, so pulled changes need a manual reload. | Z4 |
| **B17** | `googleDrive.ts`, `drive/stream/[fileId]` | `exportFile` reports **every** 403 as "too large", hiding permission errors. A non-native file with an export purpose returns 502 instead of 400. The route imports `googleDrive` dynamically on every request. | Z5 |

### P2

| ID | Where | Problem | Fix |
|---|---|---|---|
| **B18** | `googleCalendar.ts` + test | A timed event is silently turned into a date. v6.1 said timed, multi-day and cancelled events must be "attention" items and never guessed. The existing test locks in the wrong behaviour. | Z4 |
| **B19** | 10 routes | Not on `withAuthedRoute`: `ai/system-connections/[id]`, `[id]/test`, `quiz-attempts` (no rate limit), `find-user`, `youtube-duration`, `external-playlist`, `youtube-playlist`, `youtube-playlist-search`, `facebook-video`, `facebook-video/thumbnail`. `facebook-video` logs user URLs in `console.warn`. | Z6 |
| **B20** | `documents/[id]` DELETE, backfill | Orphaned `driveThumbs` docs are never removed (gap E). | Z6 |
| **B21** | tests | No tests at all for `googleDocs`, `googleSheets`, `googleAppend`, the append routes, W1 export, or the sync routes. No "preview performs zero writes" test (Rule 15). Planner tests use ids that hide B5. 10k-row XLSX test missing. | each step |
| **B22** | `planToken.ts` | Tokens are reusable for 15 minutes. Fingerprints make most replays "stale", but append operations are replayable (see B2). | Z3 |
| **B23** | `lib/firestore/users.ts` | `computeStreak` mixes `toISOString()` (UTC) with `setDate()` (local time). Between 00:00 and 06:00 in Dhaka the streak is off by one day. | F1 |
| **B24** | repo | No ESLint config in the zip. Mixed CRLF and LF line endings and some UTF-8 BOMs. Several `as any` casts at route boundaries. `nativeExportMime` is defined twice (`driveMime.ts` and `googleDrive.ts`). | Z0 |
| **B25** | `firestore.rules` | No explicit rules for `googleSyncLog` and `googleIgnored` (default deny works, but v6.1 asked for explicit). The comment "Step W3 will store…" is stale. The mapping path in code (`googleSync/goals/items/{id}`) does not match the rules or spec (`googleSync/{goalId}`). | Z3 / Z1 |
| **B26** | docs | `docs/google-workspace.md` stops at setup (no usage, no data lifecycle table, no troubleshooting). `docs/security.md` has no section on plan tokens. | W5 |
| **B27** | `rateLimit.ts` / test | `googleSync` preset was added but `rateLimit.test.ts` still expects the old list, so it fails. The `googleApply` preset from C1 was never added (routes pass `scope: "googleApply"` with the `googleSync` preset instead). The limiter is in-memory per instance (already documented in the file). | Z0 |

### P3

- `createAuthedRoute` calls `requireAdminUid` after authenticating, which verifies the token twice for admin routes. Harmless, slightly wasteful.
- `ok: results.length > 0` in the apply response says `ok` even when every item failed.
- Several `catch` blocks return a generic 500 with no `logServerError` (plan, apply, PATCH). Rule 4 asks for the error name to be logged.
- The `xlsx` dependency is a tarball from `cdn.sheetjs.com`. Builds behind a restricted network fail. Consider vendoring the tarball or using a registry mirror.

---

## 3. Roadmap at a glance

| Step | Title | Fixes | Depends on |
|---|---|---|---|
| **Z0** | Green build and honest tests | B1, B24, B27 | none |
| **Z3** | Finish the confirmation core (C1) | B7, B10, B15, B22, B25 | Z0 |
| **Z1** | Repair the Calendar foundation | B3, B4, B5, B6, B12 | Z0, Z3 |
| **Z2** | Make Docs/Sheets write-back safe | B2, B13, B14 | Z3 |
| **Z4** | Finish Calendar two-way sync (W3) | B8 to B11, B15, B16, B18 | Z1, Z3 |
| **Z5** | Finish Docs/Sheets import (W1) | B17 + UI + tests | Z0 |
| **Z6** | Finish H1/H2 | B19, B20, B21 | Z0 |
| **W4** | Tasks two-way sync | new | Z1, Z3, Z4 |
| **W5** | Reconcile, history, removal, docs | B26 | Z4, W4 |
| **F1** | Streak and activity ledger | B23 | none |
| **F2** | Today Plan | | F1 |
| **F3** | Flashcards from quiz mistakes | | none |
| **F4** | AI study resources | | Z5 |
| **F5** | Backup v2 | | W4 |
| **F6** | Export: Markdown and Anki TSV | | F4 |
| **F7** | Next.js major upgrade | | all features |
| **F8** | PWA | | F7 |

**Recommended order:** hotfix D14 now → Z0 → Z3 → Z1 → Z2 → Z4 → Z5 → Z6 → W4 → W5 → F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8.
**Parallel-safe:** {Z0, Z5, Z6, F1, F3}. Do not start Z4, W4 or W5 before Z1 and Z3 are merged and tested.

---

## 4. How to use the prompts

Paste the **Global Rules** once per session, then one step prompt at a time. Finish the step's test before starting the next. If a path in "Read first" does not exist, search the repo and say so.

### Global Rules block (v7)

```
You are working in an existing Next.js 14 (App Router) project called Study Lamp
(Firebase Auth + Firestore, Tailwind, Radix UI, sonner, driver.js, Tiptap,
EmbedPDF, docx-preview, SheetJS). Source is under src/. Server-only code is in
src/lib/server/ and uses the Firebase ADMIN SDK (adminDb / adminAuth from
src/lib/server/firebase-admin.ts). Client code uses the Firebase CLIENT SDK
(src/lib/firebase.ts). API routes authenticate with
`Authorization: Bearer <Firebase ID token>`; routes use withAuthedRoute
(src/lib/server/routeHelpers.ts) with a RATE_LIMITS preset
(src/lib/server/rateLimit.ts). Drive stream/thumbnail routes authenticate with
HMAC-signed URLs. Google APIs are called with plain fetch (no googleapis package).

Product decisions that are FINAL:
- No PowerPoint tab, viewer or outline route.
- AI response language is "en" | "bn" only.
- Drive keeps the drive.file scope. Never widen it.
- Google integration is two-way, but never silent: every write to Google, and
  every change to a Study Lamp goal that comes from Google data, is previewed and
  needs explicit user confirmation first. Nothing is deleted on either side
  automatically.

Rules:
1. READ FIRST. Open every file listed under "Read first". Never invent paths or
   APIs; search the repo and tell me when something is missing.
2. Smallest change that satisfies the task. No unrelated refactors or reformatting.
3. NEVER use the client Firebase SDK inside src/app/api/** or src/lib/server/**.
4. Never print, log, commit or paste secrets or tokens. Never log or return response
   bodies from Google or AI providers; log status codes and error names only, using
   logServerError(label, err).
5. Every route authenticates BEFORE touching data, validates every input, and returns
   generic error messages (never error.message from a library or from Google).
6. Any new Firestore collection or field needs explicit rules in firestore.rules.
   Server-written data: client read and write false. Add an index to
   firestore.indexes.json for any query that needs one.
7. Never use `new Date("YYYY-MM-DD")` for goal dates. Use src/lib/isoDate.ts.
8. No broad catch that turns a failure into success. An action is reported as
   "applied" only after the real write returned success. A no-op is "skipped" with a code.
9. Reuse existing UI patterns (src/components/ui/*, sonner, Skeleton).
10. Prefer no new libraries. If one is needed, state version and licence, and pin it.
11. Add unit tests for pure logic. Tests must use the id shapes Google really returns
    (for example the hashed Calendar event id, not "goal:<id>").
12. Run `npx tsc --noEmit`, `npm run lint`, `npm test`. Report honestly. If you cannot
    run something, say so; do not claim it passed.
13. Two-way sync is allowed; silent writes are not. Any write to Google (create,
    update, delete, append) and any change to a goal that comes from Google data MUST go
    through preview -> confirm -> apply (signed plan token + per-item fingerprint). No
    route, hook, effect, cron or fire-and-forget call may write without a valid,
    user-confirmed token. Read-only checks need no confirmation.
14. Never delete on either side automatically. A delete is its own item with its own
    extra confirmation.
15. Preview/plan endpoints perform ZERO writes (to Google, to goals, AND to Firestore
    mapping or sync-state docs). Every integration gets a test with a recording fake
    proving no write function is called during a preview.
16. The apply step must (a) verify the token, (b) re-read the CURRENT local and remote
    state, (c) recompute the plan, (d) compare fingerprints, and only then write.
    Content written to Google is built on the server from stored data, never taken from
    the request body.
17. No `as any` on request, response or Google-API boundaries. Define types.
18. End with: files changed / manual test steps / anything you were unsure of / the
    actual output of tsc and npm test.
```

---

# PART A — Stabilise

## HOTFIX D14 — Disable the unsafe append routes (do this today)

```
Make POST /api/drive/docs/append/apply and POST /api/drive/sheets/append/apply return
503 {"error":"Temporarily unavailable"} immediately after authentication, with a comment
pointing to roadmap step Z2. Do not change anything else. Add one test per route proving it
returns 503 and never calls withDriveAccessToken. Leave the preview routes as they are.
```
**Test:** both apply routes return 503; previews still work.

---

## STEP Z0 — Green build and honest tests

**Fixes:** B1, B24, B27. **Depends on:** none.

```
TASK Z0 — make tsc, tests and lint pass, and make them mean something.
Read first: src/lib/server/aiModels.ts (line ~82), src/lib/server/logError.ts,
src/app/api/google/sync/plan/route.ts, src/lib/server/googleSyncState.ts,
src/lib/server/goalSyncPlan.ts (GoalRemoteEvent), src/lib/server/planToken.ts,
src/lib/server/rateLimit.ts + rateLimit.test.ts, package.json, next.config.js.

1. aiModels.ts: logServerError needs (label, err). Pass the real error (or make the second
   argument optional and still print only the name). Check every other logServerError call for
   the same mistake.
2. planToken.ts: after validating `payload.exp` with Number.isInteger, assign it to a local
   `const exp: number` so TypeScript narrows it. Do not change behaviour.
3. GoalRemoteEvent: make `base` and `targetDate` `string | null | undefined` consistently
   (base?: {...} | null) and fix googleSyncState.ts and sync/plan/route.ts without `as any`.
4. rateLimit: add `googleApply: { limit: 20 }` to RATE_LIMITS, update the test to the full
   preset list, and make every Google route use `preset: "googleApply"` or `"googleSync"`
   instead of passing a custom `scope` with the wrong preset.
5. Lint: add .eslintrc.json (extends "next/core-web-vitals") if it does not exist, so
   `npm run lint` runs without prompting. Report the warning count; do not fix unrelated ones.
6. Add .gitattributes (`* text=auto eol=lf`) and .editorconfig. Do NOT mass-reformat files in
   this step; only list how many files have CRLF or a BOM.
7. Remove the duplicate nativeExportMime: keep the one in src/lib/driveMime.ts (pure, shared)
   and import it in googleDrive.ts.
8. In package.json, add a comment in docs/deploy.md about the xlsx tarball URL
   (cdn.sheetjs.com) and what to do on a restricted network.
```
**Test:** `npx tsc --noEmit` has zero errors; `npm test` is green (the Firebase-env test must be fixed or skipped with a clear message when the env is missing); `npm run lint` runs non-interactively.

---

## STEP Z3 — Finish the confirmation core (C1)

**Fixes:** B7, B10, B15, B22, B25. **Depends on:** Z0. Do this before Z1 and Z2, because both use it.

```
TASK Z3 — complete the shared preview -> confirm -> apply machinery.
Read first: src/lib/sync/plan.ts, src/lib/sync/threeWay.ts, src/lib/server/planToken.ts (+ test),
src/lib/server/applyGate.ts (+ test), src/lib/server/googleSyncLog.ts,
src/components/sync/ConfirmChangesDialog.tsx (+ test), firestore.rules, firestore.indexes.json.

1. applyGate returns a typed outcome from writers: a writer may return nothing (= applied),
   or `{ skipped: "<code>" }`. "applied" is reported ONLY when the writer finished without
   throwing and without a skip code. Every token item that is missing from the fresh plan is
   reported as {status:"stale", code:"item_gone"}. Remove the silent `continue`.
   Test: writer returns skip -> "skipped"; writer throws -> "failed"; token item gone -> "stale".
2. Fingerprint: buildPlanItem takes a `local` snapshot ({title, targetDate, completed, ...} or a
   hash of the content to append) and the remote version (etag/revisionId) and includes both in
   the fingerprint. Field rows use before = the CURRENT value on the side that will change and
   after = the new value. Conflict items carry BOTH values (a `fields[].local` and
   `fields[].remote`). Test: change only the local date after a preview of a title pull ->
   fingerprint differs.
3. Conflict granularity: one PlanItem per goal per target, but resolutions are per FIELD
   ({itemId, field} -> choice). Non-conflicting fields in the same item are applied normally.
   Update ConfirmChangesDialog to show a radio group per conflicting field.
4. Sync log: add saveSyncLogEntry(uid, entry) (Admin SDK) writing to
   users/{uid}/googleSyncLog/{autoId}; the entry holds goal fields only (title, targetDate,
   completed), never tokens or document text. Prune: after a write, if the user has more than
   220 entries, delete the oldest down to 200 (query orderBy at desc, offset 200; do not slice an
   unsorted array). Add listSyncLog(uid, cursor, limit). Test the prune with a fake store.
5. Ignore list: users/{uid}/googleIgnored/{target_remoteId} {at}. Add isIgnored(uid, target,
   remoteId) and ignoreRemote(...). The ignore action itself is only allowed from the apply route
   for an item the user explicitly chose "Ignore" on (it is a write to our own data, so it also
   goes through the token).
6. One-time tokens: add a `jti` (random 16 bytes) to the token payload. The apply routes call
   markTokenUsed(uid, jti) in a Firestore transaction (users/{uid}/googleUsedTokens/{jti}, with
   an `exp` field) BEFORE writing; a second use returns 409 "plan already applied". Add a TTL or
   a daily prune. Test: replaying the same token -> 409, nothing written.
7. firestore.rules: explicit `allow read, write: if false` for googleSyncLog, googleIgnored,
   googleUsedTokens and googleSync (mapping), and fix the stale "Step W3 will…" comment.
8. ConfirmChangesDialog accessibility check: default focus on Cancel, Esc closes with nothing
   written, every control reachable by keyboard, direction written in words. Add tests for the
   pure parts (grouping, default ticks, button label counts).
```
**Test:** unit tests for every point above pass; `grep -rn "googleSyncLog\|googleIgnored" src` now shows real reads and writes; replay of a plan token is rejected.

---

## STEP Z1 — Repair the Calendar foundation

**Fixes:** B3, B4, B5, B6, B12. **Depends on:** Z0, Z3.

```
TASK Z1 — fix the data model and the planner so Calendar sync can work at all.
Read first: src/lib/server/googleConnections.ts, src/lib/server/googleSyncState.ts,
src/lib/server/goalSyncPlan.ts (+ test), src/lib/server/goalSyncApply.ts,
src/lib/server/googleCalendar.ts (+ test), src/app/api/google/sync/plan/route.ts,
src/app/api/google/sync/apply/route.ts, src/app/api/google/sync/status/route.ts,
src/app/api/google/connections/[id]/route.ts, src/types/index.ts (GoogleCalendarConnection),
firestore.rules.

0. DIAGNOSTIC FIRST (temporary; status codes only; remove afterwards): with a test account and
   the W2 connection run calendars.insert, events.insert (all-day), events.list(showDeleted=true),
   events.patch with a stale If-Match, calendars.get on the created calendar, and
   calendarList.list. Report each status code. If anything returns 403/404 under
   calendar.app.created, STOP and report; do not switch to a broader scope without asking.
1. Connection model. Remove the literal "calendar" id everywhere. A connection is addressed by
   its real doc id. Calendar settings live INSIDE that doc:
   calendar: { enabled, calendarId, calendarName, lastCheckAt }.
   getGoogleCalendarConnection(uid, connectionId), setGoogleCalendarEnabled(uid, connectionId,
   enabled). The browser sends connectionId; the server checks it belongs to uid and that the
   calendar permission was granted. If the user has exactly one connection with the calendar
   permission, the plan/apply/status routes may default to it. PATCH /api/google/connections/[id]
   accepts any real id.
2. Calendar creation. Do not look for an existing calendar by name. Enabling: if a calendarId is
   already stored, verify it with calendars.get; 404/410 -> report "calendar was deleted in
   Google" and require a new explicit enable. Otherwise calendars.insert. (Enabling writes no
   events.) Remove getOrCreateStudyLampCalendar's name matching and update its test.
3. Mapping storage. One doc per goal: users/{uid}/googleSync/{goalId} with
   { titleSnapshot, calendar: { connectionId, calendarId, eventId, remoteEtag,
   base: {title, targetDate, completed}, hash, status, lastSyncAt, lastErrorCode } }.
   Delete googleSyncState.ts's googleSync/goals/items path. Add typed read/write functions;
   no `as any`.
4. Planner inputs. planCalendarSync reads: goals, mapping docs, and LIVE events from Google
   (listEvents with pagination). Matching: mapping.eventId, else the deterministic id for
   (uid, goalId), else extendedProperties.private.studylampGoalId. Never match on goal.id alone.
   Never read stored remote values as if they were live. The planner takes a READ-ONLY interface
   and must not import any write function.
5. Zero writes in the plan route. Remove saveGoalRemoteEvent from sync/plan/route.ts. The
   `base` changes only in the apply step (per applied item) or for a "converged" item the user
   did not need to confirm (bookkeeping only; document this as the single allowed non-confirmed
   write and make it write ONLY to our own mapping doc, never to Google or to goals).
6. Apply. Re-read live events and mappings, recompute the plan, then call the Z3 gate. push_update
   uses events.patch with If-Match = the etag the user saw (412 -> "stale"). push_create inserts
   with the deterministic id; on 409 fetch it, and if it is not cancelled adopt it with a patch.
7. googleCalendar.ts client. Add: error classes (auth, scope_missing, retryable, remote_missing,
   exists, changed_remotely), retry with backoff and jitter (max 3, honour Retry-After),
   pagination (up to 10 pages), `If-Match` support, correct handling of 204 (no body), and errors
   that never include the response body. Add getEvent and calendars.get.
8. Tests (recording fakes, realistic ids): plan performs zero writes; already-synced goal with
   the real hashed event id produces NO item; a Google-side date change produces pull_update with
   before = current goal value and after = Google value; same change on both sides -> converged;
   different changes -> conflict; matching by marker when the mapping is missing; 204 delete;
   retry/backoff with injected timers; 412 -> stale; 409 -> adopt.
```
**Test (non-production Google account):** enable Calendar (the dialog from Z4 may not exist yet, so call PATCH directly) → "Study Lamp goals" calendar is created and has no events; call plan twice → identical result, and Firestore shows no new documents; apply one `push_create` → exactly one event; plan again → empty; move the event in Google → plan shows the pull, and the goal is unchanged until apply.

---

## STEP Z2 — Make Docs/Sheets write-back safe (W1b)

**Fixes:** B2, B13, B14. **Depends on:** Z3 (one-time tokens, outcome-typed gate).

```
TASK Z2 — rebuild the append apply routes so they cannot write without a valid, user-confirmed
token, and so the content is built on the server.
Read first: src/app/api/drive/docs/append/{preview,apply}/route.ts,
src/app/api/drive/sheets/append/{preview,apply}/route.ts, src/lib/server/googleDocs.ts,
src/lib/server/googleSheets.ts, src/lib/server/googleAppend.ts, src/lib/server/applyGate.ts,
src/lib/server/planToken.ts, src/lib/server/documentText.ts, src/lib/quizAttempt.ts,
src/app/api/quiz-attempts/route.ts, firestore.indexes.json, firestore.rules.

0. DIAGNOSTIC FIRST (throwaway Doc and Sheet I name; status codes only): documents.get,
   spreadsheets.get, then one batchUpdate on each. If 403/404 under drive.file, STOP.
   Also test whether updateParagraphStyle with a zero-length range is rejected (expected 400).
1. The apply request is ONLY {planToken, accepted, documentId?}. Remove text, heading and
   revisionId from the body entirely. The token's item carries target = `google-doc:<documentId>:
   <kind>` (and for Sheets `google-sheet:<documentId>:quiz_results`); the route checks the
   documentId (or the one in the token) matches the stored record, so a token cannot be applied
   to another document or kind.
2. Apply order: verify token (uid, scope) -> mark token used (Z3) -> load the stored
   personalDocuments record (googleNative true, matching type) -> RE-BUILD the content on the
   server -> get the current revisionId -> recompute the fingerprint -> applyConfirmed with a REAL
   writer that performs the Google write -> log the result (Z3). The write happens INSIDE the
   writer, never before the gate.
3. Docs: fix the heading duplication (heading is built once). Build ONE batchUpdate:
   insertText at endIndex-1 of "\n\n<heading>\n<body>\n", then updateParagraphStyle over the
   heading paragraph only (start = endIndex-1+2, end = start + heading.length + 1), with
   writeControl.requiredRevisionId = the revision read at apply time and compared with the one in
   the fingerprint. A revision mismatch is "stale". Call assertAllowedDocumentRequests.
   Quiz review: the wrong questions (question text + your answer + the correct answer, capped
   at 20 and at 20,000 characters), not just a count.
4. Sheets: build rows on the server from quiz attempts. Use a field that exists on every attempt:
   store `exportedToSheet: { documentId, at }` in a SERVER-ONLY subcollection
   users/{uid}/googleExports/{attemptId_documentId}. The preview lists attempts without such a
   doc (query attempts for the document, then filter in code; add an index if needed). Cap at 200
   rows. Write the header row only when the tab is created. Row = [date, material title, quiz
   title, score, total, percent]. The apply marks exactly the attempt ids that were in the token
   (put the ids in the fingerprint), not "all unexported". Call assertAllowedSheetRequests inside
   createSheet. Use values.append with RAW and INSERT_ROWS.
5. Add the composite index for any quizAttempts query you keep, and remove the unused
   appendToSpreadsheet function.
6. documentText.ts: for Google Docs, skip text from the first paragraph that starts with
   "Study Lamp — " to the end, for AI extraction only. Keep the existing Sheets tab skip.
7. UI on the study-materials document page (googleNative documents only): menu "Add to Google
   Doc…" (Summary / Notes / Quiz review) or "Add to Google Sheet…" (Quiz results), opening
   ConfirmChangesDialog with the exact text or rows in a read-only box, the line "This adds to the
   end of your file. It does not change or delete anything already there.", Apply labelled "Add to
   Google Doc" / "Add to Google Sheet", default focus on Cancel, and visible errors (permission,
   trashed, changed since preview -> "Preview again", reconnect link).
8. Tests: apply without an accepted id writes nothing; a token for document A applied to B is
   rejected; replayed token -> 409; body text is ignored; stale revision -> nothing written;
   preview performs zero writes; Sheets rows only from unexported attempts; header only on a new
   tab; export markers only for ids in the token; 200 cap; allowlists reject other request types;
   documentText skips our section and tab.
```
**Test (throwaway Doc and Sheet):** preview shows the exact text and nothing is written; Apply appends once with one heading; Apply again with the same token fails; editing the Doc between preview and Apply gives "changed since preview" and writes nothing; Sheets rows appear once; the next summary ignores the appended section. Then remove the hotfix from D14.

---

# PART B — Finish what v6.1 started

## STEP Z4 — Finish Calendar two-way sync (W3)

**Fixes:** B8 to B11, B15, B16, B18. **Depends on:** Z1, Z3.

```
TASK Z4 — complete Calendar sync: all item kinds, safe pulls, settings UI, goal-change hooks.
Read first: everything Z1 and Z3 changed, src/lib/googleClient.ts, src/app/settings/google/page.tsx,
src/components/sync/ConfirmChangesDialog.tsx, src/lib/firestore/goals.ts, src/app/goals/page.tsx,
src/app/roadmap/components/RoadmapEditor.tsx, src/app/roadmap/page.tsx, firestore.rules (goals).

1. eventToGoalFields returns a union: {title, targetDate, completed} or {attention: reason}.
   Timed events, multi-day events (end != start + 1 day), cancelled events, invalid dates and
   too-long titles (use the goals rules limit; read the rules block) are "attention". Update
   the test that currently expects a timed event to be accepted.
2. Compare completed (decision D4): Study Lamp -> Google only. A completion change creates a
   push_update that adds or removes the "✓ " prefix. Removing the prefix in Google never re-opens
   the goal.
3. Item kinds: pull_create (events with no marker in the Study Lamp calendar -> "Import as goal",
   unticked, respects googleIgnored), remote_deleted with three choices (unlink = default,
   recreate, delete_goal = destructive, needs confirmedDestructive; the item is destructive ONLY
   for the delete_goal choice), orphans (mapping without a goal) reported only. Extend the
   resolution type: "use_study_lamp" | "use_google" | "skip" | "unlink" | "recreate" |
   "delete_goal" | "ignore".
4. Safe pulls. Writer for pull_update/pull_create/delete_goal uses the Admin SDK in a transaction:
   re-read the goal, compare the fields the user saw (from the fingerprint), update ONLY the pulled
   fields (title, targetDate), validate against the goals rules limits (the server bypasses the
   rules), set updatedAt, then save the mapping base and write a sync log entry. A changed goal
   gives "stale".
5. Settings UI. A Calendar card per connection: toggle "Sync goals with Calendar" (off by default)
   with a proper confirm dialog (not window.confirm) explaining the new calendar and that nothing
   is written until approved; last check; counts; "Check for changes" (opens ConfirmChangesDialog);
   per-item failures in plain language; a "What syncs" table (title and date: both ways; completion,
   notes, priority: Study Lamp -> Google only). Replace the disconnect window.confirm with the same
   dialog component. Never show "Synced" after a failed call.
6. Hooks. addGoal returns the new id. After add/update/toggle on the goals page and after addGoal in
   the two roadmap call sites, if the integration is enabled (cached flag), request a plan for that
   goalId and show a sonner toast "Google Calendar: N change(s) ready to review" with a Review action.
   On opening Goals: one read-only plan at most every 10 minutes, shown as a banner. Nothing is
   written without the dialog. Goal deletion is not synced. After a pull is applied, refresh the goals
   list (the page uses getDocs once; either add a refetch or switch to onSnapshot).
7. Status route: counts come from mapping docs (synced, failed, remoteDeleted, noDate, orphaned) with
   no Google call.
8. Tests: every kind end to end through plan -> gate -> writers with recording fakes; pull touches
   only changed fields; stale on local change; delete_goal needs the extra confirm; "ignore"
   persists; completion prefix both directions of the rule; attention reasons; Study Lamp's own write
   does not come back as a change on the next plan.
```
**Test:** the 11-point manual test from v6.1 §W3, plus: complete a goal (proposal adds ✓), remove ✓ in Google (no goal change), make a timed event in the Study Lamp calendar (shown as "can't be applied" with a reason), and change a goal after the review dialog opened (that item is skipped as "changed since preview").

---

## STEP Z5 — Finish Docs and Sheets import (W1)

**Fixes:** B17 and the missing UI and tests. **Depends on:** Z0.

```
TASK Z5 — finish W1.
Read first: src/lib/server/googleDrive.ts, src/app/api/drive/stream/[fileId]/route.ts,
src/components/documents/DocumentReaderSwitch.tsx, src/app/study-materials/page.tsx,
src/app/study-materials/[documentId]/page.tsx, src/lib/server/documentContent.ts,
src/lib/server/driveImportUtils.ts (+ test), src/lib/driveMime.ts (+ test).

0. DIAGNOSTIC (temporary): export one picked Google Doc and one Sheet through the existing
   connection; report status codes only. If 403/404, STOP.
1. exportFile: classify errors. 403 with reason "exportSizeLimitExceeded" (check the error reason,
   without logging the body) -> "too large". Other 403 -> "permission". 404 -> "not found/trashed".
   Return typed DriveApiError codes; the UI shows a different message for each.
2. Stream route: a non-native file with an export purpose -> 400. Move the dynamic imports to the top.
   Do not send Accept-Ranges for export responses.
3. UI: a "Google Doc" / "Google Sheet" badge on cards and the reader; "Open in Google" link built from
   the validated file id; "Last changed in Google" from the stored modifiedTime (update modifiedTime on
   open when it changed); sizeBytes null shows "—" (today it says "Size unavailable"; either is fine,
   be consistent).
2b. Picker: confirm the Word tab shows Docs and the Excel tab shows Sheets (the "All" tab already
    includes them).
4. Tests: partitionDriveFiles with native Doc/Sheet/Slides (Slides unsupported); nativeExportMime
   allowlist; signed-URL purposes (wrong purpose, tampered, expired); fetchDocumentBytes routing with an
   injected fetch; revision key with null md5 (changed modifiedTime refreshes the cache, unchanged does
   not); error classification.
```
**Test:** the W1 manual test from v6.1, plus: a Google Doc you no longer have access to shows a "permission" message, not "too large".

---

## STEP Z6 — Finish H1 and H2

**Fixes:** B19, B20, B21. **Depends on:** Z0.

```
TASK Z6 — finish route hygiene and cleanups.
Read first: the 10 routes listed in B19, src/lib/server/routeHelpers.ts (+ test),
src/lib/server/driveOwnership.ts, src/lib/server/driveThumbnails.ts,
src/app/api/documents/[id]/route.ts, src/app/api/drive/thumbnails/backfill/route.ts,
src/lib/server/documentText.test.ts.

1. Move to withAuthedRoute without changing response shapes: ai/system-connections/[id] and
   [id]/test (use admin: true), quiz-attempts (default preset; it currently has no limit), find-user
   (keep 20/min), youtube-duration, external-playlist, youtube-playlist, youtube-playlist-search,
   facebook-video, facebook-video/thumbnail. Do NOT touch drive/auth/callback, google/auth/callback,
   drive/stream, drive/thumbnail.
2. facebook-video: stop logging user URLs; log the status or error name only.
3. In createAuthedRoute, when admin is set, authenticate once (avoid verifying the token twice).
4. findDriveOwnedRecord: check whether driveOwnership.ts and driveThumbnails.ts still duplicate the
   owner lookup. If yes, extract it and use it in both; if not, say so and skip.
5. Orphaned thumbnails (B20): delete the thumbnail inline in DELETE /api/documents/[id] when no other
   record uses it; add a prune pass to POST /api/drive/thumbnails/backfill (or a sibling route) that
   deletes up to 50 unreferenced driveThumbs docs and returns {pruned, remaining}. A thumbnail used by
   two records must survive while one still uses it. Unit-test the pure "unreferenced ids" function.
6. Add the missing 10,000-row XLSX test (result capped at 5,000 rows per sheet and "Sheet: name" kept).
7. Optional: extract shared quiz/summary hooks from the two 590/647-line video pages. No behaviour change.
```
**Test:** `grep -L withAuthedRoute` over the routes lists only the four signed/redirect routes; deleting a PDF and running the backfill removes its thumbnail doc, while another record's thumbnail for the same file survives.

---

# PART C — Remaining v6.1 features (updated for the repaired core)

## STEP W4 — Tasks two-way sync

**Depends on:** Z1, Z3, Z4. Keep the v6.1 W4 behaviour (dedicated "Study Lamp" list, two-phase create with a notes marker, push-only notes and priority, two-way title/date/completed, independent fields). Amendments:

```
TASK W4 — Tasks adapter on top of the repaired sync core.
Read first: everything Z1, Z3 and Z4 changed; v6.1 section W4 (kept as the behaviour spec).

0. DIAGNOSTIC FIRST (status codes only): tasklists.insert; tasks.list with showCompleted,
   showHidden and showDeleted=true; tasks.patch with If-Match. Report whether deleted tasks are
   returned and whether a stale If-Match is rejected.
1. Pure tasksGoalMapping.ts: buildTask(goal) (due = `${targetDate}T00:00:00.000Z` only for a valid
   date; a re-opened goal sends status "needsAction" AND completed null; marker line
   "[studylamp:<goalId>]"), taskToGoalFields(task) (due -> isoDatePart; completed from status;
   notes never read back).
2. googleTasks.ts client with the same error classes, backoff and pagination as Z1. EVERY call takes
   the stored Study Lamp list id; nothing may list the user's other lists (add a test).
3. Mapping doc gets a `tasks` block next to `calendar` (same doc, same base shape plus completed).
   Build a TasksAdapter that implements the same interface as the Calendar adapter, so the planner
   and applier are shared, not copied.
4. Two-phase create (inside the apply step only): transaction sets state "creating" with a timestamp
   (younger than 2 minutes -> "busy"); insert; save taskId; state "synced". A mapping stuck in
   "creating" for over 2 minutes: list all pages and ADOPT the task whose notes contain the marker.
5. Extend PATCH /api/google/connections/[id] with {tasks:{enabled}} and plan/apply with
   targets ("calendar" | "tasks")[] (default: every enabled target; one token can cover both).
6. UI: a Tasks card with the same pattern as the Calendar card, independent toggle, and the
   "What syncs" table.
7. Tests: as in v6.1 W4 plus: preview performs zero writes, replayed token rejected, only the stored
   list id is ever used, independent toggles, completion in both directions, due removed in Google
   shows "Target date -> (none)".
```
**Test:** the nine-point manual test from v6.1 §W4.

---

## STEP W5 — Reconcile, history, explicit removal, docs

**Depends on:** Z4, W4. Keep v6.1 W5 (orphan list, history, remove with a plan token and `confirmCount`, disconnect with the optional removal, no cron). Amendments:

```
TASK W5 — safe control and documentation.
Read first: the sync code, src/lib/server/googleSyncLog.ts (now persisted by Z3), docs/*.md.

1. Orphans: status route lists up to 50 mapping docs with no goal (titleSnapshot).
2. History: GET /api/google/sync/history?cursor= returns the newest 50 entries from googleSyncLog.
   Settings shows a collapsible "Recent changes" list. Read-only; no undo button.
3. Removal: POST /api/google/sync/remove/preview {target, scope:"orphans"|"all"} (read-only, token
   scope "remove") and POST /api/google/sync/remove {planToken, confirmCount}. Deletes ONLY remote ids
   in this user's mapping docs, chunks of 25 with backoff; 404/410 = already gone; stale confirmCount
   -> 409 with the fresh count; one-time token (Z3). Writes a log entry per removal.
4. Disconnect dialog: an UNCHECKED option "Also remove N events/tasks Study Lamp created", executed
   through the same preview and token BEFORE the stored token is deleted.
5. No cron. Document how a daily Vercel Cron could run the read-only plan and set a "changes waiting"
   flag (CRON_SECRET), and leave it unimplemented.
6. Docs: finish docs/google-workspace.md (usage, data lifecycle table from v6.1, troubleshooting:
   invalid_grant, 7-day token expiry in Testing mode, rate limits, deleted calendar/list, "changed since
   preview"); update docs/deploy.md (APIs to enable: Calendar, Tasks, Docs, Sheets) and docs/security.md
   (plan token signing and its "sync-plan.v1|" prefix, one-time tokens, which collections are server-only).
7. Tests: removal touches only mapped ids; confirmCount mismatch -> 409; no token -> 400; 404 handled;
   orphan detection; history paging; disconnect with and without the option.
```

---

# PART D — Features (unchanged scope from v6.1; specify in detail when you reach them)

| Step | Goal | Acceptance test |
|---|---|---|
| **F1** Streak and activity ledger | Record one activity entry per study day (watch, read, quiz) in the user's **local** date (use `isoDate.ts`, not `toISOString()`). Compute the streak from the ledger. Fix B23. | Study at 00:30 Dhaka time → today counts as today; skipping a day resets the streak; the dashboard shows the new value. |
| **F2** Today Plan | One screen listing what to do today: goals due or behind pace, resume-eligible videos and documents, due reviews. Uses existing `goalPace`, `resumeGroups`, `reviewUtils`. | With three goals (one overdue) and one half-watched video, the plan shows them in a sensible order and each item opens the right page. |
| **F3** Flashcards from quiz mistakes | Build flashcards from wrong answers in saved quiz attempts, with a simple spaced-review schedule. | Fail two quiz questions → two cards appear; marking one "known" delays it. |
| **F4** AI study resources | Generate study guides, glossaries or practice questions from a document or video (the `en`/`bn` language setting applies). Tolerates Google-native documents from Z5. | A Google Doc produces a guide in the selected language, cached by revision. |
| **F5** Backup v2 | Back up goals, notes, summaries, quiz attempts and (decide explicitly) sync mappings. **Never** back up credentials. Restore must not re-create remote items. | Back up, delete a goal, restore → the goal returns and no Google write happens. |
| **F6** Export | Markdown and Anki TSV export of notes, summaries and flashcards. | The Anki file imports cleanly; Markdown opens in any editor. |
| **F7** Next.js major upgrade | Move off 14.2.x after all features are done. One PR, no features. | `tsc`, tests and a production build pass; smoke-test login, Drive, Google settings. |
| **F8** PWA | Manifest, icons, install prompt and an offline fallback page. No caching of authenticated API responses. | Lighthouse PWA checks pass; offline shows the fallback page. |

---

## 5. Definition of done (every step)

1. `npx tsc --noEmit` has zero errors, `npm test` is green, `npm run lint` runs.
2. Every new route has a test for the 401, the validation failure and one success path.
3. Every Google integration has a test proving the preview makes no write (Rule 15) and a test using real id shapes (D13).
4. The manual test in the step passes on a non-production Google account.
5. The step's report lists files changed, the real command output, and anything uncertain.
