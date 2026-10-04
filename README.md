# Study Lamp

An accountability and learning layer on top of any video you're already
watching — YouTube, Facebook, or your own personal library. Study Lamp adds
goals, pace tracking, AI-generated summaries and quizzes, a guided roadmap,
and Google Drive-backed video/document storage on top of a normal
watch-and-take-notes workflow.

> Package name in `package.json` is currently `student-video-organizer`
> (pre-rename) — this is the same app as "Study Lamp".

---

## Table of contents

- [Feature overview](#feature-overview)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Firebase setup](#firebase-setup)
- [Google Drive integration](#google-drive-integration)
- [AI providers](#ai-providers)
- [Testing](#testing)
- [Admin accounts](#admin-accounts)
- [Known limitations](#known-limitations)

---

## Feature overview

**Core learning loop**
- Add videos from YouTube, Facebook, or any direct/generic video URL into
  shared (admin-curated) or personal playlists.
- Per-video notes, a rich-text summary editor, timestamped bookmarks, and
  watch progress/priority tracking.
- Goals with pace tracking (`computeDailyPace`, `findGoalsBehindPace`) and
  a roadmap view tying interests → curriculum steps → recommendations.
- In-app notifications (bell icon) for pace and review reminders —
  in-app only today, no push/email delivery.

**AI tools** (bring-your-own API key, encrypted at rest)
- Transcript-grounded video summaries and quizzes.
- Universal transcript pipeline: official captions (YouTube) → a manually
  pasted or `.srt`/`.vtt`-uploaded transcript → (reserved for future
  automatic speech-to-text — not implemented yet).
- Quizzes use a fixed question mix (recall / conceptual / application /
  reasoning) and are cached per content-hash so they don't regenerate
  until the source actually changes.
- AI Connections settings page for managing provider API keys and model
  selection, with quota-aware fallback across configured connections.

**Google Drive**
- Connect one or more Google accounts independently of your Study Lamp
  login (`drive.file` scope only, via the Google Picker — avoids Google's
  sensitive-scope review).
- Import a single Drive video or an entire folder as a new personal
  playlist, with AI-suggested (editable) categories.
- Upload a new video straight to Drive from inside Study Lamp.
- Secure playback: Drive files are streamed through a server-side proxy
  (`/api/drive/stream/[fileId]`) that verifies ownership and forwards
  `Range` requests — no Drive access tokens ever reach the browser.
- Backup/restore your playlists, videos, notes, goals, and quiz attempts
  to a "Study Lamp Backups" folder in your own Drive.

**Study Materials**
- Import PDF, Word (`.docx`), PowerPoint (`.pptx`), and Excel (`.xlsx`)
  files from Drive and run the same AI summary/quiz pipeline against
  their extracted text.
- Word documents open in an isolated in-app preview with a plain-text fallback;
  Excel workbooks use a virtualized, searchable in-app sheet viewer. PowerPoint
  continues to use Google Drive's preview.
- `.docx` text uses Mammoth, `.pptx` text follows presentation order and
  includes speaker notes, `.xlsx` uses SheetJS, and PDF text uses `unpdf`.
- Extracted text is cached server-side against the Drive file checksum (or
  modified time); Office ZIPs and document/text sizes are bounded during
  extraction.

**Onboarding**
- Onboarding (interest selection) is optional, not a forced gate — new
  users land directly on the dashboard, with a dismissible
  `InterestsBanner` prompting setup, and a driver.js-powered welcome tour
  for first-time visits.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI | Tailwind CSS, Radix UI primitives, `lucide-react` icons |
| Rich text | Tiptap |
| Drag & drop | `@dnd-kit` |
| Auth & data | Firebase Auth + Firestore (client SDK), `firebase-admin` (server) |
| Tours | `driver.js` |
| Video | `react-youtube`, native `<video>` for Facebook/Drive/generic sources |
| Transcripts | `youtube-transcript`, manual paste/upload for everything else |
| Documents | EmbedPDF, `docx-preview`, `unpdf`, `mammoth`, SheetJS from the official CDN |
| Notifications | `sonner` (toasts) + an in-app notification bell |

Firestore security rules live in `firestore.rules` at the repo root and
must be deployed (`firebase deploy --only firestore:rules`) whenever they
change — the app will silently fail writes otherwise.

---

## Project structure

```
src/
  app/                    Next.js App Router pages + API routes
    api/ai/                AI summary/quiz generation endpoints
    api/drive/             Drive OAuth, import, upload, streaming, backup
    api/documents/         Study Materials summary/quiz endpoints
    dashboard/, goals/, roadmap/, library/, playlists/, video/, ...
    settings/               AI Connections, Interests, Drive, account settings
    study-materials/        PDF/Office document viewer + AI tools
  components/
    auth/                  AuthProvider, RequireAuth
    dashboard/              MotivationBanner, InterestsBanner
    video/                  VideoPlayer, SummaryPane, TranscriptInput, ...
    drive/                  DrivePickerButton, DriveImportPanel
    tour/                   TourProvider (driver.js wrapper)
  lib/
    ai/                    Prompt builders, provider adapters, transcript resolution
    server/                Server-only helpers (Drive, AI connection resolution, quiz)
    firestore/             Client-side Firestore read/write helpers, one file per collection
    tour/                   Tour definitions + auto-run eligibility logic
  types/                   Shared TypeScript types (index.ts)
firestore.rules            Security rules (source of truth — deploy after every change)
firestore.indexes.json     Composite index definitions
```

---

## Getting started

```bash
npm install
cp .env.local.example .env.local   # fill in the values below
npm run dev
```

The app runs at `http://localhost:3000`.

```bash
npm run build   # production build
npm run start   # run the production build
npm run lint    # eslint
npm test        # project test suite (see Testing below)
```

---

## Environment variables

### Client-exposed (`NEXT_PUBLIC_*`)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | ✅ | Firebase Web app config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | ✅ | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | ✅ | Must match the project `firestore.rules` is deployed to |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | ✅ | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | ✅ | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | ✅ | |
| `NEXT_PUBLIC_APP_URL` | ✅ | Base URL used for Drive OAuth redirect construction |
| `NEXT_PUBLIC_SEED_ADMIN_EMAILS` | ✅ | Comma-separated emails allowed to bootstrap as `role: "admin"` on first signup. **Must exactly mirror** the `isSeedAdminEmail()` allowlist hardcoded in `firestore.rules` — the client and the security rule make this decision independently, and they will silently disagree if you only update one. |
| `NEXT_PUBLIC_HAS_YT_KEY` | – | Feature-detection flag for YouTube API availability |
| `NEXT_PUBLIC_FACEBOOK_APP_ID` | – | Only needed for Facebook video embedding/import |
| `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` | – | Drive Picker OAuth client ID (browser-side) |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | – | Google Picker API key |

### Server-only

| Variable | Required | Notes |
|---|---|---|
| `FIREBASE_PROJECT_ID` | ✅ | `firebase-admin` service account |
| `FIREBASE_CLIENT_EMAIL` | ✅ | |
| `FIREBASE_PRIVATE_KEY` | ✅ | Keep the `\n` escapes when pasting into `.env.local` |
| `AI_CONNECTION_ENCRYPTION_KEY` | ✅ (for AI features) | AES-256 key encrypting stored AI provider API keys. Generate with `openssl rand -base64 32`. |
| `GOOGLE_DRIVE_CLIENT_ID` / `GOOGLE_DRIVE_CLIENT_SECRET` | – (for Drive) | Server-side half of the Drive OAuth flow |
| `GOOGLE_DRIVE_OAUTH_STATE_SECRET` | – (for Drive) | Signs the OAuth `state` parameter |
| `YOUTUBE_API_KEY` | – | Server-side YouTube Data API lookups |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | – | Only if importing from a Facebook Page you manage |

> **Bootstrapping the first admin:** set `NEXT_PUBLIC_SEED_ADMIN_EMAILS`,
> add the same email to the `isSeedAdminEmail()` list in `firestore.rules`,
> deploy the rules, restart the dev server, then sign up with that email.
> If you skip the rules half of this, Firestore will silently reject the
> admin profile write and **no user document will be created at all** —
> this is the single most common setup mistake.

---

## Firebase setup

1. Create a Firebase project and enable **Authentication** (Email/Password
   is required; Google sign-in optional) and **Firestore**.
2. Deploy security rules and indexes:
   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```
3. Generate a service account key for `firebase-admin` (used by API routes
   that need elevated access — Drive import, document text extraction,
   quiz caching) and populate the server-only Firebase variables above.
4. Re-deploy `firestore.rules` any time it changes — a rule change with no
   redeploy is indistinguishable from "it isn't working."

---

## Google Drive integration

Drive support is split across Google Cloud Console setup and app config:

1. In Google Cloud Console, enable the **Google Drive API** and configure
   an OAuth consent screen requesting only the `drive.file` scope (this
   keeps the app out of Google's sensitive-scope review).
2. Create an OAuth client for the server-side flow
   (`GOOGLE_DRIVE_CLIENT_ID`/`SECRET`) and, separately, a browser API key
   for the Picker (`NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`).
3. Users connect their own Drive account from **Settings → Drive**
   (`src/app/settings/drive/page.tsx`); connections are per-user and can
   be a different Google account than the one they log into Study Lamp
   with.
4. Imported videos/documents are never copied off Drive — Study Lamp
   streams and reads them on demand, and disconnecting or deleting a
   Study Lamp record never touches the underlying Drive file.

---

## AI providers

AI features (summaries, quizzes, document extraction → summary/quiz) are
**bring-your-own-key**. A user adds one or more provider connections in
**Settings → AI Connections**; keys are encrypted with
`AI_CONNECTION_ENCRYPTION_KEY` before being stored in Firestore and are
never sent back to the client in plaintext. If multiple connections are
configured, generation falls back across them on transient failures
(rate limits, timeouts, server errors) but not on errors that indicate a
bad request or a genuinely bad key.

---

## Testing

```bash
npm test
```

Runs `scripts/runTests.mjs` over the project's `node:test`-based unit
tests (colocated as `*.test.ts` next to the code they cover — e.g.
`src/lib/ai/quiz.test.ts`, `src/lib/tour/tours.test.ts`,
`src/lib/quizSource.test.ts`). These are pure-function/unit tests with no
Firebase emulator dependency, so they run without any environment
variables configured.

---

## Admin accounts

Admin and non-admin users share every personal feature (notes, summaries,
quizzes, goals, roadmap, Drive). Admin adds a management layer on top:
curating shared playlists/videos and (eventually) a user list and
analytics view. There is currently no in-app "promote to admin" action —
admin status is only granted via the `NEXT_PUBLIC_SEED_ADMIN_EMAILS` /
`isSeedAdminEmail()` bootstrap described above.

---

## Known limitations

- **Speech-to-text is not implemented.** `src/lib/ai/audioTranscribe.ts`
  exists as scaffolding (behind the `speechToTextEnabled` preference) but
  currently always throws — videos with no captions need a manually
  pasted or uploaded (`.srt`/`.vtt`) transcript.
- **Scanned PDFs need OCR.** Text-only PDFs are supported; scanned pages
  return a clear OCR-required message.
- Notifications are in-app (bell icon) only — no email or push delivery.
- Admin's user-list/analytics view is not yet built; today admin only
  manages shared playlist content.