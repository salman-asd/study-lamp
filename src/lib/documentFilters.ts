import type { DocumentFileType, PersonalDocument } from "@/types";

export type StudyMaterialTypeFilter = "all" | DocumentFileType;
export type StudyMaterialSort = "recent" | "title" | "size";

export interface StudyMaterialFilters {
  type: StudyMaterialTypeFilter;
  query?: string;
  categoryId?: string | null;
  tagIds?: string[];
  sort?: StudyMaterialSort;
}

export type StudyMaterialCounts = Record<StudyMaterialTypeFilter, number>;

export function countStudyMaterials(documents: PersonalDocument[]): StudyMaterialCounts {
  const counts: StudyMaterialCounts = { all: documents.length, pdf: 0, docx: 0, pptx: 0, xlsx: 0 };
  for (const document of documents) counts[document.fileType] += 1;
  return counts;
}

function dateMillis(value: PersonalDocument["createdAt"]): number {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  return 0;
}

export function filterAndSortStudyMaterials(
  documents: PersonalDocument[],
  filters: StudyMaterialFilters,
): PersonalDocument[] {
  const query = filters.query?.trim().toLocaleLowerCase() || "";
  const tagIds = filters.tagIds ?? [];
  const filtered = documents.filter((document) => {
    if (filters.type !== "all" && document.fileType !== filters.type) return false;
    if (query && !document.title.toLocaleLowerCase().includes(query)) return false;
    if (filters.categoryId && document.categoryId !== filters.categoryId) return false;
    if (tagIds.some((tagId) => !(document.tagIds ?? []).includes(tagId))) return false;
    return true;
  });

  switch (filters.sort ?? "recent") {
    case "title":
      return filtered.sort((a, b) => a.title.localeCompare(b.title));
    case "size":
      return filtered.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case "recent":
    default:
      return filtered.sort((a, b) => dateMillis(b.createdAt) - dateMillis(a.createdAt));
  }
}
