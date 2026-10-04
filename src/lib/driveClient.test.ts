import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getSignedDriveUrls, refreshSignedDriveUrl } from "./driveClient";

interface SignRequest {
  items: Array<{ fileId: string; connectionId: string; purpose: string }>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function installSignFetch(options: { notFound?: Set<string>; status?: number } = {}) {
  const requests: SignRequest[] = [];
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as SignRequest;
    requests.push(body);
    if (options.status) return new Response(JSON.stringify({ error: "nope" }), { status: options.status });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const urls = body.items.map((item) => (
      options.notFound?.has(item.fileId)
        ? { ...item, error: "not_found" }
        : { ...item, url: `/signed/${item.fileId}`, exp }
    ));
    return new Response(JSON.stringify({ urls }), { status: 200 });
  }) as typeof fetch;
  return requests;
}

const connectionId = "conn123456789";
const thumb = (fileId: string) => ({ fileId, connectionId, purpose: "thumb" as const });

describe("signed URL batching", () => {
  it("sends concurrent requests as one batch and resolves each in order", async () => {
    const requests = installSignFetch();
    const results = await Promise.all([
      getSignedDriveUrls("token", "uid-batch", [thumb("file-aaaaaaaaaa")]),
      getSignedDriveUrls("token", "uid-batch", [thumb("file-bbbbbbbbbb"), thumb("file-cccccccccc")]),
    ]);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].items.map((item) => item.fileId), ["file-aaaaaaaaaa", "file-bbbbbbbbbb", "file-cccccccccc"]);
    assert.deepEqual(results, [["/signed/file-aaaaaaaaaa"], ["/signed/file-bbbbbbbbbb", "/signed/file-cccccccccc"]]);
  });

  it("collapses identical requests in one window into one payload item", async () => {
    const requests = installSignFetch();
    const urls = await Promise.all([
      getSignedDriveUrls("token", "uid-dedupe", [thumb("file-dddddddddd")]),
      getSignedDriveUrls("token", "uid-dedupe", [thumb("file-dddddddddd")]),
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].items.length, 1);
    assert.deepEqual(urls, [["/signed/file-dddddddddd"], ["/signed/file-dddddddddd"]]);
  });

  it("rejects only the item the server reports as not_found", async () => {
    installSignFetch({ notFound: new Set(["file-missing000"]) });
    const outcomes = await Promise.allSettled([
      getSignedDriveUrls("token", "uid-partial", [thumb("file-good000001")]),
      getSignedDriveUrls("token", "uid-partial", [thumb("file-missing000")]),
      getSignedDriveUrls("token", "uid-partial", [thumb("file-good000002")]),
    ]);

    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "rejected");
    assert.equal(outcomes[2].status, "fulfilled");
    if (outcomes[0].status === "fulfilled") assert.deepEqual(outcomes[0].value, ["/signed/file-good000001"]);
    if (outcomes[2].status === "fulfilled") assert.deepEqual(outcomes[2].value, ["/signed/file-good000002"]);
  });

  it("splits more than 50 items into several requests of at most 50", async () => {
    const requests = installSignFetch();
    const items = Array.from({ length: 120 }, (_, index) => thumb(`file-many${String(index).padStart(5, "0")}`));
    const urls = await getSignedDriveUrls("token", "uid-many", items);

    assert.equal(urls.length, 120);
    assert.ok(requests.every((request) => request.items.length <= 50));
    assert.equal(requests.reduce((total, request) => total + request.items.length, 0), 120);
    assert.equal(urls[119], "/signed/file-many00119");
  });

  it("rejects every pending item when the whole request fails", async () => {
    installSignFetch({ status: 429 });
    const outcomes = await Promise.allSettled([
      getSignedDriveUrls("token", "uid-fail", [thumb("file-fail000001")]),
      getSignedDriveUrls("token", "uid-fail", [thumb("file-fail000002")]),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
  });

  it("serves a still-valid URL from the client cache without another request", async () => {
    const requests = installSignFetch();
    await getSignedDriveUrls("token", "uid-cache", [thumb("file-cache00001")]);
    await getSignedDriveUrls("token", "uid-cache", [thumb("file-cache00001")]);
    assert.equal(requests.length, 1);

    await refreshSignedDriveUrl("token", "uid-cache", thumb("file-cache00001"));
    assert.equal(requests.length, 2, "refresh bypasses the cache");
  });
});
