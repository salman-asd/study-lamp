import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCalendarEvent,
  buildCalendarEventId,
  classifyCalendarStatus,
  createCalendarClient,
  ensureStudyLampCalendar,
  eventToGoalFields,
  CalendarDeletedError,
  GoogleCalendarApiError,
  parseRetryAfterMs,
  type CalendarHttpDeps,
} from "./googleCalendar";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A scripted fetch that records every call (method + url + headers). */
function scriptedFetch(replies: Reply[]) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const sleeps: number[] = [];
  let i = 0;
  const deps: Partial<CalendarHttpDeps> = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return new Response(reply.status === 204 ? null : text, { status: reply.status, headers: reply.headers });
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
  };
  return { deps, calls, sleeps };
}

describe("googleCalendar helpers", () => {
  it("reads a Google event into Study Lamp goal fields and strips the completion marker", () => {
    const fields = eventToGoalFields({ summary: "✓ Read chapter 2", status: "confirmed", start: { date: "2026-10-10" } });
    assert.deepEqual(fields, { title: "Read chapter 2", targetDate: "2026-10-10", completed: true, cancelled: false });
  });

  it("builds a Google all-day event payload with a one-day end date and completion prefix", () => {
    const event = buildCalendarEvent({ id: "goal-123", uid: "user-42", title: "Read chapter 4", targetDate: "2026-10-20", completed: true });
    assert.equal(event.summary, "✓ Read chapter 4");
    assert.deepEqual(event.start, { date: "2026-10-20" });
    assert.deepEqual(event.end, { date: "2026-10-21" });
    assert.equal(event.extendedProperties.private.studylampGoalId, "goal-123");
  });

  it("creates deterministic event ids that are unique by user and goal and match the Google format", () => {
    const idA = buildCalendarEventId("user-42", "goal-123");
    assert.equal(idA, buildCalendarEventId("user-42", "goal-123"));
    assert.notEqual(idA, buildCalendarEventId("user-99", "goal-123"));
    assert.match(idA, /^[a-v0-9]{5,1024}$/);
  });
});

describe("googleCalendar error classification", () => {
  it("classifies statuses", () => {
    assert.equal(classifyCalendarStatus(401), "auth");
    assert.equal(classifyCalendarStatus(403), "scope_missing");
    assert.equal(classifyCalendarStatus(403, "rateLimitExceeded"), "retryable");
    assert.equal(classifyCalendarStatus(404), "remote_missing");
    assert.equal(classifyCalendarStatus(410), "remote_missing");
    assert.equal(classifyCalendarStatus(409), "exists");
    assert.equal(classifyCalendarStatus(412), "changed_remotely");
    assert.equal(classifyCalendarStatus(429), "retryable");
    assert.equal(classifyCalendarStatus(503), "retryable");
    assert.equal(classifyCalendarStatus(400), "invalid_request");
  });

  it("parses Retry-After as seconds or a date, capped", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs("9999"), 20000);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(new Date(1_000_000 + 3000).toUTCString(), 1_000_000), 3000);
  });

  it("never puts Google's response body in the error", async () => {
    const { deps } = scriptedFetch([{ status: 403, body: { error: { message: "SECRET-DETAIL user@example.com", errors: [{ reason: "forbidden" }] } } }]);
    const client = createCalendarClient("tok", deps);
    await assert.rejects(client.getCalendar("cal"), (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarApiError);
      assert.equal(error.kind, "scope_missing");
      assert.ok(!error.message.includes("SECRET-DETAIL"));
      return true;
    });
  });
});

