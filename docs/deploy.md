# Deploying Study Lamp

## Regions

- Vercel functions: `bom1` (Mumbai), set in `vercel.json`.
- Firestore: `asia-south2` (Delhi), set in `firebase.json`.

Keep them close; each Firestore round trip from a distant region adds latency to every API route.

## Environment variables

Set these in Vercel (Production and Preview). `NEXT_PUBLIC_*` values are embedded in the browser bundle at **build** time.

| Name | Scope | Required |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | public | yes |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | public | yes (also used to build the CSP `frame-src`) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | public | yes |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | public | yes |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | public | yes |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | public | yes |
| `NEXT_PUBLIC_APP_URL` | public | yes (OAuth redirects) |
| `NEXT_PUBLIC_SEED_ADMIN_EMAILS` | public | yes (keep in sync with `firestore.rules`) |
| `NEXT_PUBLIC_HAS_YT_KEY` | public | optional |
| `NEXT_PUBLIC_FACEBOOK_APP_ID` | public | optional (Facebook embeds) |
| `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` | public | yes for Drive |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` | public | yes for Drive |
| `FIREBASE_PROJECT_ID` | server | optional (falls back to the public project ID) |
| `FIREBASE_CLIENT_EMAIL` | server | yes in production |
| `FIREBASE_PRIVATE_KEY` | server | yes in production (keep `\n` escapes) |
| `AI_CONNECTION_ENCRYPTION_KEY` | server | yes |
| `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` | server | only during key rotation |
| `GOOGLE_DRIVE_CLIENT_ID` | server | yes for Drive |
| `GOOGLE_DRIVE_CLIENT_SECRET` | server | yes for Drive |
| `GOOGLE_DRIVE_OAUTH_STATE_SECRET` | server | yes for Drive |
| `DRIVE_URL_SIGNING_SECRET` | server | yes for Drive playback |
| `YOUTUBE_API_KEY` | server | optional |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | server | optional |
| `QUOTA_TIMEZONE` | server | optional (default `Asia/Dhaka`) |
| `DRIVE_TIMING` | server | optional (`1` logs Drive timings) |
| `CSP_MODE` | build-time | optional (`enforce` sends an enforcing CSP) |

## Function duration (`maxDuration`)

Heavy routes declare `export const maxDuration = 60;`:

- AI generation: `ai/summary`, `ai/quiz/generate`, `ai/roadmap/*`, `ai/goals/suggest`, `ai/suggest-category-name`, `documents/[id]/summary|quiz|explain`.
- Drive: `drive/import/file`, `drive/import/files`, `drive/import/folder`, `drive/thumbnails/backfill`, `drive/backup`, `drive/backup/restore`, `drive/stream/[fileId]`.

Vercel caps this by plan, and the cap can change. Check the current limits in the Vercel docs and your plan. If your plan allows less than 60 s, lower the value in each file, or large imports and AI calls will be cut off.

## Content-Security-Policy

`next.config.js` ships `Content-Security-Policy-Report-Only`: violations appear in the browser console (DevTools → Console, "Content Security Policy" messages) and nothing is blocked. No report endpoint is configured.

Before enforcing, test each of these with the console open and fix or allow any violation (edit the lists in `next.config.js`):

1. Login (Google popup), logout.
2. Dashboard, playlists, favorites, watch-later.
3. YouTube, Facebook and Vimeo playback.
4. Drive connect, Picker, import, Drive video playback and seek.
5. PDF, Word and Excel readers (PDFium worker and wasm, docx iframe).
6. Roadmap, onboarding, settings, AI generation.

After a clean week: set `CSP_MODE=enforce` in Vercel, redeploy, and recheck the same list. To roll back, remove the variable and redeploy.

## PDFium wasm

`public/wasm/pdfium.wasm` is self-hosted and loaded by `PdfReader` from `/wasm/pdfium.wasm`. It is served as `application/wasm` with a one-year immutable cache. The file name is not hashed, so after upgrading `@embedpdf/react-pdf-viewer`, replace the file with the version that ships with the new package **and** make sure browsers fetch it again (rename the file and update `wasmUrl` in `PdfReader.tsx`, or shorten the cache). A mismatched wasm and JS version breaks the PDF reader.

## Thumbnail backfill

`POST /api/drive/thumbnails/backfill` (Bearer Firebase ID token, signed-in user only) processes one batch for the **calling user** and returns `{ processed, remaining }`. Repeat the call until `remaining` is 0. The easiest way is the thumbnail refresh action in **Settings → Drive** (`src/app/settings/drive/page.tsx`), which loops over batches for you. Each user runs it for their own library.

## Rate limiting

`checkRateLimit` (src/lib/server/rateLimit.ts) keeps its counters in each serverless instance's memory, so the real limit is roughly the configured limit × the number of running instances, and it resets on a cold start; use Upstash Redis (or another shared store) as the upgrade path when you need a hard, global limit.
