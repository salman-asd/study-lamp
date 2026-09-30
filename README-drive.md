# Google Drive integration (Phases 13-19) — setup notes

This covers everything added for: connecting Google Drive accounts, picking/
uploading videos and documents from Drive, secure playback, backup/restore,
and PDF/Office "Study Materials" with AI summary/quiz.

**None of this has been installed, built, or run** — it was written in a
sandboxed environment with no network access, so `npm install` was never
executed and nothing has touched a real Google API. Treat everything below
as a first draft to verify, not a tested feature.

## 1. Install dependencies

```
npm install
```

This pulls in `pdf-parse` (added to `package.json`), used for PDF text
extraction feeding the AI summary/quiz routes. Word/PowerPoint/Excel text
extraction needed no new dependency — see `src/lib/server/zipReader.ts` and
`src/lib/server/documentText.ts` for why (they're zip files under the hood;
read via Node's built-in `zlib`).

## 2. Google Cloud Console setup

1. Create (or reuse) a project, enable the **Google Drive API** and the
   **Google Picker API**.
2. Create an **OAuth 2.0 Client ID** (type: Web application).
   - Authorized redirect URI: `https://<your-domain>/api/drive/auth/callback`
     (add one per environment — localhost, preview, prod).
3. Create an **API key**, restrict it to the Picker API only, and restrict
   it by HTTP referrer to your domain(s).
4. OAuth consent screen: the app only requests the
   `drive.file` Drive scope, which Google classifies as non-sensitive — this
      should not require the full security assessment broader Drive scopes
      need. The separate `userinfo.email` identity scope is used only to label
      the connected account and does not grant additional Drive access. Verify
      current Google requirements before shipping (they change).

## 3. Environment variables

Server-only (never prefix with `NEXT_PUBLIC_`):

```
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_OAUTH_STATE_SECRET=<openssl rand -base64 32>
```

Public (browser needs these to start the OAuth redirect and open the
Picker):

```
NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID=<same value as GOOGLE_DRIVE_CLIENT_ID>
NEXT_PUBLIC_GOOGLE_PICKER_API_KEY=<the restricted API key from step 2.3>
```

Google Picker uses `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` as its project
number. Keep the Firebase app, Google Drive API, Google Picker API, OAuth
client, and Picker API key in the same Google Cloud project; Picker needs this
project ID to grant `drive.file` access to files the user selects.

## 4. Deploy Firestore rules

`firestore.rules` gained two new collections:
- `driveConnections` — denied to the client entirely (server-only, same
  pattern as `aiConnections`).
- `personalDocuments` — owner/admin read+write with field validation, plus
  a server-only `quiz` subcollection.

Run `firebase deploy --only firestore:rules` (or your usual pipeline).

## 5. What to test manually

Nothing here has touched real Google APIs yet:

1. **Connect** (`/settings/drive`) — OAuth round trip, confirm the
   connection shows up with the right email.
2. **Pick a video** — Save Video dialog → Google Drive tab → Pick from
   Drive → pick a video file → confirm it lands in the target playlist and
   plays back (seeking included).
3. **Pick a folder** — same tab → pick a folder of videos → confirm a new
   playlist is created with one video per file.
4. **Upload** — same tab → Upload to Drive → confirm progress shows, the
   file appears in the real Drive account, and it's registered as a video.
5. **Study Materials** (`/study-materials`) — import a PDF and a Word/
   PowerPoint/Excel file, confirm Preview/Download/Open in Drive all work,
   and Generate produces a grounded summary + quiz.
6. **Backup/restore** (`/settings/backup`) — back up, delete a playlist,
   restore, confirm the preview counts and the restored data match.
7. **Disconnect** — confirm imported videos/documents fail gracefully
   (clear "reconnect" message) rather than crashing, and that nothing in
   the real Drive account was touched.

## Known gaps / deliberate simplifications

- Folder import only creates video playlists — there's no "import a folder
  of documents" flow yet (`listFolderDocumentFiles` in `googleDrive.ts` is
  written but unused; wire it into a document-folder-import route if
  needed).
- No AI category/tag suggestion on folder import (the original roadmap
  mentioned reusing the `suggest-category-name` pattern; skipped to keep
  scope focused on the core Drive plumbing).
- The Study Materials quiz is a simple self-check UI — it isn't wired into
  the `QuizAttempt`/spaced-repetition data model videos use.
- The Google Picker shows both videos and documents regardless of which
  dialog opened it (Google doesn't expose a mime-based view filter we can
  scope tightly enough) — picking the "wrong" type for the context (e.g. a
  video from the Study Materials picker) still gets imported, just as the
  other kind of item.
