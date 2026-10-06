import crypto from "crypto";
import { addDaysToIsoDate, isValidIsoDate, isoDatePart } from "@/lib/isoDate";

export interface GoogleCalendarEventLike {
  id?: string | null;
  etag?: string | null;
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

export interface CalendarGoalInput {
  id: string;
  uid: string;
  title: string;
  targetDate: string;
  completed?: boolean;
}

export interface CalendarEventPayload {
  summary: string;
  start: { date: string };
  end: { date: string };
  extendedProperties: { private: { studylampGoalId: string; uid: string } };
  status?: "confirmed";
}

export function buildCalendarEvent(goal: CalendarGoalInput): CalendarEventPayload {
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

// ─── Errors ─────────────────────────────────────────────────────────────────

/** What went wrong, in terms callers can act on. Never carries Google's response body. */
export type CalendarErrorKind =
  | "auth" // 401: the access token was rejected
  | "scope_missing" // 403 that is not a rate limit: no permission for this calendar/scope
  | "retryable" // 429, 5xx, network failure, 403 rate-limit reasons
  | "remote_missing" // 404 / 410
  | "exists" // 409: an event with this id already exists (also for deleted events)
  | "changed_remotely" // 412: If-Match did not match, the event changed in Google
  | "invalid_request" // 400
  | "unknown";

export class GoogleCalendarApiError extends Error {
  status: number;
  kind: CalendarErrorKind;
  code?: string;

  constructor(status: number, kind: CalendarErrorKind, code?: string) {
    // The message is generated here from the classification only. Google's
    // response body is never copied into it (Global Rule 4 / 5).
    super(`Google Calendar request failed (${status}, ${kind}).`);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.kind = kind;
    this.code = code;
  }
}

/** Thrown by ensureStudyLampCalendar when the stored calendar no longer exists in Google. */
export class CalendarDeletedError extends Error {
  constructor() {
    super("The Study Lamp calendar was deleted in Google.");
    this.name = "CalendarDeletedError";
  }
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export function classifyCalendarStatus(status: number, reason?: string): CalendarErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return reason && RATE_LIMIT_REASONS.has(reason) ? "retryable" : "scope_missing";
  if (status === 404 || status === 410) return "remote_missing";
  if (status === 409) return "exists";
  if (status === 412) return "changed_remotely";
  if (status === 400) return "invalid_request";
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return "retryable";
  return "unknown";
}

/** Reads ONLY the machine-readable `reason` out of a Google error body. The rest of the body is discarded. */
function readErrorReason(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (!error || typeof error !== "object") return undefined;
    const errors = (error as { errors?: unknown }).errors;
    if (!Array.isArray(errors) || errors.length === 0) return undefined;
    const reason = (errors[0] as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" && reason.length <= 80 ? reason : undefined;
  } catch {
    return undefined;
  }
}

// ─── HTTP layer (retry, backoff, pagination) ────────────────────────────────

export interface CalendarHttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

const defaultDeps: CalendarHttpDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export const CALENDAR_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 20_000;
export const CALENDAR_MAX_PAGES = 10;
const PAGE_SIZE = 250;
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds, capped. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  // "Full jitter": a random wait between half the ceiling and the ceiling.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  ifMatch?: string | null;
}

async function calendarRequest<T>(
  accessToken: string,
  path: string,
  options: RequestOptions,
  deps: CalendarHttpDeps,
): Promise<T | undefined> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  for (let attempt = 0; ; attempt += 1) {
    let error: GoogleCalendarApiError;
    let retryAfterMs: number | null = null;

    try {
      const res = await deps.fetch(`${CALENDAR_API}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (res.ok) {
        // 204 No Content (DELETE) has no body: res.json() would throw on success.
        if (res.status === 204) return undefined;
        const text = await res.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new GoogleCalendarApiError(res.status, "unknown", "bad_json");
        }
      }

      const reason = readErrorReason(await res.text().catch(() => ""));
      error = new GoogleCalendarApiError(res.status, classifyCalendarStatus(res.status, reason), reason);
      retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
    } catch (caught) {
      if (caught instanceof GoogleCalendarApiError) {
        error = caught;
      } else {
        // fetch itself failed (network). Treated as retryable; the cause is not kept.
        error = new GoogleCalendarApiError(0, "retryable", "network");
      }
    }

    if (error.kind !== "retryable" || attempt >= CALENDAR_MAX_RETRIES) throw error;
    await deps.sleep(retryAfterMs ?? backoffMs(attempt, deps.random));
  }
}

async function requireBody<T>(promise: Promise<T | undefined>): Promise<T> {
  const value = await promise;
  if (value === undefined) throw new GoogleCalendarApiError(502, "unknown", "empty_body");
  return value;
}

// ─── Typed client ───────────────────────────────────────────────────────────

export interface CalendarInfo {
  id: string;
  summary?: string;
  timeZone?: string;
}

export interface ListEventsOptions {
  showDeleted?: boolean;
  timeMin?: string;
  maxPages?: number;
}

export interface ListEventsResult {
  items: GoogleCalendarEventLike[];
  /** True when the page cap was hit and more events exist. The planner must treat a truncated list as incomplete. */
  truncated: boolean;
}

/** Read-only surface. The Calendar planner depends on this and nothing wider. */
export interface CalendarReadClient {
  listEvents(calendarId: string, options?: ListEventsOptions): Promise<ListEventsResult>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEventLike>;
  getCalendar(calendarId: string): Promise<CalendarInfo>;
}

export interface CalendarWriteClient extends CalendarReadClient {
  createCalendar(summary: string): Promise<CalendarInfo>;
  insertEvent(calendarId: string, event: CalendarEventPayload & { id: string }): Promise<GoogleCalendarEventLike>;
  /** `ifMatch` is the etag the caller saw; a mismatch fails with kind "changed_remotely". */
  patchEvent(
    calendarId: string,
    eventId: string,
    updates: Partial<CalendarEventPayload>,
    options?: { ifMatch?: string | null },
  ): Promise<GoogleCalendarEventLike>;
  deleteEvent(calendarId: string, eventId: string, options?: { ifMatch?: string | null }): Promise<void>;
}

export function createCalendarClient(accessToken: string, overrides: Partial<CalendarHttpDeps> = {}): CalendarWriteClient {
  const deps: CalendarHttpDeps = { ...defaultDeps, ...overrides };
  const calendarPath = (calendarId: string) => `/calendars/${encodeURIComponent(calendarId)}`;
  const eventPath = (calendarId: string, eventId: string) => `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;

  return {
    async listEvents(calendarId, options = {}) {
      const maxPages = Math.min(Math.max(1, options.maxPages ?? CALENDAR_MAX_PAGES), CALENDAR_MAX_PAGES);
      const items: GoogleCalendarEventLike[] = [];
      let pageToken: string | undefined;

      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({
          showDeleted: String(Boolean(options.showDeleted)),
          maxResults: String(PAGE_SIZE),
        });
        if (options.timeMin) params.set("timeMin", options.timeMin);
        if (pageToken) params.set("pageToken", pageToken);

        const data = await requireBody(calendarRequest<{ items?: GoogleCalendarEventLike[]; nextPageToken?: string }>(
          accessToken,
          `${calendarPath(calendarId)}/events?${params.toString()}`,
          {},
          deps,
        ));
        items.push(...(data.items ?? []));
        pageToken = data.nextPageToken;
        if (!pageToken) return { items, truncated: false };
      }

      return { items, truncated: true };
    },

    getEvent: (calendarId, eventId) =>
      requireBody(calendarRequest<GoogleCalendarEventLike>(accessToken, eventPath(calendarId, eventId), {}, deps)),

    getCalendar: (calendarId) =>
      requireBody(calendarRequest<CalendarInfo>(accessToken, calendarPath(calendarId), {}, deps)),

    createCalendar: (summary) =>
      requireBody(calendarRequest<CalendarInfo>(accessToken, "/calendars", { method: "POST", body: { summary, timeZone: "UTC" } }, deps)),

    insertEvent: (calendarId, event) =>
      requireBody(calendarRequest<GoogleCalendarEventLike>(accessToken, `${calendarPath(calendarId)}/events`, { method: "POST", body: event }, deps)),

    patchEvent: (calendarId, eventId, updates, options = {}) =>
      requireBody(calendarRequest<GoogleCalendarEventLike>(
        accessToken,
        eventPath(calendarId, eventId),
        { method: "PATCH", body: updates, ifMatch: options.ifMatch },
        deps,
      )),

    async deleteEvent(calendarId, eventId, options = {}) {
      await calendarRequest<undefined>(accessToken, eventPath(calendarId, eventId), { method: "DELETE", ifMatch: options.ifMatch }, deps);
    },
  };
}

// ─── Calendar setup ─────────────────────────────────────────────────────────

export interface EnsuredCalendar {
  id: string;
  summary: string;
  created: boolean;
}

/**
 * Makes sure the user has THE Study Lamp calendar, without ever looking at the
 * user's other calendars. It never searches by name (that could adopt a
 * calendar the user already owns): either the id we stored earlier is verified
 * with calendars.get, or a new calendar is inserted. It writes no events.
 *
 * A stored calendar that Google reports as gone (404/410) throws
 * CalendarDeletedError; the caller must then require a new explicit enable.
 */
export async function ensureStudyLampCalendar(
  client: Pick<CalendarWriteClient, "getCalendar" | "createCalendar">,
  storedCalendarId: string | null | undefined,
  summary = "Study Lamp goals",
): Promise<EnsuredCalendar> {
  if (storedCalendarId) {
    try {
      const existing = await client.getCalendar(storedCalendarId);
      return { id: existing.id || storedCalendarId, summary: existing.summary || summary, created: false };
    } catch (error) {
      if (error instanceof GoogleCalendarApiError && error.kind === "remote_missing") throw new CalendarDeletedError();
      throw error;
    }
  }

  const created = await client.createCalendar(summary);
  return { id: created.id, summary: created.summary || summary, created: true };
}
