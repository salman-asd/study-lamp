# Study Lamp — Roadmap v4.1

Supersedes v4. Built after a much deeper read of `src_1.zip` than the first pass.

## 0. What I actually read (honest scope)

**Read in full (logic, comments stripped):** `types/index.ts`, `firestore.rules`, every file in `lib/server/`, all of `lib/ai/` (service, prompts, providers, transcript), the Firestore data layer (`personalPlaylists`, `userVideoState`, `users`, `notifications`, `transcripts`, `personalDocuments`, `quizAttempts`), the review/pace/recommendation/mastery/dashboard/notification utils, the Drive routes and client, the AI / quiz / document / Facebook / playlist API routes, `AuthProvider`, `RequireAuth`, the tour state logic, and the logic parts (not the markup) of the video page, the document page, the dashboard, `Header`, `VideoPlayer`, `DriveImportPanel` and the Drive/backup settings pages.

**Not read:** JSX markup, about 25 pages (goals, roadmap, playlists list/detail, library, onboarding, shared, most admin pages, AI settings), about 40 components, the `ui/` primitives, and the 43 test files (I only listed their names). Three things are not in the zip at all: `next.config`, `scripts/` (the test runner) and `public/`. That means I **cannot verify security headers, CSP, or how tests run**.

Anything unverified is marked **(verify)**. I did not run the app, a build or the tests.

## 1. New findings from the deeper read (these change the roadmap)

| # | Finding | Severity |
|---|---|---|
| F1 | **Quiz attempts probably never save.** `src/app/api/quiz-attempts/route.ts` runs on the server but writes with the *client* Firebase SDK (`addDoc(collection(db, …))`). On the server that SDK has no signed-in user, so your Firestore rules (`isSelf(uid)`) should reject the write. Both call sites ignore the failed response. If true, mastery, due reviews and the "Review due" card are always empty. **Check:** look for a `quizAttempts` collection in Firestore. | **High (verify)** |
| F2 | **Streak is shown but never computed.** The dashboard reads `profile.stats.currentStreakDays`, but `recomputeUserStats` is only called from the *admin user page*. It also uses UTC days, only reads shared-video states (not personal videos), and `totalWatchTimeSeconds` is never filled. | High |
| F3 | **SSRF in `/api/facebook-video`.** If the URL isn't a recognised Facebook URL, the route calls `resolveFacebookRedirectUrl(rawUrl)`, which does a server-side `fetch` of any URL the user typed. (The thumbnail route does check the host first; this one doesn't.) | High |
| F4 | **Data loading is N+1.** `useAllVideos` loads every shared playlist's videos one after another, plus every personal playlist's videos, and `refresh()` reloads everything after each toggle. Five pages use it (dashboard, favorites, priority, watch-later, continue-learning). This is a likely part of your "Drive is slow" feeling, besides the stream proxy. | Medium |
| F5 | **Drive player doesn't save progress on tab close.** The YouTube player flushes on `pagehide`/`visibilitychange`; `DriveVideoPlayer` only saves every 60 s and on pause. | Medium |
| F6 | **One encryption key protects both AI keys and Drive refresh tokens** (`aiEncryption.ts` is used by `driveConnections.ts`). There is no key versioning, so rotating the key breaks both. | Medium |
| F7 | **Backup is incomplete.** It saves playlists, videos, notes, summaries, goals and quiz attempts only. Missing: transcripts, bookmarks, categories, roadmaps, document metadata, video states. Restore does one awaited write per document, and doc IDs from the file are used unchecked. | Medium |
| F8 | **AI plumbing blocks the new features.** The same 5-provider `switch` is copy-pasted 6 times in `aiService.ts`. `maxOutputTokens` is fixed at 1800 and temperature at 0.7 even for JSON output. The source hash is a 32-bit FNV hash with no prompt version. No AI route sets `maxDuration` (likely 10 s default on Vercel Hobby **(verify)**). Document routes return raw `err.message` on 500. | Medium |
| F9 | **AI quota day uses UTC**, so for Dhaka it resets at 6 am local. | Low |
| F10 | **Gemini key is sent in the URL query** (`?key=`). Server-side only, but it can land in logs; Google also accepts a header. | Low |
| F11 | `/api/find-user` lets any signed-in user test whether an email has an account (needed for sharing, but needs a rate limit). | Low |
| F12 | The HTML sanitiser (`summaryHtml.ts`) is regex-based. It looks safe for now (attributes stripped, markdown path escapes HTML) but is fragile. | Low |
| F13 | Document quizzes are generated but **attempts are never recorded**, and their cache hash ignores the extracted text. | Low |

**Corrections to my earlier verdicts:** Phase 17 (backup) works but is *incomplete and unvalidated* (F7). Phase 8 (streak) isn't "build new", it's "fix what's half there" (F2). Everything in my first review about Drive (folder import risk, `?idToken=`, per-request Google calls, OAuth state) still stands.

## 2. Decisions

