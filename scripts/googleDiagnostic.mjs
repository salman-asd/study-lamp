#!/usr/bin/env node
/**
 * Study Lamp: live Google diagnostic (audit M4). Run this ONCE with a TEST Google account before enabling Calendar or
 * Tasks sync for real users.
 *
 * It answers the two things the code cannot know without calling Google:
 *   1. Does Google Tasks honour If-Match on tasks.patch (412 for a stale etag)? Are deleted tasks listed?
 *   2. Do calendars.insert / events.insert / events.patch (If-Match) / calendars.get work under calendar.app.created?
 *
 * It prints HTTP STATUS CODES AND PASS/FAIL ONLY. It never prints a token, a response body, an id, or any task or event
 * text (Global Rule 4). It creates one throwaway task list and one throwaway calendar named "Study Lamp diagnostic",
 * and deletes exactly those two at the end. It never lists or touches your other lists or calendars, except that
 * calendarList.list is called once and only the STATUS CODE is printed.
 *
 * Usage (needs Node 18+; no dependencies):
 *   GOOGLE_ACCESS_TOKEN=<short-lived access token> node scripts/googleDiagnostic.mjs [--tasks] [--calendar]
 *
 * Get a token for a TEST account at https://developers.google.com/oauthplayground with the scopes
 *   https://www.googleapis.com/auth/tasks
 *   https://www.googleapis.com/auth/calendar.app.created
 * (use your own OAuth client in the playground settings if the app is in Testing mode). Paste the access token into
 * the environment variable for this one run; do not commit it or put it in a file.
 */

const token = process.env.GOOGLE_ACCESS_TOKEN;
if (!token) {
  console.error("Set GOOGLE_ACCESS_TOKEN (see the comment at the top of this file).");
  process.exit(2);
}

const args = new Set(process.argv.slice(2));
const runTasks = args.has("--tasks") || !args.has("--calendar");
const runCalendar = args.has("--calendar") || !args.has("--tasks");

const TASKS = "https://tasks.googleapis.com/tasks/v1";
const CAL = "https://www.googleapis.com/calendar/v3";

const rows = [];

async function call(label, method, url, { body, headers } = {}) {
  let status = 0;
  let json = null;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    if (status !== 204) json = await res.json().catch(() => null);
  } catch {
    status = 0; // network error; no details printed
  }
  rows.push({ label, status });
  console.log(`${String(status).padStart(3)}  ${label}`);
  return { status, json };
}

const verdicts = [];
function verdict(ok, text) {
  verdicts.push({ ok, text });
}

async function tasksDiagnostic() {
  console.log("\n== Google Tasks ==");
  const list = await call("tasklists.insert", "POST", `${TASKS}/users/@me/lists`, { body: { title: "Study Lamp diagnostic" } });
  const listId = list.json?.id;
  if (list.status !== 200 || !listId) {
    verdict(false, "Tasks: could not create the diagnostic list (check the token and the tasks scope).");
    return;
  }
  try {
    const task = await call("tasks.insert (with due date)", "POST", `${TASKS}/lists/${listId}/tasks`, {
      body: { title: "diagnostic", due: "2030-01-01T00:00:00.000Z" },
    });
    const taskId = task.json?.id;
    const etag = task.json?.etag;
    if (task.status !== 200 || !taskId) {
      verdict(false, "Tasks: tasks.insert failed.");
      return;
    }

    const stale = await call("tasks.patch with a STALE If-Match", "PATCH", `${TASKS}/lists/${listId}/tasks/${taskId}`, {
      body: { title: "diagnostic 2" },
      headers: { "If-Match": '"definitely-not-the-etag"' },
    });
    if (stale.status === 412) verdict(true, "Tasks honours If-Match: a stale etag is rejected with 412. Stale detection is strong.");
    else if (stale.status === 200) verdict(true, "Tasks IGNORES If-Match (200 for a stale etag). Stale detection relies on the fingerprint and etag in the plan only: still safe, but weaker (audit M4).");
    else verdict(false, `Tasks: tasks.patch with a stale If-Match returned an unexpected ${stale.status}.`);

    const fresh = await call("tasks.get (current etag)", "GET", `${TASKS}/lists/${listId}/tasks/${taskId}`);
    const current = fresh.json?.etag ?? etag;
    const good = await call("tasks.patch with the CURRENT If-Match", "PATCH", `${TASKS}/lists/${listId}/tasks/${taskId}`, {
      body: { status: "completed" },
      headers: { "If-Match": current },
    });
    verdict(good.status === 200, good.status === 200 ? "Tasks: patch with the current etag works." : `Tasks: patch with the current etag failed (${good.status}).`);

    await call("tasks.delete", "DELETE", `${TASKS}/lists/${listId}/tasks/${taskId}`);
    const listed = await call("tasks.list showCompleted+showHidden+showDeleted", "GET", `${TASKS}/lists/${listId}/tasks?showCompleted=true&showHidden=true&showDeleted=true`);
    const items = Array.isArray(listed.json?.items) ? listed.json.items : [];
    const returnsDeleted = items.some((item) => item?.id === taskId && item?.deleted === true);
    verdict(listed.status === 200, listed.status === 200
      ? returnsDeleted
        ? "Tasks: a deleted task IS returned with showDeleted=true (deleted:true). The planner can see 'deleted in Google'."
        : "Tasks: a deleted task is NOT returned even with showDeleted=true. 'Deleted in Google' would look like a missing task; the planner must treat a missing id as deleted."
      : `Tasks: tasks.list failed (${listed.status}).`);
  } finally {
    await call("tasklists.delete (the diagnostic list only)", "DELETE", `${TASKS}/users/@me/lists/${listId}`);
  }
}

