import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assignDriveVideoOrders, dedupeDriveItems } from "./driveImportUtils";

describe("Drive bulk import preparation", () => {
  it("filters existing and repeated files while preserving selection order", () => {
    const items = [
      { driveFileId: "existing", title: "Existing" },
      { driveFileId: "new-a", title: "A" },
      { driveFileId: "new-a", title: "Duplicate A" },
      { driveFileId: "new-b", title: "B" },
    ];

    assert.deepEqual(dedupeDriveItems(items, ["existing"]), [items[1], items[3]]);
  });

  it("assigns consecutive order values from the playlist count", () => {
    const items = [{ title: "A" }, { title: "B" }, { title: "C" }];

    assert.deepEqual(assignDriveVideoOrders(items, 12), [
      { item: items[0], order: 12 },
      { item: items[1], order: 13 },
      { item: items[2], order: 14 },
    ]);
  });
});