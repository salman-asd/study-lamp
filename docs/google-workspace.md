# Google Workspace (Calendar + Tasks) — Cloud setup

Step W2 connects a Google account with the narrowest possible scopes so Study
Lamp can later sync study goals to a dedicated Google Calendar and your Tasks.
Nothing syncs in this step: it only connects the account safely, shows what was
granted, and can disconnect.

## 1. Create a second OAuth client

In the existing Google Cloud project (the same one used for Drive):

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Study Lamp Workspace`.
4. **Authorised redirect URIs** — add one per deployment, each ending in the
   callback path:
   - `http://localhost:3000/api/google/auth/callback`
   - your Vercel preview URL(s), e.g. `https://<preview>.vercel.app/api/google/auth/callback`
   - your production URL, e.g. `https://your-domain.com/api/google/auth/callback`
5. Copy the **client ID** and **client secret**.

## 2. Enable the APIs

**APIs & Services → Library**: enable both

- **Google Calendar API**
- **Google Tasks API**

## 3. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**:

1. Add these scopes (they are exactly what the app requests):
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/userinfo.email`
2. Add yourself (and any testers) as **test users**.

### Publishing status — the 7-day refresh-token caveat

While the consent screen is in **Testing** status, Google expires refresh tokens
after **7 days**. Users will see a "Needs reconnect" badge in
**Settings → Google Workspace** and can fix it with the **Reconnect** button.
Publish the app (or keep re-testing within 7 days) for tokens that last.

## 4. Environment variables

Add these server-only variables (see `docs/deploy.md` for the full list):

| Variable | Notes |
| --- | --- |
| `GOOGLE_WORKSPACE_CLIENT_ID` | From the "Study Lamp Workspace" OAuth client. |
| `GOOGLE_WORKSPACE_CLIENT_SECRET` | Same client. |
| `GOOGLE_WORKSPACE_OAUTH_STATE_SECRET` | Generate with `openssl rand -base64 32`. Signs the OAuth `state`. |

They are deliberately **separate** from the Drive client
(`GOOGLE_DRIVE_*`) so the two flows use independent credentials and state
secrets. The Workspace `state` HMAC is domain-separated with a `workspace.v1|`
prefix, so a Drive state can never be replayed here (or vice versa).

## 5. Scopes used

| Feature | Scope | Why it is safe |
| --- | --- | --- |
| Calendar | `calendar.app.created` | Study Lamp can only see and edit calendars it created itself — never your existing calendars. |
| Tasks | `tasks` | **Wider than Calendar.** Google has no "only what the app created" scope for Tasks, so this permission lets the app read and change **all** of your task lists. Study Lamp's code only ever touches its own "Study Lamp" list (it never lists or opens your other lists; a test enforces this), and it writes only after you confirm. |
| Account | `userinfo.email` | Only to show which Google account is connected. |

> **Be aware when you allow Tasks.** Google's consent screen will say Study
> Lamp can see and edit your tasks. That is the narrowest Tasks permission
> Google offers; it cannot be limited to one list. Calendar is different:
> `calendar.app.created` really is limited to calendars Study Lamp created.
> If you are not comfortable with this, allow only Calendar.

Study Lamp requests one feature at a time ("Allow Calendar access" / "Allow
Tasks access"), using incremental consent (`include_granted_scopes=true`) so
granting Tasks later never drops an existing Calendar grant.

## 6. Verify

1. **Settings → Google Workspace → Allow Calendar access** → consent → you land
   back with a "Connected …" toast and the account shows **Calendar allowed**,
   **Tasks not allowed**.
2. **Allow Tasks access** → both show **allowed**.
3. Untick a permission on Google's screen → the app reports which one is missing.
4. **Disconnect** → the stored token is removed and revoked at Google; anything
   already created in Google is untouched.

## 7. Token storage

Refresh tokens are encrypted with `AI_CONNECTION_ENCRYPTION_KEY` (AES-256-GCM,
see `src/lib/server/aiEncryption.ts`) and stored at
`users/{uid}/googleConnections/{id}`. The `googleConnections` subcollection is
denied to the client SDK in `firestore.rules`; all access goes through
`/api/google/*` with the Admin SDK. Key rotation covers this collection (see
`docs/security.md` and `scripts/reencrypt.ts`).

## Using Calendar sync

Calendar sync is **off** until you turn it on in *Settings → Google Workspace → Sync goals with Calendar*.
Turning it on creates one calendar, "Study Lamp goals", in your Google account. It never searches for, reads or
changes your other calendars, and it writes **no events** until you approve changes.

**Check for changes** (and the "N changes ready to review" bar on the Goals page) only *reads*: it compares your
goals with the events in the Study Lamp calendar and lists what would change. Pressing **Apply** in the review
dialog is the only thing that writes, and only for the items you ticked. Plans expire after 15 minutes and can be
applied once.

| What | Direction |
|---|---|
| Title, due date | Both ways, after you confirm. If both sides changed the same field, you pick which one wins, per field |
| Completed | Study Lamp → Google only (a "✓ " in front of the event title). A ✓ added or removed in Google never changes a goal |
| Notes, priority, playlists | Not sent to Calendar |
| Deleting | Never synced. If an event is deleted in Google you choose: keep the goal and stop syncing it (default), put the event back, or delete the goal here too (needs its own confirmation) |

Events in the Study Lamp calendar that Study Lamp did not create can be imported as new goals (unticked by default,
and the Google event is left as it is) or hidden for good with "Don't ask about this event again". Timed events,
multi-day events and events without a usable title or date are listed as "Not applied" with the reason; they are never
guessed into a date.

A goal that you "stop syncing" after its event was deleted is skipped until its event exists in Google again.

## 7. Before enabling sync for real users: run the Google diagnostic

Two behaviours cannot be checked without calling Google: whether Google Tasks honours `If-Match` on `tasks.patch`, and
whether `calendars.insert`, `events.patch` (with `If-Match`) and `calendars.get` work under `calendar.app.created`.
Run the diagnostic once with a **test** Google account:

```
GOOGLE_ACCESS_TOKEN=<short-lived access token> node scripts/googleDiagnostic.mjs
```

- Get the token from the OAuth Playground with the scopes `tasks` and `calendar.app.created` (see the comment at the top
  of the script). Paste it only into that one command; do not save it.
- It prints **HTTP status codes and OK/FAIL lines only**: no tokens, ids, bodies or task/event text.
- It creates one throwaway task list and one throwaway calendar named "Study Lamp diagnostic" and deletes exactly those.
- `--tasks` or `--calendar` runs one half.
- If Tasks answers `200` to a stale `If-Match`, the app is still safe (every item is also checked by its fingerprint and
  etag at apply time), but stale detection is weaker. If Calendar returns `403`/`404` under `calendar.app.created`, stop
  and decide before widening any scope.

