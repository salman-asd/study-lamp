import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersonalDocument } from "@/types";

import { countStudyMaterials, filterAndSortStudyMaterials } from "./documentFilters";

function makeDocument(
  id: string,
  fileType: PersonalDocument["fileType"],
  fields: Partial<PersonalDocument> = {},
): PersonalDocument {
  return {
    id,
    ownerId: "owner",
    title: id,
    fileType,
    mimeType: "application/octet-stream",
    driveFileId: id,
    driveConnectionId: "connection",
    createdAt: { toMillis: () => 0 } as PersonalDocument["createdAt"],
    updatedAt: null,
    ...fields,
  };
}

const documents = [
  makeDocument("Zebra notes", "pdf", { categoryId: "science", tagIds: ["review", "exam"], sizeBytes: 200, createdAt: { toMillis: () => 20 } as PersonalDocument["createdAt"] }),
  makeDocument("Alpha book", "docx", { categoryId: "science", tagIds: ["review"], sizeBytes: 100, createdAt: { toMillis: () => 10 } as PersonalDocument["createdAt"] }),
  makeDocument("Slides", "pptx", { categoryId: "history", tagIds: ["exam"], sizeBytes: 300, createdAt: null }),
  makeDocument("Budget", "xlsx", { sizeBytes: 50, createdAt: null }),
];

describe("Study Materials filters", () => {
  it("counts all supported formats without querying", () => {
    assert.deepEqual(countStudyMaterials(documents), { all: 4, pdf: 1, docx: 1, pptx: 1, xlsx: 1 });
  });

  it("filters by type, title, category, and all selected tags", () => {
    const filtered = filterAndSortStudyMaterials(documents, {
      type: "all",
      query: "notes",
      categoryId: "science",
      tagIds: ["review", "exam"],
    });
    assert.deepEqual(filtered.map((document) => document.id), ["Zebra notes"]);
  });

  it("sorts recent, title, and size without mutating the source list", () => {
    assert.deepEqual(filterAndSortStudyMaterials(documents, { type: "all", sort: "recent" }).map((d) => d.id), ["Zebra notes", "Alpha book", "Slides", "Budget"]);
    assert.deepEqual(filterAndSortStudyMaterials(documents, { type: "all", sort: "title" }).map((d) => d.id), ["Alpha book", "Budget", "Slides", "Zebra notes"]);
    assert.deepEqual(filterAndSortStudyMaterials(documents, { type: "all", sort: "size" }).map((d) => d.id), ["Slides", "Zebra notes", "Alpha book", "Budget"]);
    assert.equal(documents[0].id, "Zebra notes");
  });
});
