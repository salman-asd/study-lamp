import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findUnreferencedThumbnailIds, parseThumbnailDocId } from "./thumbnailPrune";

const CONN_A = "AbCdEfGhIjKl";
const CONN_B = "ZyXwVuTsRqPo";
const FILE_1 = "1aBcDeFgHiJkLmNoPqRsT";
const FILE_2 = "2zYxWvUtSrQpOnMlKjIhG";

describe("parseThumbnailDocId", () => {
  it("splits on the first underscore, keeping underscores inside the file id", () => {
    assert.deepEqual(parseThumbnailDocId(`${CONN_A}_1abc_def-ghijk`), { connectionId: CONN_A, fileId: "1abc_def-ghijk" });
  });

  it("rejects malformed ids", () => {
    for (const id of ["", "nounderscore", "short_1aBcDeFgHiJkLmNoPqRsT", `${CONN_A}_tiny`, `${CONN_A}_bad/id/aaaaaaaaaa`]) {
      assert.equal(parseThumbnailDocId(id), null, id);
    }
  });
});

describe("findUnreferencedThumbnailIds", () => {
  const id = (conn: string, file: string) => `${conn}_${file}`;

  it("returns only thumbnails no record references", () => {
    const referenced = new Set([`${CONN_A}:${FILE_1}`]);
    const result = findUnreferencedThumbnailIds([id(CONN_A, FILE_1), id(CONN_A, FILE_2)], referenced);
    assert.deepEqual(result, [id(CONN_A, FILE_2)]);
  });

  it("keeps a thumbnail while any record still uses it (same file, other connection is a different key)", () => {
    const referenced = new Set([`${CONN_A}:${FILE_1}`]);
    const result = findUnreferencedThumbnailIds([id(CONN_A, FILE_1), id(CONN_B, FILE_1)], referenced);
    assert.deepEqual(result, [id(CONN_B, FILE_1)]);
  });

  it("never returns ids it cannot parse", () => {
    assert.deepEqual(findUnreferencedThumbnailIds(["garbage", ""], new Set()), []);
  });

  it("returns everything when nothing is referenced and nothing when all are", () => {
    const ids = [id(CONN_A, FILE_1), id(CONN_A, FILE_2)];
    assert.deepEqual(findUnreferencedThumbnailIds(ids, new Set()), ids);
    assert.deepEqual(findUnreferencedThumbnailIds(ids, new Set([`${CONN_A}:${FILE_1}`, `${CONN_A}:${FILE_2}`])), []);
  });
});
