import * as XLSX from "xlsx";
import { posix as path } from "path";
import { readZipEntries } from "@/lib/server/zipReader";
import type { DocumentFileType } from "@/types";

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_ROWS_PER_SHEET = 5_000;

export class ScannedPdfError extends Error {
  constructor() {
    super("This looks like a scanned PDF; text extraction needs OCR");
    this.name = "ScannedPdfError";
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`));
  return match ? decodeXmlEntities(match[1]) : null;
}

function parseRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const id = xmlAttribute(match[1], "Id");
    const target = xmlAttribute(match[1], "Target");
    const targetMode = xmlAttribute(match[1], "TargetMode");
    if (id && target && targetMode !== "External") relationships.set(id, target);
  }
  return relationships;
}

function resolvePartPath(baseDirectory: string, target: string): string | null {
  const resolved = target.startsWith("/") ? path.normalize(target.slice(1)) : path.normalize(path.join(baseDirectory, target));
  return resolved === ".." || resolved.startsWith("../") || path.isAbsolute(resolved) ? null : resolved;
}

function extractXmlParagraphs(xml: string, omitSlideNumberPlaceholders = false): string[] {
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)) {
    const paragraph = match[0];
    if (omitSlideNumberPlaceholders && /<p:ph\b[^>]*\btype=["']sldNum["']/.test(paragraph)) continue;
    const runs = [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((run) => decodeXmlEntities(run[1]));
    const text = runs.join("").trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  readZipEntries(buffer);
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

function extractPptxText(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const presentation = entries.get("ppt/presentation.xml")?.toString("utf8");
  const presentationRelationships = entries.get("ppt/_rels/presentation.xml.rels")?.toString("utf8");
  if (!presentation || !presentationRelationships) throw new Error("Couldn't find the presentation order in this .pptx file.");

  const relationships = parseRelationships(presentationRelationships);
  const slideOrder = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/g)]
    .map((match) => xmlAttribute(match[1], "r:id"))
    .map((id) => id ? resolvePartPath("ppt", relationships.get(id) || "") : null)
    .filter((name): name is string => Boolean(name && entries.has(name)));
  if (slideOrder.length === 0) throw new Error("Couldn't find any slides in this .pptx file.");

  const output: string[] = [];
  slideOrder.forEach((slideName, index) => {
    const slideXml = entries.get(slideName)!.toString("utf8");
    const slideText = extractXmlParagraphs(slideXml).join(" ");
    if (slideText) output.push(`Slide ${index + 1}: ${slideText}`);

    const slideRelsPath = path.join(path.dirname(slideName), "_rels", `${path.basename(slideName)}.rels`);
    const slideRels = entries.get(slideRelsPath)?.toString("utf8");
    if (!slideRels) return;
    const notesTarget = [...parseRelationships(slideRels).values()].find((target) => /\/notesSlide$/.test(target) || /notesSlide\d*\.xml$/.test(target));
    if (!notesTarget) return;
    const notesName = resolvePartPath(path.dirname(slideName), notesTarget);
    const notesXml = notesName ? entries.get(notesName)?.toString("utf8") : undefined;
    if (!notesXml) return;
    const notes = extractXmlParagraphs(notesXml, true).join(" ");
    if (notes) output.push(`Notes ${index + 1}: ${notes}`);
  });

  return output.join("\n\n");
}

function extractXlsxText(buffer: Buffer): string {
  readZipEntries(buffer);
  const workbook = XLSX.read(buffer, { type: "buffer", cellText: true, cellDates: false });
  if (workbook.SheetNames.length === 0) throw new Error("Couldn't find any worksheets in this .xlsx file.");

  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: false })
      .slice(0, MAX_ROWS_PER_SHEET);
    const lines = rows.map((row) => row.map((cell) => String(cell ?? "")).join("\t"));
    return [`Sheet: ${name}`, ...lines].join("\n");
  }).join("\n\n");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const result = await extractText(pdf, { mergePages: true });
    const text = result.text.trim();
    if (!text) throw new ScannedPdfError();
    return text;
  } finally {
    await (pdf as typeof pdf & { destroy?: () => Promise<void> }).destroy?.();
  }
}

export async function extractDocumentText(buffer: Buffer, fileType: DocumentFileType): Promise<string> {
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error("This document is larger than the 50 MB extraction limit.");

  let text: string;
  switch (fileType) {
    case "docx": text = await extractDocxText(buffer); break;
    case "pptx": text = extractPptxText(buffer); break;
    case "xlsx": text = extractXlsxText(buffer); break;
    case "pdf": text = await extractPdfText(buffer); break;
    default: {
      const _exhaustive: never = fileType;
      throw new Error(`Unsupported document type: ${_exhaustive}`);
    }
  }
  return text.slice(0, MAX_EXTRACTED_TEXT_CHARS).trim();
}
