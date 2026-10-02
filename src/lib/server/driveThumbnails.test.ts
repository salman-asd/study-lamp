import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_THUMBNAIL_BYTES,
  MISSING_THUMBNAIL_RETRY_MS,
  driveThumbnailDocId,
  isFreshMissingMarker,
  normalizeImageContentType,
  parseLegacyThumbnailDataUrl,
  readCappedBody,
  resizeDriveThumbnailUrl,
} from "./driveThumbnails";
import { driveThumbnailMarker, parseDriveThumbnailMarker } from "../driveThumbnailMarker";

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

describe("Drive thumbnail helpers", () => {
  it("requests a 320px Google thumbnail while preserving query parameters", () => {
    assert.equal(resizeDriveThumbnailUrl("https://googleusercontent.test/thumb=s220"), "https://googleusercontent.test/thumb=s320");
    assert.equal(resizeDriveThumbnailUrl("https://googleusercontent.test/thumb?s=old"), "https://googleusercontent.test/thumb=s320?s=old");
  });

  it("builds the server-only document id from connection and file ids", () => {
    assert.equal(driveThumbnailDocId("conn1234567", "file-ID_123456"), "conn1234567_file-ID_123456");
  });

  it("only accepts raster image content types (never SVG or non-images)", () => {
    assert.equal(normalizeImageContentType("image/JPEG; charset=binary"), "image/jpeg");
    assert.equal(normalizeImageContentType("image/webp"), "image/webp");
    assert.equal(normalizeImageContentType("image/svg+xml"), null);
    assert.equal(normalizeImageContentType("application/octet-stream"), null);
    assert.equal(normalizeImageContentType(""), null);
    assert.equal(normalizeImageContentType(null), null);
  });

  it("decodes legacy base64 thumbnails and rejects malformed or disallowed ones", () => {
    const legacy = `data:image/jpeg;base64,${Buffer.from("tiny-image").toString("base64")}`;
    const parsed = parseLegacyThumbnailDataUrl(legacy);
    assert.equal(parsed?.contentType, "image/jpeg");
    assert.equal(parsed?.bytes.toString(), "tiny-image");
    assert.equal(parseLegacyThumbnailDataUrl("data:image/svg+xml;base64,PHN2Zz4="), null);
    assert.equal(parseLegacyThumbnailDataUrl("data:text/html;base64,PGI+"), null);
    assert.equal(parseLegacyThumbnailDataUrl("not a data url"), null);
    assert.equal(parseLegacyThumbnailDataUrl(null), null);
    assert.equal(parseLegacyThumbnailDataUrl(`data:image/png;base64,${"A".repeat(40 * 1024)}`), null);
  });

  it("caps downloaded bytes by Content-Length and while streaming", async () => {
    assert.equal(await readCappedBody(streamResponse([new Uint8Array(10)], { "content-length": "999999" }), 100), null);
    assert.equal(await readCappedBody(streamResponse([new Uint8Array(60), new Uint8Array(60)]), 100), null);
    const ok = await readCappedBody(streamResponse([new Uint8Array(60), new Uint8Array(30)]), 100);
    assert.equal(ok?.length, 90);
    assert.equal(await readCappedBody(streamResponse([]), 100), null);
  });

  it("allows thumbnails far larger than the old 30 KB cap", async () => {
    const body = await readCappedBody(streamResponse([new Uint8Array(150 * 1024)]));
    assert.equal(body?.length, 150 * 1024);
    assert.ok(MAX_THUMBNAIL_BYTES >= 200 * 1024);
  });

  it("trusts a 'no thumbnail' marker only briefly", () => {
    const now = 1_000_000_000;
    assert.equal(isFreshMissingMarker(now - 1000, now), true);
    assert.equal(isFreshMissingMarker(now - MISSING_THUMBNAIL_RETRY_MS - 1, now), false);
    assert.equal(isFreshMissingMarker(0, now), false);
  });
});

describe("Drive thumbnail marker", () => {
  it("round-trips file and connection ids", () => {
    const marker = driveThumbnailMarker("file-ID_123456", "conn1234567");
    assert.equal(marker, "/api/drive/thumbnail/file-ID_123456?connectionId=conn1234567");
    assert.deepEqual(parseDriveThumbnailMarker(marker), { fileId: "file-ID_123456", connectionId: "conn1234567" });
  });

  it("returns null for non-markers and incomplete markers", () => {
    assert.equal(parseDriveThumbnailMarker("https://i.ytimg.com/vi/x/hq.jpg"), null);
    assert.equal(parseDriveThumbnailMarker("/api/drive/thumbnail/file-ID_123456"), null);
    assert.equal(parseDriveThumbnailMarker(null), null);
  });
});
