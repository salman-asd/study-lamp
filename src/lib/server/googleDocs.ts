export interface DocumentEndInfo {
  revisionId: string;
  endIndex: number;
}

export function assertAllowedDocumentRequests(requests: unknown): void {
  if (!Array.isArray(requests)) throw new Error("Document requests must be an array.");
  for (const request of requests) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Each document request must be an object.");
    }
    const keys = Object.keys(request as Record<string, unknown>);
    const invalid = keys.filter((key) => key !== "insertText" && key !== "updateParagraphStyle");
    if (invalid.length > 0) {
      throw new Error(`Blocking unsupported Google Doc request type: ${invalid[0]}`);
    }
  }
}

export async function getDocumentEnd(accessToken: string, documentId: string): Promise<DocumentEndInfo> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?fields=documentId,revisionId,body(content(endIndex))`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to read the Google document (${res.status}).`);
  }
  const data = await res.json();
  const content = Array.isArray(data?.body?.content) ? data.body.content : [];
  const endIndex = content.length > 0 ? Number(content[content.length - 1]?.endIndex ?? 1) : 1;
  if (!Number.isFinite(endIndex) || endIndex < 1) {
    throw new Error("Unable to determine where to append to this Google document.");
  }
  return { revisionId: String(data?.revisionId ?? ""), endIndex: Math.max(1, endIndex) };
}

export async function appendToDocument(accessToken: string, documentId: string, input: { revisionId: string; text: string; heading: string }): Promise<void> {
  const endInfo = await getDocumentEnd(accessToken, documentId);
  const payload: Record<string, unknown> = {
    requests: [
      {
        insertText: {
          location: { index: Math.max(0, endInfo.endIndex - 1) },
          text: `\n\n${input.heading}\n${input.text}`,
        },
      },
      {
        updateParagraphStyle: {
          range: { startIndex: Math.max(0, endInfo.endIndex - 1), endIndex: Math.max(0, endInfo.endIndex - 1) },
          paragraphStyle: { namedStyleType: "HEADING_2" },
          fields: "namedStyleType",
        },
      },
    ],
    writeControl: { requiredRevisionId: input.revisionId },
  };
  assertAllowedDocumentRequests(payload.requests);

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Unable to append to the Google document (${res.status}).`);
  }
}
