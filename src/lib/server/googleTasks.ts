import { CALENDAR_MAX_PAGES, CALENDAR_MAX_RETRIES, parseRetryAfterMs, classifyCalendarStatus, type CalendarErrorKind, type CalendarHttpDeps } from "@/lib/server/googleCalendar";
import type { GoogleTaskLike, TaskPayload } from "@/lib/server/tasksGoalMapping";

/**
 * Google Tasks REST client (W4). Same rules as the Calendar client: no googleapis package, retry with backoff,
 * pagination, If-Match, errors that never carry Google's response body.
 *
 * SAFETY: every call takes the stored Study Lamp list id. There is deliberately NO method that lists the user's
 * other task lists. deleteTask exists ONLY for the explicit, confirmed removal in W5 (it takes the stored list id
 * like every other call). A test pins this method set.
 */

export type TasksErrorKind = CalendarErrorKind;

export class GoogleTasksApiError extends Error {
  status: number;
  kind: TasksErrorKind;
  code?: string;
  constructor(status: number, kind: TasksErrorKind, code?: string) {
    super(`Google Tasks request failed (${status}, ${kind}).`);
    this.name = "GoogleTasksApiError";
    this.status = status;
    this.kind = kind;
    this.code = code;
  }
}

/** Thrown by ensureStudyLampTaskList when the stored list no longer exists in Google. */
export class TasksListDeletedError extends Error {
  constructor() {
    super("The Study Lamp task list was deleted in Google.");
    this.name = "TasksListDeletedError";
  }
}

const TASKS_API = "https://tasks.googleapis.com/tasks/v1";
const PAGE_SIZE = 100;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;

const defaultDeps: CalendarHttpDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function readReason(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const errors = (parsed as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error?.errors;
    const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
    return typeof reason === "string" && reason.length <= 80 ? reason : undefined;
  } catch {
    return undefined;
  }
}

