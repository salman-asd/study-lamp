import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTasksClient, ensureStudyLampTaskList, GoogleTasksApiError, TasksListDeletedError } from "./googleTasks";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { calls, impl };
}

const sleeps: number[] = [];
const base = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0 };

describe("googleTasks client", () => {
  it("exposes no way to list the user's other lists and no delete", () => {
    const names = Object.keys(createTasksClient("t")).sort();
    assert.deepEqual(names, ["createTaskList", "getTask", "getTaskList", "insertTask", "listTasks", "patchTask"]);
  });

  it("every list call goes to the stored list id and asks for completed, hidden and deleted tasks", async () => {
    const { calls, impl } = fakeFetch([{ status: 200, body: { items: [{ id: "a" }] } }]);
    await createTasksClient("tok", { ...base, fetch: impl }).listTasks("LIST/1");
    assert.match(calls[0].url, /\/lists\/LIST%2F1\/tasks\?/);
    assert.match(calls[0].url, /showCompleted=true/);
    assert.match(calls[0].url, /showHidden=true/);
    assert.match(calls[0].url, /showDeleted=true/);
    assert.ok(!calls.some((c) => /users\/@me\/lists/.test(c.url) && c.method === "GET"));
  });

  it("paginates and flags truncation", async () => {
    const pages = [{ status: 200, body: { items: [{ id: "1" }], nextPageToken: "p2" } }, { status: 200, body: { items: [{ id: "2" }] } }];
    const f = fakeFetch([...pages]);
    const all = await createTasksClient("t", { ...base, fetch: f.impl }).listTasks("L");
    assert.deepEqual(all.items.map((i) => i.id), ["1", "2"]);
    assert.equal(all.truncated, false);
    assert.match(f.calls[1].url, /pageToken=p2/);

    const g = fakeFetch([{ status: 200, body: { items: [{ id: "1" }], nextPageToken: "p2" } }]);
    const cut = await createTasksClient("t", { ...base, fetch: g.impl }).listTasks("L", { maxPages: 1 });
    assert.equal(cut.truncated, true);
  });

  it("sends If-Match on patch; 412 becomes changed_remotely", async () => {
    const f = fakeFetch([{ status: 412, body: { error: { message: "secret body text" } } }]);
    await assert.rejects(
      () => createTasksClient("t", { ...base, fetch: f.impl }).patchTask("L", "T", { title: "x" }, { ifMatch: '"etag-1"' }),
      (e: unknown) => e instanceof GoogleTasksApiError && e.kind === "changed_remotely" && !e.message.includes("secret"),
    );
    assert.equal(f.calls[0].headers["If-Match"], '"etag-1"');
    assert.equal(f.calls[0].method, "PATCH");
  });

  it("retries 503 with backoff and honours Retry-After", async () => {
    sleeps.length = 0;
    const f = fakeFetch([{ status: 503 }, { status: 429, headers: { "Retry-After": "2" } }, { status: 200, body: { id: "t1" } }]);
    const task = await createTasksClient("t", { ...base, fetch: f.impl }).insertTask("L", { title: "a" });
    assert.equal(task.id, "t1");
    assert.equal(f.calls.length, 3);
    assert.equal(sleeps[1], 2000);
  });

  it("does not retry a 404 and classifies it as remote_missing", async () => {
    const f = fakeFetch([{ status: 404 }]);
    await assert.rejects(() => createTasksClient("t", { ...base, fetch: f.impl }).getTaskList("L"), (e: unknown) => e instanceof GoogleTasksApiError && e.kind === "remote_missing");
    assert.equal(f.calls.length, 1);
  });

  it("ensureStudyLampTaskList: verifies a stored id, never searches by name, reports a deleted list", async () => {
    const gets: string[] = [];
    let created = 0;
    const ok = { getTaskList: async (id: string) => { gets.push(id); return { id, title: "Study Lamp" }; }, createTaskList: async () => { created += 1; return { id: "new", title: "Study Lamp" }; } };
    assert.equal((await ensureStudyLampTaskList(ok, "L1")).created, false);
    assert.equal((await ensureStudyLampTaskList(ok, null)).created, true);
    assert.equal(created, 1);
    const gone = { ...ok, getTaskList: async () => { throw new GoogleTasksApiError(404, "remote_missing"); } };
    await assert.rejects(() => ensureStudyLampTaskList(gone, "L1"), TasksListDeletedError);
    assert.equal(created, 1);
  });
});