- **Region:** keep Firestore in Delhi (`asia-south2`; it can't be changed). Put Vercel functions in Mumbai (`bom1`), Singapore as backup. Never the US.
- **PDF viewer:** **EmbedPDF** (MIT licence; PDFium engine Apache-2.0; search, zoom, thumbnails, annotations, virtualised scrolling). Fallback: react-pdf. Native `<iframe>` only as "Open / Download".
- **Word:** `docx-preview`. **Excel:** SheetJS to a React table (never inject HTML). **PowerPoint:** Drive `/preview` iframe plus slide-text outline plus download (no good free in-browser renderer exists).
- **Study Materials tabs:** All / PDF / Word / PowerPoint / Excel, URL-synced, with Sidebar sub-links (Step S11).
- **Streak design:** a per-day activity ledger (`users/{uid}/activityDays/{YYYY-MM-DD}`) in the user's timezone. Streak, weekly report and "time watched" all come from it (Step S19).
- **Security** is spread over S1, S2, S5, S10, S13 and S20, and each says what it fixes.

## 3. Roadmap at a glance

| ID | Step | Depends on |
|---|---|---|
| **S0** | Fix quiz-attempt saving (F1) and record per-question answers | none |
| **S1** | Secrets and dependency hygiene | none |
| **S2** | Security hardening (SSRF, validation, OAuth nonce, headers, key versioning, rules) | S1 |
| **S3** | Region + timing instrumentation | S2 |
| **S4** | Google token cache | S3 |
| **S5** | Signed stream/thumbnail URLs | S4 |
| **S6** | Stored thumbnails + remove per-request writes | S4 (S5 for URL shape) |
| **S7** | Faster data loading (`useAllVideos`) + Drive player progress flush | none (do before S16) |
| **S8** | Drive folder import + multi-select + typed pickers | S2 |
| **S9** | Fast bulk import | S8 |
| **S10** | Reliable text extraction + cache | S1 |
| **S11** | Study Materials tabs | S5, S8 |
| **S12** | PDF reader (EmbedPDF) | S11, S5 |
| **S13** | Word, Excel and PowerPoint viewers | S11, S5, S10 |
| **S14** | Reader extras (resume, notes, highlights) | S12, S13 |
| **S15** | AI service refactor + language (EN/BN/AR) | none |
| **S16** | Today Plan | S0, S7 |
| **S17** | AI study resources (video + documents) | S15, S10 |
| **S18** | Flashcards from mistakes | S0 |
| **S19** | Streak + weekly report | S7 |
| **S20** | Backup completeness + fast, validated restore | S2 |
| **S21** | Next.js major upgrade | S14 done |
| **S22** | PWA | S5, S21 |
| **S23** | Export (Markdown / Anki) | S17 (S18 optional) |

```
S0 ──────────────────────────────► S16 ◄── S7 ──► S19
S0 ──► S18                                   
S1 ─► S2 ─► S3 ─► S4 ─► S5 ─► S6            S15 ─► S17 ─► S23
            S2 ─► S8 ─► S9                  S10 ─► S17
            S8 + S5 ─► S11 ─► S12 ─► S14    S10 + S11 ─► S13 ─► S14
            S2 ─► S20
S14 ─► S21 ─► S22 (also needs S5)
```

**Order:** S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12 → S13 → S14 → S15 → S16 → S18 → S17 → S19 → S20 → S21 → S22 → S23.
Parallel-safe groups: {S0, S1, S7, S15}, {S16, S18, S19} after their dependencies.

---

## 4. How to use the prompts

Paste the **Global Rules** block once per session, then **one step prompt at a time**. Finish the step's test before starting the next.

### Global Rules block

```
You are working in an existing Next.js 14 App Router project, Study Lamp
(Firebase Auth + Firestore, Tailwind, Radix UI, sonner, driver.js, Tiptap).
Source is under src/. Server-only code is in src/lib/server/ and uses the
Firebase ADMIN SDK (adminDb/adminAuth from src/lib/server/firebase-admin.ts).
Client code uses the Firebase CLIENT SDK (src/lib/firebase.ts). API routes
authenticate with `Authorization: Bearer <Firebase ID token>` through
requireAuthenticatedUid (src/lib/server/requireAuth.ts).

Rules:
1. READ FIRST. Open every file listed under "Read first". If a path doesn't
   exist, search the repo; never invent paths or APIs.
2. Smallest change that satisfies the task. No unrelated refactors, renames
   or reformatting.
3. NEVER use the client Firebase SDK inside src/app/api/** or src/lib/server/**
   (it has no auth on the server). Use the Admin SDK there.
4. Never print, log, commit or paste secrets. Server secrets never get a
   NEXT_PUBLIC_ prefix.
5. Every API route authenticates BEFORE touching data (or verifies a signature
   where the task says so), validates every input (type, length, charset), and
   returns generic error messages (log details server-side only).
6. Any NEW Firestore collection needs explicit rules in firestore.rules
   (default is deny). Server-written data: `allow write: if false` for clients.
   Add size/shape validation for anything clients may write.
7. Reuse existing UI patterns (src/components/ui/*, sonner toasts, Skeleton).
8. New libraries: check current version + licence on npm, pin a compatible
   version, state both in your answer. Prefer a maintained library over a
   hand-written parser for binary formats.
9. Add unit tests for pure logic (`npm test` runs scripts/runTests.mjs; copy
   the pattern of an existing *.test.ts).
10. Run `npx tsc --noEmit`, `npm run lint`, `npm test` and report honestly.
    If you cannot run something, say so.
11. End with: files changed / manual test steps / anything you were unsure of.
```

---

## STEP S0 — Fix quiz-attempt saving and record per-question answers

**Depends on:** none. **Fixes:** F1, F13 (partly). **Why first:** the dashboard mastery, "Review due", Today Plan (S16) and Flashcards (S18) all read quiz attempts.

**First check (you):** open Firestore → `users/{yourUid}/quizAttempts`. If it is empty after you have taken quizzes, F1 is confirmed.

**Prompt:**
```
TASK S0 — make quiz attempts actually save, and store answers per question.
Read first: src/app/api/quiz-attempts/route.ts (uses the CLIENT SDK on the
server — the bug), src/app/video/[videoId]/page.tsx and
src/app/playlists/[playlistId]/[videoId]/page.tsx (both POST to it inside
handleQuizSubmit and swallow errors), src/types/index.ts (QuizAttempt),
src/lib/firestore/quizAttempts.ts, src/lib/reviewUtils.ts,
src/lib/masteryUtils.ts, firestore.rules (quizAttempts block).

1. Rewrite the route with the Admin SDK (adminDb, FieldValue.serverTimestamp()):
   - ignore any userId in the body; use the authenticated uid.
   - validate: videoId string 1-200 chars; totalQuestions integer 1-50;
     score integer 0..totalQuestions; categoryId optional string <=200;
     playlistId optional string <=200; source optional "shared"|"personal"|"document";
     answers optional array (max 50) of {questionId (<=50 chars),
     chosenOptionId (<=50 chars), wasCorrect boolean}.
   - put the pure validator in src/lib/quizAttempt.ts
     (validateQuizAttemptInput(body) -> {ok:true,value}|{ok:false,error}) with
     unit tests (valid, score>total, non-integer, too many answers, bad ids).
   - write to users/{uid}/quizAttempts, return {id} with 201.
2. Types: extend QuizAttempt with optional playlistId, source, answers
   (QuizAttemptAnswer[]). Old attempts without answers must keep working.
3. Both pages: send playlistId, source ("personal" on the personal route),
   and answers built from selectedAnswers/quizQuestions. Stop swallowing
   failures silently: if !res.ok show a toast "Couldn't save your quiz result"
   (the quiz result itself still shows).
4. Documents: on src/app/study-materials/[documentId]/page.tsx, make the quiz
   gradable like the video quiz (select an option, Submit, score) and post an
   attempt with source "document" and videoId = `d_${documentId}`.
5. Rules: leave the existing quizAttempts rule (admin SDK bypasses rules), but
   add `request.resource.data.totalQuestions <= 50` and keep client writes
   possible only for the owner.
```
**Test:** take a quiz on a shared-playlist video, a personal video and a document → three docs appear in Firestore with `answers`; dashboard "Top mastery" shows data; a deliberately bad POST (score 9 of 5) returns 400.

---

## STEP S1 — Secrets and dependency hygiene

**Depends on:** none.

**Manual actions (you):** if the zip or repo was shared or pushed anywhere, rotate: Firebase Admin private key, Google OAuth client secret, `GOOGLE_DRIVE_OAUTH_STATE_SECRET`, Facebook app secret, YouTube API key, and the encryption key (see S2 for how to rotate that one safely). Restrict the Picker API key by HTTP referrer and by API. Put all secrets in Vercel env vars.

**Prompt:**
```
TASK S1 — repo hygiene.
Read first: package.json, tsconfig.json, firebase.json, repo root listing.

1. Create .gitignore (Next.js standard) ignoring .env, .env.*, !.env.example,
   node_modules, .next, .vercel, *.pem, service-account*.json, coverage.
2. Create .env.example with every variable name found via grep process.env
   (empty values, one-line comment each, mark server-only vs public).
   Never copy values from .env.local.
3. package.json: move firebase-admin to dependencies; bump next and
   eslint-config-next to the LATEST 14.2.x patch (not a new major).
4. src/lib/server/firebase-admin.ts: when FIREBASE_CLIENT_EMAIL or
   FIREBASE_PRIVATE_KEY is missing and NODE_ENV === "production", throw a clear
   error instead of silently initialising a "demo-project" app.
5. npm install; run tsc, lint, test, `next build`. Fix only upgrade breakages.
Report exact versions installed.
```
**Test:** `next build` passes; no `.env*` tracked by git; production build fails loudly if Admin credentials are missing.

---

## STEP S2 — Security hardening

**Depends on:** S1. **Fixes:** F3, F6, F8 (error leaks), F9, F10, F11 and the Drive issues from my first review.

**Prompt:**
```
TASK S2 — security hardening. Do the numbered items as separate commits.
Read first: src/lib/server/googleDrive.ts, src/lib/server/driveConnections.ts,
src/lib/server/driveOwnership.ts, src/lib/server/requireAuth.ts,
src/lib/server/aiEncryption.ts, src/lib/server/aiQuota.ts,
src/lib/video-platforms/facebookGraph.ts, src/app/api/facebook-video/route.ts,
src/app/api/drive/**/route.ts, src/app/api/documents/[id]/*/route.ts,
src/app/api/find-user/route.ts, src/lib/ai/providers/gemini.ts, firestore.rules.

1. SSRF (F3): in facebookGraph.ts rewrite resolveFacebookRedirectUrl to
   (a) require https, (b) allow only hosts facebook.com, www.facebook.com,
   m.facebook.com, web.facebook.com, fb.watch, fb.com and their subdomains,
   (c) follow redirects MANUALLY (redirect:"manual", max 5 hops) re-checking the
   host on every hop, (d) 5 s timeout via AbortController, (e) never return a
   non-allowlisted final URL. Call it only after the allowlist check in
   /api/facebook-video as well. Update/add tests in facebookGraph.test.ts
   (internal IP, http, evil.com redirect, valid fb.watch).
2. Drive IDs: add assertDriveId(id) (/^[A-Za-z0-9_-]{10,128}$/) in
   googleDrive.ts and call it on every fileId/folderId before use in a URL or
   a Drive `q` query (listFolderFiles interpolates folderId). Validate
   connectionId (/^[A-Za-z0-9]{10,40}$/) in every Drive route. 400 on failure.
3. OAuth state binding: in /api/drive/auth/state add a random 32-byte nonce to
   the signed state and set it in an httpOnly, Secure, SameSite=Lax cookie
   "sl_drive_nonce" (Path=/api/drive/auth, Max-Age=600). The callback must
   require the cookie to equal the nonce in the verified state, then clear it.
   Unit-test sign/verify (valid, expired, tampered, wrong nonce).
4. Response headers on stream/thumbnail: X-Content-Type-Options: nosniff,
   Referrer-Policy: no-referrer; force Content-Disposition: attachment unless
   the type is video/*, application/pdf or image/*.
5. Upload session: allowlist MIME types (video/*, pdf, the 3 OOXML types), size
   cap (default 2 GB constant, send X-Upload-Content-Length), sanitise the
   file name (no path separators/control chars, <=200 chars).
6. Rate limiting: src/lib/server/rateLimit.ts (in-memory per-uid sliding window,
   note per-instance only). 60/min default; 10/min for drive auth/state and
   upload/session; 20/min for /api/find-user (F11).
7. Encryption key rotation (F6): in aiEncryption.ts prefix new ciphertexts with
   "v1:", keep decrypting un-prefixed legacy values, and support an optional
   AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS: decrypt tries current then previous.
   Add scripts/reencrypt.ts (tsx) that re-encrypts aiConnections,
   systemAiConnections and driveConnections with the current key. Document the
   rotation procedure in docs/security.md. (It protects BOTH AI keys and Drive
   refresh tokens.)
8. AI quota day (F9): compute `today` in a QUOTA_TIMEZONE (default "Asia/Dhaka")
   with Intl.DateTimeFormat("en-CA",{timeZone}) instead of toISOString(); update
   aiQuota.test.ts.
9. Gemini (F10): send the key in the `x-goog-api-key` header, not the URL, in
   generateWithGemini and validateGeminiConnection.
10. Error leaks (F8): src/app/api/documents/[id]/summary and quiz routes must
    not return err?.message on 500; return the generic text.
11. Rules: make driveFileId and driveConnectionId immutable on update for
    personalDocuments and personalPlaylists/*/videos; remove the duplicated
    quiz match blocks; do not widen anything.
12. Drive upstream logging: never log response bodies from Google token
    endpoints; log status codes only.
13. Backup payload hardening is in S20 (not here).
```
**Test:** unit tests pass; `POST /api/facebook-video?url=http://169.254.169.254/` returns no fetch; Drive routes reject `../` ids; the OAuth callback fails when replayed from another browser; rotating the key with the script keeps AI and Drive working.

---

## STEP S3 — Region and timing

**Depends on:** S2.

**Prompt:**
```
TASK S3 — run functions next to the database and measure.
Read first: firebase.json, firestore.indexes.json, repo root (vercel.json?).

1. Create/merge vercel.json: { "regions": ["bom1"] } (Firestore stays in
   asia-south2/Delhi, which can't change).
2. Add `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
   to every src/app/api/drive/**/route.ts. Add `export const maxDuration = 60;`
   to the stream route and to every AI route (src/app/api/ai/**,
   src/app/api/documents/[id]/summary|quiz) — adjust to the plan limit and
   note it in a comment.
3. src/lib/server/timing.ts: when DRIVE_TIMING=1 log ms spent in auth verify,
   ownership, token fetch and upstream fetch. Use it in the stream and
   thumbnail routes.
4. docs/deploy.md: Firestore stays in Delhi, functions in bom1, how to change
   the Vercel region, which plan limits apply.
```
**Test:** deploy; record per-request ms for one seek with `DRIVE_TIMING=1` (this is your baseline for S4–S6).

---

## STEP S4 — Google access-token cache

**Depends on:** S3.

**Prompt:**
```
TASK S4 — cache Google access tokens.
Read first: src/lib/server/driveConnections.ts (getAccessTokenForConnection),
src/lib/server/googleDrive.ts (refreshAccessToken).

Add a module-level Map<`${uid}:${connectionId}`, {token, expiresAt}> plus a Map
of in-flight refresh promises (same key) so concurrent requests share one
refresh.
- Hit (expiresAt - 60 s > now): return the token with NO Firestore read/write.
- Miss: existing flow (read doc, refuse status "invalid", decrypt, refresh),
  store, delete the in-flight entry in finally.
- Invalidate on: disconnect, marking invalid, and any Google 401 (export
  invalidateAccessToken and retry the Google call ONCE).
- Cap size (500, evict oldest). Never persist or log tokens.
- Make the refresh function injectable and unit-test the cache.
- Write lastUsedAt at most once per 15 minutes per connection.
Add a comment: per-instance cache; revoking at Google invalidates at worst
after natural expiry.
```
**Test:** with timing on, the token step is ≈0 ms after the first request; Firestore writes drop while watching a video.

---

## STEP S5 — Signed stream and thumbnail URLs

**Depends on:** S4. **Fixes:** the `?idToken=` leak (appears in 4 client call sites) and the 1-hour token expiry on long videos.

**Prompt:**
```
TASK S5 — signed URLs replace ?idToken=.
Read first: src/app/api/drive/stream/[fileId]/route.ts,
src/app/api/drive/thumbnail/[fileId]/route.ts, src/lib/server/requireAuth.ts,
src/lib/server/driveOwnership.ts, src/lib/driveClient.ts,
src/components/video/VideoPlayer.tsx (DriveVideoPlayer),
src/app/study-materials/[documentId]/page.tsx (DocumentPreview + downloads),
src/components/video/VideoThumbnail.tsx.

1. New server env DRIVE_URL_SIGNING_SECRET (document in .env.example).
2. src/lib/server/driveSignedUrl.ts: signDriveUrl({uid,fileId,connectionId,
   purpose:"stream"|"download"|"thumb",ttlSec}) -> {exp,sig}; sig = base64url
   HMAC-SHA256 over `v1|purpose|uid|connectionId|fileId|exp`; verifyDriveUrl uses
   timingSafeEqual and rejects expired. TTLs: stream 6 h, download 10 min,
   thumb 24 h. Unit-test valid/expired/tampered/wrong-purpose/wrong-uid.
3. POST /api/drive/sign (Bearer auth): body {items:[{fileId,connectionId,
   purpose}]} up to 50. Validate ids (assertDriveId), run the ownership check
   ONCE per item, return {urls:[...]} (so a thumbnail grid needs one call).
4. Stream + thumbnail routes: authenticate ONLY by verifyDriveUrl (query: c,u,e,p,s).
   No Firebase verify, no ownership query. Keep Range forwarding.
   Thumbnails: Cache-Control private, max-age=86400, immutable.
5. Remove the idToken query fallback from requireAuth.ts entirely (grep for all
   users first) and update every client call site.
6. Client: driveClient.getSignedDriveUrls(idToken, items) with an in-memory cache
   refreshed 5 min before expiry. Update DriveVideoPlayer, DocumentPreview and
   the Download buttons, VideoThumbnail for drive items.
7. Comment on revocation: URLs live until exp; a disconnected connection still
   stops playback because Google rejects the revoked token.
```
**Test:** DevTools shows no `idToken=` anywhere; a copied stream URL works in a private window but fails when any parameter is changed; a >1 h watch session seeks without errors.

---

## STEP S6 — Stored thumbnails

**Depends on:** S4 (S5 for the URL shape).

**Prompt:**
```
TASK S6 — fetch a Drive thumbnail ONCE at import and serve it from our own copy.
Read first: src/lib/server/driveImport.ts, src/app/api/drive/import/file/route.ts,
src/app/api/drive/import/folder/route.ts, src/app/api/drive/thumbnail/[fileId]/route.ts,
src/components/video/VideoThumbnail.tsx, src/hooks/useThumbnailHealing.ts,
src/lib/thumbnailHealing.ts.

1. At import (file + folder) fetch meta.thumbnailLink with a size suffix (=s320)
   server-side. Store it in Firebase Storage at users/{uid}/driveThumbs/{fileId}.jpg
   via the Admin SDK (storage rules: deny all client access). If Storage isn't
   enabled, store a base64 data URL (<=40 KB) in a `thumbnailData` field on the
   doc and say which you chose.
2. The thumbnail route serves the stored copy; only if missing does it fetch
   from Google AND store it (self-healing for old imports).
3. Folder import fetches thumbnails with concurrency 5 and never fails the import
   if one thumbnail fails.
4. POST /api/drive/thumbnails/backfill (Bearer): processes up to 25 existing
   drive videos/documents per call and returns the remaining count; add a small
   "Refresh thumbnails" button in Settings → Google Drive that loops until 0.
5. Documents (PDF/Word/Slides) get thumbnails the same way.
```
**Test:** import a folder → thumbnails load in <100 ms from our route and from cache on reload.

---

## STEP S7 — Faster data loading and Drive player flush

**Depends on:** none (do before S16/S19). **Fixes:** F4, F5.

**Prompt:**
```
TASK S7 — remove the N+1 loading and save Drive progress on tab close.
Read first: src/hooks/useAllVideos.ts (the sequential `for (const p of pls)
await listVideos(p.id)` loop and listAllPersonalVideos), the 5 pages that use it
(grep "useAllVideos": dashboard, favorites, priority, watch-later,
continue-learning), src/lib/firestore/personalPlaylists.ts,
src/lib/videoActions.ts, src/components/video/VideoPlayer.tsx.

1. In useAllVideos: load shared playlists' videos with Promise.all (concurrency
   <=8) instead of sequentially.
2. Create src/components/video/AllVideosProvider.tsx (React context mounted
   inside AppShell/RequireAuth) holding {videos, playlists, loading, refresh,
   patchVideo}. useAllVideos becomes a thin hook over it, so navigating between
   dashboard/favorites/priority/watch-later/continue-learning does NOT refetch.
   Stale-while-revalidate: show cached data immediately, refetch if older than
   2 minutes or on window focus.
3. Replace `refresh()` after favourite/watch-later/priority/watched toggles
   with an optimistic patchVideo(videoKey, patch) that updates local state, and
   revert on error. Keep refresh() for import/delete.
4. Add a `videoKey` helper (`${source}:${playlistId}:${id}`) because a shared
   video id and a personal video id could collide.
5. In DriveVideoPlayer add the same flush as the YouTube path: on `pagehide`,
   `beforeunload` and `visibilitychange === "hidden"` call onProgress(current,
   duration, true).
6. addPersonalVideo and findDuplicatePersonalVideoUrl read the whole collection
   to count/compare; use a count() aggregate / a where("videoUrl","==",url)
   query instead.
7. Measure before/after: number of Firestore reads when opening the dashboard
   (Firebase console usage tab) and report both numbers.
```
**Test:** open dashboard → favorites → watch-later: only the first load shows a spinner; read count for a second page visit is near zero; close the tab mid-Drive-video and reopen: resume position is within ~5 s.

---

## STEP S8 — Drive folder import, multi-select and typed pickers

**Depends on:** S2. **Why:** with the `drive.file` scope, picking a folder probably does **not** grant access to the files inside it **(verify)**; the picker is also single-select.

**Prompt:**
```
TASK S8 — folder import that works, multi-select, typed picker views.
Read first: src/components/drive/DrivePickerButton.tsx,
src/components/drive/DriveImportPanel.tsx, src/app/api/drive/import/folder/route.ts,
src/lib/server/googleDrive.ts (listFolderFiles, SUPPORTED_DOCUMENT_MIME_TYPES).

1. Diagnostic first (temporary logs): after a folder is picked, how many
   children does listFolderVideoFiles return, and any 403/404? Report it.
2. Move MIME constants to src/lib/driveMime.ts shared by client and server.
3. DrivePickerButton gets `kinds: ("video"|"pdf"|"docx"|"pptx"|"xlsx")[]` and
   builds Picker views with setMimeTypes from them (fix the current code that
   builds a views array but only adds views[0] and views[1]). Enable
   Feature.MULTISELECT_ENABLED; onPicked receives an array.
4. If children are NOT accessible: after the user picks a folder, reopen the
   Picker scoped to it — new DocsView(ViewId.DOCS).setParent(folderId)
   .setMimeTypes(types) with multi-select, titled "Select the files to import
   from <folder> (Ctrl/Cmd+A selects all)". Selecting files in the Picker is
   what grants per-file access. Send the chosen ids to a new
   POST /api/drive/import/files {connectionId, fileIds[], folderName,
   mode:"new_playlist"|"existing_playlist", playlistId?} (uses S9's bulk logic).
5. Keep the scope as drive.file. Do NOT widen to drive.readonly (Google's
   restricted-scope security assessment).
6. Upload `<input accept>` uses the same constants.
```
**Test:** pick a folder with 3 videos → 3 videos in a new playlist; select 5 files at once → 5 imports; on the PDF tab the Picker shows only PDFs.

---

## STEP S9 — Fast bulk import

**Depends on:** S8.

**Prompt:**
```
TASK S9 — rewrite bulkAddDriveVideosAdmin (and the documents equivalent) in
src/lib/server/driveImport.ts.
Today: one duplicate query + one count query + one playlist update PER video.
1. One query loads existing driveFileId values for the target playlist into a Set.
2. Filter duplicates in memory.
3. Write with Admin WriteBatch in chunks of 400, assigning `order` from one
   starting count.
4. Update the playlist doc ONCE (sortOrder append, videoCount, totalDuration,
   summaryStale, updatedAt).
5. Use the metadata already returned by the list call (FILE_FIELDS); do not call
   getFileMetadata per file.
6. Unit-test the pure part (dedupe + order assignment).
```
**Test:** import 100 files in a few seconds; re-import adds 0.

---

## STEP S10 — Reliable text extraction and cache

**Depends on:** S1. Needed by S13 and S17.

**Prompt:**
```
TASK S10 — replace fragile extraction in src/lib/server/documentText.ts.
Read first: documentText.ts, documentContent.ts, zipReader.ts, types/pdf-parse.d.ts,
src/app/api/documents/[id]/summary/route.ts and quiz/route.ts, src/lib/server/quiz.ts.

1. PDF: replace pdf-parse@1 (unmaintained) with `unpdf` (serverless-friendly).
   A PDF with no text layer returns the clear message "This looks like a scanned
   PDF; text extraction needs OCR".
2. DOCX: `mammoth` extractRawText.
3. XLSX: SheetJS in read-only text mode, installed from the official SheetJS CDN
   tarball (NOT the stale npm `xlsx@0.18.x`; check docs.sheetjs.com). Output
   "Sheet: name" headers + tab-separated rows, cap 5,000 rows/sheet.
4. PPTX: keep the zip approach but split by <a:p>, include notesSlides, order
   slides via presentation.xml relationships (not file-name numbers).
5. Safety: input <= 50 MB; extracted text <= 200,000 chars; zipReader caps
   (<=2,000 entries, <=200 MB total uncompressed) against zip bombs; read each
   entry's declared uncompressed size before inflating.
6. Cache: save extracted text under users/{uid}/personalDocuments/{id}/content/text
   (chunk <900 KB) with the Drive md5Checksum/modifiedTime (add both to
   FILE_FIELDS). extractPersonalDocumentText returns the cache while the
   checksum is unchanged. Rules: content subcollection Admin-only.
7. Document quiz cache (F13): buildVideoSourceHash for documents must include the
   extracted text hash so a changed file invalidates the cached quiz.
8. Tests with tiny generated fixtures per format. Remove pdf-parse and its .d.ts.
```
**Test:** summary + quiz for one PDF, DOCX, PPTX and XLSX; the second generation doesn't re-download from Drive.

---

## STEP S11 — Study Materials tabs (PDF / Word / PowerPoint / Excel)

**Depends on:** S5, S8.

**Prompt:**
```
TASK S11 — type tabs for Study Materials, like the video area.
Read first: src/app/study-materials/page.tsx, src/components/layout/Sidebar.tsx
(flat list; "Study Materials" has no tour id), src/components/ui/tabs.tsx,
src/lib/firestore/personalDocuments.ts, src/types/index.ts (DocumentFileType),
src/components/filters/FilterBar.tsx, src/components/shared/TagCategoryPicker.tsx,
src/lib/filterSort.ts.

1. /study-materials reads ?type=all|pdf|docx|pptx|xlsx (default all) via
   useSearchParams and updates the URL with router.replace (no scroll jump).
   Tabs: All, PDF, Word, PowerPoint, Excel, each with a count badge computed from
   the already-loaded list (no extra queries).
2. Sidebar: make "Study Materials" a collapsible group with sub-links PDF, Word,
   PowerPoint, Excel (-> /study-materials?type=…), active child highlighted, same
   style as the Settings group.
3. Per tab: title search, sort (recent/title/size), grid/list toggle (localStorage
   in try/catch), category + tag filters reusing FilterBar/TagCategoryPicker.
4. Import button opens DriveImportPanel with `kinds` = the active tab's type;
   upload `accept` follows it.
5. Cards: type icon + colour, thumbnail (S6), title, size, date, Drive account.
   Empty state per tab ("No PDFs yet — pick one from Drive").
6. Mobile: horizontally scrollable tabs, no overflow.
7. Pure helper src/lib/documentFilters.ts (counts/filter/sort) with unit tests.
```
**Test:** the four sidebar sub-links open the right tab; counts match; reload keeps tab and view mode.

---

## STEP S12 — PDF reader (EmbedPDF)

**Depends on:** S11, S5.

**Prompt:**
```
TASK S12 — in-app PDF reader.
Read first: https://www.embedpdf.com (CURRENT React + Next.js docs — follow them;
the API changes between versions), src/app/study-materials/[documentId]/page.tsx
(DocumentPreview currently uses an <iframe> with ?idToken=), src/lib/driveClient.ts.

1. Install the EmbedPDF packages the docs require for React + the PDFium engine.
   State exact versions and confirm the MIT licence. Self-host the PDFium .wasm
   from /public (no third-party CDN) and verify it is served as application/wasm.
2. src/components/documents/PdfReader.tsx loaded with next/dynamic({ssr:false})
   and a Skeleton fallback so the WASM engine never touches other pages.
3. Source: a signed stream URL (S5). If it expires mid-read, fetch a new one
   without losing the page position.
4. Features (use the library's plugins/UI; custom UI only where missing, with the
   app's design tokens and dark mode): continuous virtualised scroll; fit-width /
   fit-page / zoom; rotate; page-number input + keyboard shortcuts; search with
   highlighted hits + next/prev; text selection + copy; collapsible thumbnail
   sidebar (hidden by default on mobile); fullscreen; download (signed download
   URL); print; pinch-zoom; highlights/sticky notes if supported (saving is S14).
5. Performance: show page 1 before the whole file downloads if the library
   supports ranged loading; otherwise a progress bar.
6. Errors: password-protected, corrupted, expired Drive connection (link to
   /settings/drive), file removed from Drive.
7. Fallback if the engine fails to start: "Open in your browser's viewer" +
   Download.
8. Layout: reader left (>=lg), right panel with the existing Summary / Quiz /
   Notes tabs; stacked with a bottom sheet on mobile.
```
**Test:** a 100+ page PDF shows page 1 quickly and scrolls smoothly; search works; pinch-zoom works on a phone; other pages' bundle size is unchanged.

---

## STEP S13 — Word, Excel, PowerPoint viewers

**Depends on:** S11, S5, S10.

**Prompt:**
```
TASK S13 — three readers, each dynamically imported (ssr:false).
1. DocxReader.tsx using `docx-preview` (check version + MIT). Fetch the file via
   the signed URL as an ArrayBuffer (cap 25 MB; above that show Download + the
   S10 text view). Render into an isolated container so document CSS can't leak;
   don't load external resources. Toolbar: zoom, width toggle, print, download,
   "plain text" (GET /api/documents/[id]/text, Bearer, returns the S10 cache).
2. XlsxReader.tsx: parse in the browser with SheetJS (same install as S10). Caps:
   10 MB / 20,000 rows. Sheet tab bar, windowed (virtualised) table, sticky
   header, search-in-sheet, copy as TSV, download. Render cells as TEXT only —
   never sheet_to_html with innerHTML, never evaluate formulas (show cached values).
3. PptxReader.tsx: no reliable free in-browser PPTX renderer exists, so combine
   (a) the Drive preview iframe (drive.google.com/file/d/{id}/preview) with a note
   "Requires being signed in to Google in this browser", (b) a slide outline from
   GET /api/documents/[id]/outline (S10 extraction: "Slide N: text + notes"),
   (c) Download. If the iframe fails within 8 s, show outline + download only.
   Do not create converted copies in the user's Drive.
```
**Test:** a docx with tables/images renders without altering app styles; a 20k-row sheet scrolls smoothly; the PPTX outline lists every slide in order.

---

## STEP S14 — Reader extras

**Depends on:** S12, S13.

**Prompt:**
```
TASK S14 — persistence for readers.
1. Progress: store {lastPage, zoom, updatedAt} on the personalDocuments doc
   (debounced 2 s); reopen at that page; show "Continue reading" cards on
   /continue-learning using the video resume card style.
2. Notes per document with an optional page number (reuse src/lib/firestore/notes.ts
   and RichTextEditor patterns); clicking a note jumps to its page.
3. PDF highlights/annotations: serialise the viewer's annotations to JSON under
   users/{uid}/personalDocuments/{id}/annotations/main (size-guarded, owner-only
   rules). NEVER modify the user's Drive file.
4. "Explain this page": sends the current page text to a new
   POST /api/documents/[id]/explain (authenticated, same withAiConnection/quota
   path, max 8,000 chars) and shows the answer in the side panel.
```
**Test:** close mid-document and reopen on the same page; highlights persist across devices.

---

## STEP S15 — AI service refactor + language (EN / BN / AR)

**Depends on:** none. **Fixes:** F8. Do this **before** S17.

**Prompt:**
```
TASK S15 — one AI dispatcher + language support.
Read first: src/lib/ai/aiService.ts (the same 5-provider switch is repeated 6
times), src/lib/ai/prompts.ts, src/lib/ai/providers/*.ts, src/lib/ai/types.ts,
src/lib/quizSource.ts, src/lib/server/aiPreferences.ts,
src/app/api/ai/preferences/route.ts, src/lib/aiPreferencesClient.ts,
src/app/settings/ai/page.tsx, the summary/quiz routes (video + document).

1. Refactor: add generateText(connection, prompt, opts?: {maxOutputTokens?,
   temperature?, json?}) in a new src/lib/ai/generate.ts that does the provider
   switch ONCE. Thread opts into each provider (today fixed at 1800 tokens and
   temperature 0.7). Defaults: summary 2000 tokens / 0.5; quiz+JSON 2500 / 0.2.
   Make aiService functions call it. Keep exports and tests green.
2. Cache key: replace the FNV hash with SHA-256 (crypto.createHash on the server)
   and include PROMPT_VERSION (a constant bumped when prompts change) and
   `language` in buildVideoSourceHash. Update quizSource.test.ts.
3. Language: type AiLanguage = "en"|"bn"|"ar" (default "en"), stored in the
   existing users/{uid}.aiSettings doc via getAiPreferences/updateAiPreferences;
   validate on the server. languageInstruction(lang) in prompts.ts ("Write the
   entire response in <Language>. Keep technical terms, code and proper nouns in
   their original form where translating would hurt clarity. Do not translate the
   source material.") added to EVERY prompt builder.
4. UI: a language select next to each Generate button (updates the saved default);
   a default-language select in settings/ai. For "ar" render AI output with
   dir="rtl"; load a Bengali-capable font (Noto Sans Bengali via next/font) and
   an Arabic font; quiz options must not break in RTL.
5. Tests: languageInstruction per language; hash changes with language/prompt version.
```
**Test:** generate one summary in all three languages; Arabic renders right-to-left; switching language regenerates instead of reusing the cache.

---

## STEP S16 — Today Plan

**Depends on:** S0 (due reviews need attempts), S7 (shared data).

**Prompt:**
```
TASK S16 — /today page.
Read first: src/lib/goalPace.ts (findGoalsBehindPace), src/lib/reviewUtils.ts
(getDueReviews), src/lib/recommendations.ts, src/lib/dashboardUtils.ts,
src/app/dashboard/page.tsx (see exactly which data it loads),
src/components/video/AllVideosProvider.tsx (S7), src/components/video/VideoCard.tsx,
src/components/layout/Sidebar.tsx, an existing *.test.ts for style.

1. src/lib/todayPlan.ts — pure buildTodayPlan(input) -> up to 5 items
   {video, reason:"goal_behind"|"due_review"|"roadmap_step"|"next_up", reasonLabel}.
   Priority: goals behind pace > due reviews > roadmap-step recommendations >
   next unwatched video in the most recently touched playlist. De-duplicate by
   videoKey (highest-priority reason wins). No Firestore/React imports.
2. src/app/today/page.tsx: reuse the shared provider data and the same goals /
   roadmaps / quiz-attempt loads the dashboard does (extract a shared hook such
   as useDashboardData; add no new queries). Ordered VideoCard list with the
   reasonLabel; empty state; works for personal (Drive/Facebook) videos.
3. Sidebar: "Today" above "Home". Dashboard: "See today's plan" link.
4. todayPlan.test.ts: goal-behind first; due review second; dedupe; cap 5; empty
   account falls back to next_up; empty everything returns [].
```
**Test:** a goal behind pace ranks first; clearing it shows a due review next.

---

## STEP S17 — AI study resources (videos and documents)

**Depends on:** S15, S10.

**Prompt:**
```
TASK S17 — study guide, FAQ, flashcards, outline, key concepts, glossary,
worked examples, review notes.
Read first: src/lib/ai/generate.ts + prompts.ts (S15), src/lib/server/
resolveAiConnection.ts, src/lib/server/aiQuota.ts, src/lib/ai/universalTranscript.ts,
src/lib/server/documentContent.ts (S10 cache), src/app/api/ai/quiz/generate/route.ts,
src/components/video/SummaryPane.tsx.

1. Types: ResourceType union (8 keys); GeneratedResource {type, content (markdown,
   or JSON for flashcards/glossary), sourceHash, language, promptVersion, model,
   generatedAt}.
2. Storage (Admin SDK only; rules: owner read, client write false):
   users/{uid}/resources/{sourceKey}, sourceKey = `v_${videoKey}` or
   `d_${documentId}`, one map field per type — one read returns everything.
3. ONE route POST /api/ai/resource {source:{kind, ...ids}, type, language, force?}:
   authenticate -> resolve source text (videos: resolveTranscript, falling back to
   the saved summary like the quiz route; documents: S10 extraction) -> hash
   (source + language + type + PROMPT_VERSION) -> return cache if equal and !force
   -> else generate via withAiConnection/quota with a per-type maxOutputTokens
   (study guide 3500, FAQ 2500, ...) -> save -> return. A second click must not
   call the provider. Set maxDuration.
4. One prompt builder per type, each requiring grounding in the material only and
   a length cap; flashcards/glossary return strict JSON, validated; retry once on
   invalid JSON.
5. UI: a "Study tools" menu next to the summary button on the video and document
   pages; each item shows not generated / cached / stale and a Regenerate action.
   Render markdown through the existing sanitised path (toSummaryHtml); never
   inject raw model output.
6. Tests: hash invalidation (source/language/type/prompt version), JSON validator,
   each builder contains the grounding rule.
```
**Test:** generate each type; DevTools shows no provider call on the second click; editing the transcript marks resources stale.

---

## STEP S18 — Flashcards from quiz mistakes

**Depends on:** S0.

**Prompt:**
```
TASK S18 — per-question review.
Read first: src/types/index.ts (QuizAttempt.answers from S0),
src/lib/reviewUtils.ts (getDueReviews: 3-day for <80%, 7-day otherwise),
src/lib/firestore/quizAttempts.ts, src/components/layout/Header.tsx (bell badge).

1. src/lib/spacedRepetition.ts (pure): card state {cardId:`${videoKey}:${questionId}`,
   box 1-5, dueAt, lastResult}. Leitner: wrong -> box 1, due +1 day; correct ->
   next box; intervals 1/3/7/14/30 days. getDueFlashcards(attempts, states, now).
   Reuse constants from reviewUtils where they exist. Attempts without `answers`
   are ignored.
2. Persist states in users/{uid}/flashcardStates/{cardId} with rules (owner,
   box 1-5, dueAt timestamp).
3. Need the question text: store it. Extend the saved quiz questions lookup — the
   quiz cache already holds questions under .../quiz/data; add a server route
   GET /api/review/cards that joins due cards with their question/options/
   explanation (Admin SDK) and returns only due ones.
4. src/app/review/page.tsx: flip-card session (front: question; back: correct
   answer + explanation), "I knew it"/"Missed it", progress bar, summary.
   Keyboard: space flips, 1/2 answers.
5. Sidebar "Review" with a due-count badge in the bell badge style.
6. Tests: wrong -> due soon; correct -> longer; box caps at 5; no wrong answers ->
   no cards; old attempts skipped.
```
**Test:** answer a quiz with 2 wrong questions → both appear in `/review`; mark one correct → its next date is later than the other's.

---

## STEP S19 — Streak and weekly report

**Depends on:** S7. **Fixes:** F2.

**Prompt:**
```
TASK S19 — real streak + weekly report from an activity ledger.
Read first: src/lib/firestore/users.ts (recomputeUserStats/computeStreak — only
called from the admin user page; UTC days; shared videos only),
src/app/dashboard/page.tsx (reads profile.stats.currentStreakDays),
src/lib/dashboardUtils.ts (buildWeeklyActivity), src/components/ui/charts.tsx,
src/lib/firestore/personalPlaylists.ts (savePersonalVideoProgress),
src/lib/firestore/userVideoState.ts (saveProgress), src/lib/motivation.ts.

1. Ledger: users/{uid}/activityDays/{YYYY-MM-DD} = {date, watchSeconds, videosProgressed,
   videosCompleted, quizzes, reviews, updatedAt}. The date is the USER's local
   day (store profile.timezone from Intl.DateTimeFormat().resolvedOptions()
   on login). Write with setDoc(merge) + increment(); rules: owner only, numeric
   fields 0..86400 per write, id must match /^\d{4}-\d{2}-\d{2}$/.
2. Hook it into: progress saves (add the delta between previous and current
   position, capped at 120 s per save), video completion, quiz submission (S0
   route or client), review answers (S18).
3. src/lib/streak.ts (pure): computeStreak(days: string[], todayStr) -> {current,
   longest}; same day counts; yesterday keeps the chain; a gap resets to 0/1.
   Tests: consecutive days, same day, gap, timezone boundary (23:30 vs 00:30),
   longest tracking.
4. Dashboard streak tile and motivation banner read the last 60 activityDays
   (one query), not profile.stats. Keep recomputeUserStats for admin but fix it
   to use the same helper, or remove the streak fields from it.
5. src/app/weekly-report/page.tsx: last 7 days vs previous 7 (watch minutes,
   videos completed, quizzes, reviews, goals progressed) with the existing
   BarChart/Sparkline. Flame badge in the Header/dashboard linking to it.
```
**Test:** study on two consecutive days (or edit a test account's ledger) → streak 2; skip a day → resets; weekly numbers match the dashboard chart.

---

## STEP S20 — Backup completeness and fast, validated restore

**Depends on:** S2. **Fixes:** F7.

**Prompt:**
```
TASK S20 — backup v2.
Read first: src/lib/server/driveBackup.ts, src/app/api/drive/backup/*/route.ts,
src/app/settings/backup/page.tsx.

1. Payload version 2 adds: transcripts, bookmarks (users/{uid}/bookmarks/*/items),
   categories, learningRoadmaps, personalDocuments (metadata only — files stay in
   Drive), videoStates, favoritePlaylists, flashcardStates, activityDays,
   resources (S17). Keep reading version 1 files.
2. Validation before preview/restore: version, ownerId === uid, arrays, string
   lengths, max counts, max payload 20 MB, and EVERY doc id must match
   /^[A-Za-z0-9_-]{1,128}$/ (never use ids containing "/"). Strip server-only
   fields. Reject unknown collections.
3. Restore: use Admin WriteBatch (chunks of 400) with create-if-missing semantics
   (never overwrite); report counts per collection in the preview dialog.
4. Backup writes a size summary and a SHA-256 of the payload into the file name
   or metadata; restore warns if it doesn't match.
5. Tests for the validator and the "create-if-missing" planning (pure function).
```
**Test:** back up, delete a playlist, restore with the preview → it returns, including notes, transcripts and bookmarks.

---

## STEP S21 — Next.js major upgrade (separate branch)

**Depends on:** S14 done.

**Prompt:**
```
TASK S21 — upgrade to the current stable Next.js major + React.
Read first: package.json, next.config.* (not in the zip — create/read yours),
every route.ts/page.tsx using `params` or `searchParams`.
1. New git branch. Read the official upgrade guide for the target version and run
   `npx @next/codemod@latest upgrade`.
2. Handle: async params/searchParams in route handlers and pages; React 19 type
   changes; fetch/route caching defaults; check next-themes, @radix-ui/*, cmdk,
   sonner, react-youtube, @tiptap/*, driver.js and the EmbedPDF packages for
   compatibility (upgrade or report).
3. Upgrade firebase (v10) to the current major only if the changelog shows no
   breaking changes for auth, firestore, getIdToken; otherwise leave it and say so.
4. Add security headers in next.config (X-Content-Type-Options, Referrer-Policy,
   Permissions-Policy, frame-ancestors via CSP) — allow only what Drive Picker,
   YouTube/Facebook embeds and EmbedPDF's WASM need; test every page.
5. tsc, lint, tests, `next build`; smoke test login, dashboard, playlists, Drive
   connect/import/playback, Study Materials readers. No feature work on this branch.
```
**Test:** the smoke list passes on a Vercel preview.

---

## STEP S22 — PWA

**Depends on:** S5, S21.

**Prompt:**
```
TASK S22 — installable PWA with a safe offline shell.
1. Use the maintained Serwist integration for Next (@serwist/next) if it supports
   the installed Next version; otherwise a hand-written public/sw.js. NOT
   next-pwa (unmaintained). State the choice + versions.
2. public/manifest.webmanifest (name, short_name, start_url "/dashboard",
   standalone, theme/background colours, 192/512 + maskable PNGs generated from
   src/app/icon.svg); link it with theme-color and apple-touch-icon.
3. Service worker: precache the shell + static assets; stale-while-revalidate for
   Next static files. NEVER cache: /api/*, Drive stream/thumbnail URLs or anything
   with a signature query, Firebase/Google requests, video/PDF/Office bytes,
   authenticated HTML. Offline navigation -> /offline (static page + retry).
4. "Install app" button (beforeinstallprompt, hidden when installed) + an iOS
   "Add to Home Screen" hint. Update flow: toast "Update available — Reload".
5. Logout clears any cached user-specific data.
```
**Test:** Lighthouse installability passes; airplane mode shows the offline page; a Drive video is never served from the SW cache.

---

## STEP S23 — Export notes, summaries, flashcards

**Depends on:** S17 (S18 optional).

**Prompt:**
```
TASK S23 — browser-side export (Blob download, no server files).
1. buildMarkdownExport({video|document, notes, summary, resources}) -> string
   (convert summary HTML to markdown; escape front-matter); "Export" menu on
   video/document/playlist pages; playlists bundle all videos with a table of
   contents.
2. Anki: FIRST ship an Anki-importable TSV (Front<TAB>Back<TAB>Tags, HTML allowed).
   Only if a maintained library exists (check npm: licence + last release) add
   .apkg; do not hand-roll the SQLite/zip format.
   Cards: quiz questions (front) / correct answer + explanation (back), plus S17
   flashcards.
3. Sanitise every exported string (strip control characters; escape tabs/newlines
   in TSV fields).
4. Tests: markdown builder + TSV writer with quotes, tabs, Bangla/Arabic text.
```
**Test:** the .md opens in any viewer; the TSV imports into Anki with the right card count and intact Bangla/Arabic text.

---

## 5. Final regression checklist (after S22)

1. Fresh signup → `/dashboard`, welcome tour fires without a refresh.
2. Take a quiz (shared, personal, document) → attempts exist in Firestore; mastery and "Review due" show data.
3. Drive: connect a different-email account; import a file, a folder (multi-select path), PDF, DOCX, PPTX, XLSX; each lands under the right tab.
4. Drive video: seek ×10, close the tab, reopen → resumes; DevTools shows no tokens in URLs.
5. PDF: open, search, highlight, reopen on the same page.
6. Summary → quiz → resources → `/review` → `/today` work in all three languages.
7. Streak increments on consecutive days; weekly report matches the dashboard.
8. Backup → delete a playlist → restore with preview.
9. `next build`, lint, tests green; Lighthouse PWA passes.

## 6. Near-future features (after S23)

| Priority | Feature | Why it fits this codebase | Rough effort |
|---|---|---|---|
| 1 | **Ask this video / this document** (chat with timestamp or page jumps) | Transcripts, document text and the AI connection layer already exist | Medium |
| 2 | **Push reminders** (goal behind pace, reviews due) | Needs S22's service worker; reuses `findGoalsBehindPace` and `getDueReviews` server-side via a daily cron | Medium |
| 3 | **Semantic search across all notes, summaries, transcripts and documents** | One embedding per chunk plus a vector index (Firestore vector search or a small external index); answers "where did I learn X?" | Medium–High |
| 4 | **Free-AI-key wizard** (Gemini free tier) | Lets non-technical users enable AI without help; reuses the AI connection test | Small |
| 5 | **OCR for scanned PDFs and audio speech-to-text** | Fills the two "no text available" gaps in S10 and the existing `audioTranscribe` stub | Medium–High |
| 6 | **Focus timer (Pomodoro) + study-time analytics** | The S19 ledger already stores `watchSeconds`; add per-category time charts | Small–Medium |
| 7 | **Study buddy / small groups** with a limited shared progress view | Needs the narrow user lookup (`/api/find-user` with rate limit) and strict rules; no private content exposed | Medium |
| 8 | **Google Calendar sync for goals and review sessions** | You already run Google OAuth; needs a separate, minimal Calendar scope and its own consent screen review | Medium |
| 9 | **Mind-map / concept-graph view** from summaries and key concepts (S17) | Pure front-end rendering of already-generated data | Small–Medium |
| 10 | **Durable Facebook thumbnails** | Copy at save time instead of resolving live; same pattern as S6 | Small |
| 11 | **Facebook + GitHub sign-in**, **admin usage analytics** | Reuses the `loginWithGoogle` pattern; admin dashboard already has user counts | Small–Medium |
| 12 | **Mobile wrapper** (Capacitor) once the PWA is stable | Reuses the same app; adds store presence and native share/notifications | Medium |

## 7. What I still could not verify
- Whether `quizAttempts` is really empty (F1), whether folder import returns zero files under `drive.file`, and whether your Vercel plan lets you choose the function region or raise `maxDuration`.
- Security headers, CSP and `next.config` (not in the zip), and the test runner (`scripts/`).
- Pages and components listed in section 0 as unread. Run the steps' "Read first" lists and tell me if a step contradicts code I haven't seen.