describe("googleCalendar client", () => {
  it("retries retryable failures with backoff and honours Retry-After, then succeeds", async () => {
    const { deps, calls, sleeps } = scriptedFetch([
      { status: 503 },
      { status: 429, headers: { "Retry-After": "3" } },
      { status: 200, body: { id: "cal-1", summary: "Study Lamp goals" } },
    ]);
    const result = await createCalendarClient("tok", deps).getCalendar("cal-1");
    assert.equal(result.id, "cal-1");
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(sleeps[1], 3000);
    assert.ok(sleeps[0] > 0 && sleeps[0] <= 8000);
  });

  it("gives up after 3 retries", async () => {
    const { deps, calls } = scriptedFetch([{ status: 500 }]);
    await assert.rejects(createCalendarClient("tok", deps).getCalendar("cal-1"), (error: unknown) => error instanceof GoogleCalendarApiError && error.kind === "retryable");
    assert.equal(calls.length, 4);
  });

  it("does not retry non-retryable errors", async () => {
    const { deps, calls } = scriptedFetch([{ status: 404 }]);
    await assert.rejects(createCalendarClient("tok", deps).getEvent("cal", "ev"), (error: unknown) => error instanceof GoogleCalendarApiError && error.kind === "remote_missing");
    assert.equal(calls.length, 1);
  });

  it("follows nextPageToken and reports truncation at the page cap", async () => {
    const pages: Reply[] = [
      { status: 200, body: { items: [{ id: "a" }], nextPageToken: "p2" } },
      { status: 200, body: { items: [{ id: "b" }] } },
    ];
    const first = scriptedFetch(pages);
    const done = await createCalendarClient("tok", first.deps).listEvents("cal", { showDeleted: true });
    assert.deepEqual(done.items.map((e) => e.id), ["a", "b"]);
    assert.equal(done.truncated, false);
    assert.ok(first.calls[0].url.includes("showDeleted=true"));
    assert.ok(first.calls[1].url.includes("pageToken=p2"));

    const endless = scriptedFetch([{ status: 200, body: { items: [{ id: "x" }], nextPageToken: "more" } }]);
    const capped = await createCalendarClient("tok", endless.deps).listEvents("cal", { maxPages: 2 });
    assert.equal(capped.truncated, true);
    assert.equal(endless.calls.length, 2);
  });

  it("treats DELETE 204 (no body) as success", async () => {
    const { deps, calls } = scriptedFetch([{ status: 204 }]);
    await createCalendarClient("tok", deps).deleteEvent("cal", "ev");
    assert.equal(calls[0].method, "DELETE");
  });

  it("sends If-Match on patch and maps 412 to changed_remotely", async () => {
    const { deps, calls } = scriptedFetch([{ status: 412 }]);
    await assert.rejects(
      createCalendarClient("tok", deps).patchEvent("cal", "ev", { summary: "x" }, { ifMatch: '"etag-1"' }),
      (error: unknown) => error instanceof GoogleCalendarApiError && error.kind === "changed_remotely",
    );
    assert.equal(calls[0].headers["If-Match"], '"etag-1"');
    assert.equal(calls.length, 1);
  });

  it("maps 409 on insert to exists", async () => {
    const { deps } = scriptedFetch([{ status: 409 }]);
    await assert.rejects(
      createCalendarClient("tok", deps).insertEvent("cal", { id: "abc12", ...buildCalendarEvent({ id: "g", uid: "u", title: "t", targetDate: "2026-10-10" }) }),
      (error: unknown) => error instanceof GoogleCalendarApiError && error.kind === "exists",
    );
  });
});

describe("ensureStudyLampCalendar", () => {
  it("creates a calendar when none is stored, without listing the user's calendars", async () => {
    const calls: string[] = [];
    const client = {
      getCalendar: async () => { calls.push("get"); return { id: "x" }; },
      createCalendar: async (summary: string) => { calls.push(`create:${summary}`); return { id: "cal-new", summary }; },
    };
    const result = await ensureStudyLampCalendar(client, null);
    assert.deepEqual(result, { id: "cal-new", summary: "Study Lamp goals", created: true });
    assert.deepEqual(calls, ["create:Study Lamp goals"]);
  });

  it("verifies a stored calendar with get and does not create another", async () => {
    const calls: string[] = [];
    const client = {
      getCalendar: async (id: string) => { calls.push(`get:${id}`); return { id, summary: "Study Lamp goals" }; },
      createCalendar: async () => { calls.push("create"); return { id: "no" }; },
    };
    const result = await ensureStudyLampCalendar(client, "cal-1");
    assert.equal(result.created, false);
    assert.deepEqual(calls, ["get:cal-1"]);
  });

  it("reports a calendar deleted in Google instead of silently re-creating it", async () => {
    const calls: string[] = [];
    const client = {
      getCalendar: async () => { throw new GoogleCalendarApiError(404, "remote_missing"); },
      createCalendar: async () => { calls.push("create"); return { id: "no" }; },
    };
    await assert.rejects(ensureStudyLampCalendar(client, "cal-1"), CalendarDeletedError);
    assert.deepEqual(calls, []);
  });

  it("propagates other errors", async () => {
    const client = {
      getCalendar: async () => { throw new GoogleCalendarApiError(403, "scope_missing"); },
      createCalendar: async () => ({ id: "no" }),
    };
    await assert.rejects(ensureStudyLampCalendar(client, "cal-1"), (error: unknown) => error instanceof GoogleCalendarApiError && error.kind === "scope_missing");
  });
});
