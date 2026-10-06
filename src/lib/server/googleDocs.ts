import { GoogleApiError, googleApiErrorFromResponse } from "@/lib/server/googleApiError";

export interface DocumentEndInfo {
  revisionId: string;
  endIndex: number;
}

export interface DocAppendInput {
  /** The revision read at apply time; Docs rejects the write if the document moved on. */
  revisionId: string;
  endIndex: number;
  /** Built once, here and nowhere else. Never contains a newline. */
  heading: string;
  body: string;
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

/** Removes control characters Docs rejects; keeps \n and \t. */
export function sanitizeDocText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export async function getDocumentEnd(accessToken: string, documentId: string): Promise<DocumentEndInfo> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?fields=documentId,revisionId,body(content(endIndex))`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw await googleApiErrorFromResponse(res);

  const data = await res.json();
  const content: Array<{ endIndex?: unknown }> = Array.isArray(data?.body?.content) ? data.body.content : [];
  const endIndex = content.length > 0 ? Number(content[content.length - 1]?.endIndex ?? 0) : 0;
  const revisionId = typeof data?.revisionId === "string" ? data.revisionId : "";
  // No revisionId means no edit access; we must not append without a revision to guard the write.
  if (!revisionId || !Number.isFinite(endIndex) || endIndex < 2) throw new GoogleApiError("unknown", 200);
  return { revisionId, endIndex };
}

/**
 * ONE batchUpdate (Z2 item 3):
 *   1. insertText at endIndex-1:  "\n\n<heading>\n<body>"
 *      (the first \n ends the current last paragraph, the second leaves one blank line, the final
 *       paragraph mark of the document ends our body)
 *   2. updateParagraphStyle over the heading paragraph ONLY: start = endIndex-1+2, end = start + heading.length + 1.
 * Indexes are UTF-16 code units, which is what String.length counts.
 */
export function buildDocAppendRequests(input: Pick<DocAppendInput, "endIndex" | "heading" | "body">): Array<Record<string, unknown>> {
  const insertAt = Math.max(1, input.endIndex - 1);
  const heading = sanitizeDocText(input.heading).replace(/\n+/g, " ").trim();
  const body = sanitizeDocText(input.body);
  const headingStart = insertAt + 2;
  const headingEnd = headingStart + heading.length + 1;

  return [
    { insertText: { location: { index: insertAt }, text: `\n\n${heading}\n${body}` } },
    {
      updateParagraphStyle: {
        range: { startIndex: headingStart, endIndex: headingEnd },
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType",
      },
    },
  ];
}

export async function appendToDocument(accessToken: string, documentId: string, input: DocAppendInput): Promise<void> {
  const requests = buildDocAppendRequests(input);
  assertAllowedDocumentRequests(requests);

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: input.revisionId } }),
  });
  if (!res.ok) throw await googleApiErrorFromResponse(res);
}