async function tasksRequest<T>(
  accessToken: string,
  path: string,
  options: { method?: string; body?: unknown; ifMatch?: string | null },
  deps: CalendarHttpDeps,
): Promise<T | undefined> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;

  for (let attempt = 0; ; attempt += 1) {
    let error: GoogleTasksApiError;
    let retryAfterMs: number | null = null;
    try {
      const res = await deps.fetch(`${TASKS_API}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (res.ok) {
        if (res.status === 204) return undefined;
        const text = await res.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new GoogleTasksApiError(res.status, "unknown", "bad_json");
        }
      }
      const reason = readReason(await res.text().catch(() => ""));
      error = new GoogleTasksApiError(res.status, classifyCalendarStatus(res.status, reason), reason);
      retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
    } catch (caught) {
      error = caught instanceof GoogleTasksApiError ? caught : new GoogleTasksApiError(0, "retryable", "network");
    }
    if (error.kind !== "retryable" || attempt >= CALENDAR_MAX_RETRIES) throw error;
    await deps.sleep(retryAfterMs ?? backoffMs(attempt, deps.random));
  }
}

async function requireBody<T>(promise: Promise<T | undefined>): Promise<T> {
  const value = await promise;
  if (value === undefined) throw new GoogleTasksApiError(502, "unknown", "empty_body");
  return value;
}

export interface TaskListInfo {
  id: string;
  title?: string;
}

export interface ListTasksResult {
  items: GoogleTaskLike[];
  /** True when the page cap was hit and more tasks exist. The planner must treat a truncated list as incomplete. */
  truncated: boolean;
}

/** Read-only surface. The Tasks planner depends on this and nothing wider. */
export interface TasksReadClient {
  listTasks(listId: string, options?: { maxPages?: number }): Promise<ListTasksResult>;
  getTask(listId: string, taskId: string): Promise<GoogleTaskLike>;
  getTaskList(listId: string): Promise<TaskListInfo>;
}

export interface TasksWriteClient extends TasksReadClient {
  createTaskList(title: string): Promise<TaskListInfo>;
  insertTask(listId: string, task: TaskPayload): Promise<GoogleTaskLike>;
  /** `ifMatch` is the etag the caller saw; a mismatch fails with kind "changed_remotely". */
  patchTask(listId: string, taskId: string, updates: TaskPayload, options?: { ifMatch?: string | null }): Promise<GoogleTaskLike>;
  /** W5 removal only (preview -> confirm -> apply). 404/410 fail with kind "remote_missing"; the caller treats that as already gone. */
  deleteTask(listId: string, taskId: string): Promise<void>;
}

export function createTasksClient(accessToken: string, overrides: Partial<CalendarHttpDeps> = {}): TasksWriteClient {
  const deps: CalendarHttpDeps = { ...defaultDeps, ...overrides };
  const listPath = (listId: string) => `/lists/${encodeURIComponent(listId)}`;
  const taskPath = (listId: string, taskId: string) => `${listPath(listId)}/tasks/${encodeURIComponent(taskId)}`;

  return {
    async listTasks(listId, options = {}) {
      const maxPages = Math.min(Math.max(1, options.maxPages ?? CALENDAR_MAX_PAGES), CALENDAR_MAX_PAGES);
      const items: GoogleTaskLike[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        // showCompleted + showHidden + showDeleted: without them completed/deleted tasks look "missing".
        const params = new URLSearchParams({ showCompleted: "true", showHidden: "true", showDeleted: "true", maxResults: String(PAGE_SIZE) });
        if (pageToken) params.set("pageToken", pageToken);
        const data = await requireBody(tasksRequest<{ items?: GoogleTaskLike[]; nextPageToken?: string }>(accessToken, `${listPath(listId)}/tasks?${params.toString()}`, {}, deps));
        items.push(...(data.items ?? []));
        pageToken = data.nextPageToken;
        if (!pageToken) return { items, truncated: false };
      }
      return { items, truncated: true };
    },
    getTask: (listId, taskId) => requireBody(tasksRequest<GoogleTaskLike>(accessToken, taskPath(listId, taskId), {}, deps)),
    getTaskList: (listId) => requireBody(tasksRequest<TaskListInfo>(accessToken, listPath(listId), {}, deps)),
    createTaskList: (title) => requireBody(tasksRequest<TaskListInfo>(accessToken, "/users/@me/lists", { method: "POST", body: { title } }, deps)),
    insertTask: (listId, task) => requireBody(tasksRequest<GoogleTaskLike>(accessToken, `${listPath(listId)}/tasks`, { method: "POST", body: task }, deps)),
    patchTask: (listId, taskId, updates, options = {}) =>
      requireBody(tasksRequest<GoogleTaskLike>(accessToken, taskPath(listId, taskId), { method: "PATCH", body: updates, ifMatch: options.ifMatch }, deps)),
    async deleteTask(listId, taskId) {
      await tasksRequest<undefined>(accessToken, taskPath(listId, taskId), { method: "DELETE" }, deps);
    },
  };
}

export interface EnsuredTaskList {
  id: string;
  title: string;
  created: boolean;
}

/**
 * Makes sure the user has THE Study Lamp task list without looking at their other lists: a stored id is verified
 * with tasklists.get, otherwise a new list is inserted. A stored list Google reports as gone (404/410) throws
 * TasksListDeletedError; the caller must then require a new explicit enable.
 */
export async function ensureStudyLampTaskList(
  client: Pick<TasksWriteClient, "getTaskList" | "createTaskList">,
  storedListId: string | null | undefined,
  title = "Study Lamp",
): Promise<EnsuredTaskList> {
  if (storedListId) {
    try {
      const existing = await client.getTaskList(storedListId);
      return { id: existing.id || storedListId, title: existing.title || title, created: false };
    } catch (error) {
      if (error instanceof GoogleTasksApiError && error.kind === "remote_missing") throw new TasksListDeletedError();
      throw error;
    }
  }
  const created = await client.createTaskList(title);
  return { id: created.id, title: created.title || title, created: true };
}