async function calendarDiagnostic() {
  console.log("\n== Google Calendar (calendar.app.created) ==");
  const cal = await call("calendars.insert", "POST", `${CAL}/calendars`, { body: { summary: "Study Lamp diagnostic", timeZone: "UTC" } });
  const calId = cal.json?.id;
  if (cal.status !== 200 || !calId) {
    verdict(false, "Calendar: calendars.insert failed under calendar.app.created. STOP: do not widen the scope without a decision.");
    return;
  }
  const enc = encodeURIComponent(calId);
  try {
    const got = await call("calendars.get (the created calendar)", "GET", `${CAL}/calendars/${enc}`);
    verdict(got.status === 200, got.status === 200 ? "Calendar: calendars.get on the created calendar works (used to verify the stored calendar id)." : `Calendar: calendars.get returned ${got.status}.`);

    const event = await call("events.insert (all-day)", "POST", `${CAL}/calendars/${enc}/events`, {
      body: { summary: "diagnostic", start: { date: "2030-01-01" }, end: { date: "2030-01-02" } },
    });
    const eventId = event.json?.id;
    if (event.status !== 200 || !eventId) {
      verdict(false, "Calendar: events.insert failed.");
      return;
    }

    const stale = await call("events.patch with a STALE If-Match", "PATCH", `${CAL}/calendars/${enc}/events/${eventId}`, {
      body: { summary: "diagnostic 2" },
      headers: { "If-Match": '"definitely-not-the-etag"' },
    });
    if (stale.status === 412) verdict(true, "Calendar honours If-Match: a stale etag is rejected with 412.");
    else verdict(false, `Calendar: events.patch with a stale If-Match returned ${stale.status} (expected 412). Stale detection would be weaker.`);

    await call("events.delete", "DELETE", `${CAL}/calendars/${enc}/events/${eventId}`);
    const listed = await call("events.list showDeleted=true", "GET", `${CAL}/calendars/${enc}/events?showDeleted=true`);
    const items = Array.isArray(listed.json?.items) ? listed.json.items : [];
    const cancelled = items.some((item) => item?.id === eventId && item?.status === "cancelled");
    verdict(listed.status === 200, listed.status === 200
      ? cancelled ? "Calendar: a deleted event comes back as status:cancelled with showDeleted=true." : "Calendar: a deleted event is not returned as cancelled; check the planner's handling."
      : `Calendar: events.list failed (${listed.status}).`);

    // Status code only. The body (the user's other calendars) is never read or printed.
    await call("calendarList.list (status only)", "GET", `${CAL}/users/me/calendarList?maxResults=1`);
  } finally {
    await call("calendars.delete (the diagnostic calendar only)", "DELETE", `${CAL}/calendars/${enc}`);
  }
}

if (runTasks) await tasksDiagnostic();
if (runCalendar) await calendarDiagnostic();

console.log("\n== Summary ==");
for (const { ok, text } of verdicts) console.log(`${ok ? "OK  " : "FAIL"}  ${text}`);
const failed = verdicts.some((v) => !v.ok);
console.log(failed ? "\nSome checks failed. Do not enable sync for users until they are understood." : "\nAll checks completed. Keep the summary lines above; they answer audit M4.");
process.exit(failed ? 1 : 0);
