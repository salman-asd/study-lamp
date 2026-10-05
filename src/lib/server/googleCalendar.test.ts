import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCalendarEvent, buildCalendarEventId, eventToGoalFields, getOrCreateStudyLampCalendar } from "./googleCalendar";

describe("googleCalendar helpers", () => {
  it("reads a Google event into Study Lamp goal fields and strips the completion marker", () => {
    const fields = eventToGoalFields({
      summary: "✓ Read chapter 2",
      status: "confirmed",
      start: { date: "2026-10-10" },
    });

    assert.deepEqual(fields, {
      title: "Read chapter 2",
      targetDate: "2026-10-10",
      completed: true,
      cancelled: false,
    });
  });

  it("supports timed event start values by extracting the ISO day", () => {
    const fields = eventToGoalFields({
      summary: "Read chapter 3",
      status: "confirmed",
      start: { dateTime: "2026-10-12T09:00:00-07:00" },
    });

    assert.equal(fields.title, "Read chapter 3");
    assert.equal(fields.targetDate, "2026-10-12");
    assert.equal(fields.completed, false);
  });

  it("builds a Google all-day event payload with a one-day end date and completion prefix", () => {
    const event = buildCalendarEvent({
      id: "goal-123",
      uid: "user-42",
      title: "Read chapter 4",
      targetDate: "2026-10-20",
      completed: true,
    });

    assert.equal(event.summary, "✓ Read chapter 4");
    assert.deepEqual(event.start, { date: "2026-10-20" });
    assert.deepEqual(event.end, { date: "2026-10-21" });
    assert.equal(event.extendedProperties.private.studylampGoalId, "goal-123");
  });

  it("creates deterministic event ids that are unique by user and goal and match the Google format", () => {
    const idA = buildCalendarEventId("user-42", "goal-123");
    const idB = buildCalendarEventId("user-42", "goal-123");
    const idC = buildCalendarEventId("user-99", "goal-123");

    assert.equal(idA, idB);
    assert.notEqual(idA, idC);
    assert.match(idA, /^[a-v0-9]{5,1024}$/);
  });

  it("creates the Study Lamp calendar when it does not already exist and reuses it otherwise", async () => {
    const calls: string[] = [];
    const originalFetch = global.fetch;

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).includes("calendarList")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(input).includes("/calendars")) {
        return new Response(JSON.stringify({ id: "calendar-123", summary: "Study Lamp goals", timeZone: "UTC" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      const created = await getOrCreateStudyLampCalendar("token-1");
      assert.equal(created.id, "calendar-123");
      assert.equal(created.summary, "Study Lamp goals");
      assert.ok(calls.some((call) => call.includes("calendarList")));
      assert.ok(calls.some((call) => call.includes("/calendars")));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
