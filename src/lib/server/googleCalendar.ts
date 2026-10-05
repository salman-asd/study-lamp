import crypto from "crypto";
import { addDaysToIsoDate, isValidIsoDate, isoDatePart } from "@/lib/isoDate";

export interface GoogleCalendarEventLike {
  id?: string | null;
  summary?: string | null;
  status?: string | null;
  start?: {
    date?: string | null;
    dateTime?: string | null;
  } | null;
  end?: {
    date?: string | null;
    dateTime?: string | null;
  } | null;
  extendedProperties?: {
    private?: Record<string, string | undefined>;
  } | null;
}

export interface GoalCalendarFields {
  title: string;
  targetDate: string | null;
  completed: boolean;
  cancelled: boolean;
}

export function stripGoogleCompletionMarker(title: string): string {
  return title.replace(/^\s*✓\s+/, "").trim();
}

export function eventToGoalFields(event: GoogleCalendarEventLike): GoalCalendarFields {
  const summary = event.summary ?? "";
  const completed = /^\s*✓\s+/.test(summary);
  const title = stripGoogleCompletionMarker(summary);
  const cancelled = (event.status ?? "") === "cancelled";

  const dateValue = event.start?.date ?? (event.start?.dateTime ? isoDatePart(event.start.dateTime) : null);
  if (!dateValue || !isValidIsoDate(dateValue)) {
    return { title: title || "", targetDate: null, completed, cancelled };
  }

  return {
    title,
    targetDate: dateValue,
    completed,
    cancelled,
  };
}

export function buildCalendarEventId(uid: string, goalId: string): string {
  const input = `${uid}:${goalId}`;
  const digest = crypto.createHash("sha256").update(input).digest();
  const alphabet = "abcdefghijklmnopqrstuv0123456789";
  let value = "";

  for (let i = 0; i < digest.length; i += 4) {
    let chunk = 0;
    for (let j = 0; j < 4 && i + j < digest.length; j += 1) {
      chunk = (chunk << 8) | digest[i + j];
    }
    value += alphabet[(chunk >> 24) & 31];
    value += alphabet[(chunk >> 16) & 31];
    value += alphabet[(chunk >> 8) & 31];
    value += alphabet[chunk & 31];
  }

  const id = value.slice(0, 64).replace(/[^a-v0-9]/g, "a");
  return id.length >= 5 ? id : `${"a".repeat(5 - id.length)}${id}`;
}

export function buildCalendarEvent(goal: { id: string; uid: string; title: string; targetDate: string; completed?: boolean; }): {
  summary: string;
  start: { date: string };
  end: { date: string };
  extendedProperties: { private: { studylampGoalId: string; uid: string } };
  status?: "confirmed";
} {
  if (!isValidIsoDate(goal.targetDate)) {
    throw new Error("Goal targetDate must be a valid ISO date.");
  }

  const title = goal.completed ? `✓ ${goal.title}` : goal.title;
  return {
    summary: title.trim().slice(0, 200),
    start: { date: goal.targetDate },
    end: { date: addDaysToIsoDate(goal.targetDate, 1) },
    extendedProperties: {
      private: {
        studylampGoalId: goal.id,
        uid: goal.uid,
      },
    },
    status: "confirmed",
  };
}

export class GoogleCalendarApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.code = code;
  }
}

async function calendarApiRequest<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleCalendarApiError(res.status, text || `Google Calendar API error (${res.status}).`);
  }

  return res.json() as Promise<T>;
}

export async function listCalendarEvents(accessToken: string, calendarId: string, options: { showDeleted?: boolean; timeMin?: string } = {}) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: String(Boolean(options.showDeleted)),
  });
  if (options.timeMin) params.set("timeMin", options.timeMin);

  return calendarApiRequest<{ items?: GoogleCalendarEventLike[]; nextPageToken?: string }>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
}

export async function getOrCreateStudyLampCalendar(accessToken: string, summary = "Study Lamp goals") {
  const list = await calendarApiRequest<{ items?: Array<{ id: string; summary?: string; timeZone?: string }> }>(
    accessToken,
    "/users/me/calendarList?minAccessRole=owner&showDeleted=false",
  );
  const match = list.items?.find((entry) => (entry.summary ?? "").trim().toLowerCase() === summary.trim().toLowerCase());
  if (match) return { id: match.id, summary: match.summary ?? summary, timeZone: match.timeZone ?? "UTC" };

  const created = await calendarApiRequest<{ id: string; summary?: string; timeZone?: string }>(
    accessToken,
    "/calendars",
    {
      method: "POST",
      body: JSON.stringify({ summary, timeZone: "UTC" }),
    },
  );
  return { id: created.id, summary: created.summary ?? summary, timeZone: created.timeZone ?? "UTC" };
}

export async function insertGoalEvent(accessToken: string, calendarId: string, goal: { id: string; uid: string; title: string; targetDate: string; completed?: boolean; }) {
  const eventId = buildCalendarEventId(goal.uid, goal.id);
  const payload = {
    id: eventId,
    ...buildCalendarEvent(goal),
  };
  return calendarApiRequest<{ id: string; status?: string; summary?: string }>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function patchGoalEvent(accessToken: string, calendarId: string, eventId: string, updates: Partial<GoogleCalendarEventLike>) {
  return calendarApiRequest<{ id: string; status?: string; summary?: string }>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
}

export async function deleteGoalEvent(accessToken: string, calendarId: string, eventId: string) {
  return calendarApiRequest<{ status?: string }>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}
