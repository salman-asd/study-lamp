export const MAX_DOCUMENT_ANNOTATION_BYTES = 850 * 1024;

export interface DocumentAnnotationItem {
  annotation: { type: number; [key: string]: unknown };
}

export function prepareDocumentAnnotations(items: unknown[]): DocumentAnnotationItem[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const annotation = (item as { annotation?: unknown }).annotation;
    if (!annotation || typeof annotation !== "object") return [];
    const value = annotation as { type?: unknown; [key: string]: unknown };
    if (typeof value.type !== "number" || value.type === 13 || value.type === 17) return [];
    return [{ annotation: value as DocumentAnnotationItem["annotation"] }];
  });
}

export function serializeDocumentAnnotations(items: unknown[]): string {
  const json = JSON.stringify(prepareDocumentAnnotations(items));
  if (new TextEncoder().encode(json).byteLength > MAX_DOCUMENT_ANNOTATION_BYTES) {
    throw new Error("PDF annotations exceed the safe storage limit.");
  }
  return json;
}

export function parseDocumentAnnotations(json: unknown): unknown[] {
  if (typeof json !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? prepareDocumentAnnotations(parsed) : [];
  } catch {
    return [];
  }
}
