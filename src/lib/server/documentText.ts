import { readZipEntries } from "@/lib/server/zipReader";
import type { DocumentFileType } from "@/types";

// Server-only. Turns a downloaded PDF/Word/PowerPoint/Excel file into plain
// text good enough to feed the same AI pipeline a video transcript feeds
// (generateVideoSummary/generateVideoQuiz — see src/lib/ai/aiService.ts).
//
// docx/pptx/xlsx are all "OOXML": a zip of XML parts. Rather than add a new
// npm dependency for each, extraction here reads the zip directly (see
// zipReader.ts) and regex-pulls text nodes out of the relevant XML parts.
// This intentionally does not attempt full OOXML fidelity (tables laid out
// as tables, slide/paragraph structure, etc.) — it's a text-extraction
// pass for AI grounding, not a document converter.
//
// PDF text extraction is a fundamentally harder problem (arbitrary content
// streams, font encodings) that isn't practical to hand-roll — this uses
// `pdf-parse`, a small pure-JS dependency added to package.json. If it
// isn't installed yet (`npm install` needs to be run — see README-drive.md),
// PDF extraction throws a clear error rather than silently returning junk.

const TEXT_NODE_RE_DOCX = /<w:t[^>]*>([^<]*)<\/w:t>/g;
const TEXT_NODE_RE_PPTX = /<a:t[^>]*>([^<]*)<\/a:t>/g;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractDocxText(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const doc = entries.get("word/document.xml");
  if (!doc) throw new Error("Couldn't find word/document.xml in this .docx file.");
  const xml = doc.toString("utf8");
  const paragraphs: string[] = [];
  // Split on paragraph boundaries so runs stay grouped into readable lines
  // rather than one giant run-on string.
  for (const para of xml.split(/<\/w:p>/)) {
    const runs: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(TEXT_NODE_RE_DOCX);
    while ((match = re.exec(para))) runs.push(decodeXmlEntities(match[1]));
    const line = runs.join("").trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs.join("\n");
}

function extractPptxText(buffer: Buffer): string {
  const entries = readZipEntries(buffer);
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml/)?.[1] ?? 0);
      return na - nb;
    });
  if (slideNames.length === 0) throw new Error("Couldn't find any slides in this .pptx file.");

  const slides: string[] = [];
  slideNames.forEach((name, i) => {
    const xml = entries.get(name)!.toString("utf8");
    const runs: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(TEXT_NODE_RE_PPTX);
    while ((match = re.exec(xml))) runs.push(decodeXmlEntities(match[1]));
    const text = runs.join(" ").trim();
    if (text) slides.push(`Slide ${i + 1}: ${text}`);
  });
  return slides.join("\n\n");
}

function extractXlsxText(buffer: Buffer): string {
  const entries = readZipEntries(buffer);

  // Shared strings table — most cell text in a real workbook is stored here
  // and referenced by index from the sheet XML, rather than inline.
  const sharedStrings: string[] = [];
  const sst = entries.get("xl/sharedStrings.xml");
  if (sst) {
    const xml = sst.toString("utf8");
    for (const si of xml.split(/<\/si>/)) {
      const runs: string[] = [];
      let match: RegExpExecArray | null;
      const re = /<t[^>]*>([^<]*)<\/t>/g;
      while ((match = re.exec(si))) runs.push(decodeXmlEntities(match[1]));
      sharedStrings.push(runs.join(""));
    }
  }

  const sheetNames = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (sheetNames.length === 0) throw new Error("Couldn't find any worksheets in this .xlsx file.");

  const rowsOut: string[] = [];
  for (const name of sheetNames) {
    const xml = entries.get(name)!.toString("utf8");
    for (const row of xml.split(/<\/row>/)) {
      const cells: string[] = [];
      const cellRe = /<c[^>]*?(?:\st="([^"]*)")?[^>]*>(?:<v>([^<]*)<\/v>)?<\/c>/g;
      let m: RegExpExecArray | null;
      while ((m = cellRe.exec(row))) {
        const type = m[1];
        const raw = m[2];
        if (raw === undefined) continue;
        cells.push(type === "s" ? sharedStrings[Number(raw)] ?? "" : raw);
      }
      const line = cells.filter(Boolean).join("\t").trim();
      if (line) rowsOut.push(line);
    }
  }
  return rowsOut.join("\n");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  let pdfParse: any;
  try {
    // Dynamic import so a deployment that hasn't run `npm install` yet
    // (this dependency was added but couldn't be installed in the sandbox
    // this feature was built in — see README-drive.md) fails with a clear
    // message here instead of at build/boot time.
    const mod: any = await import("pdf-parse");
    pdfParse = typeof mod === "function" ? mod : mod.default;
  } catch {
    throw new Error("PDF text extraction needs the 'pdf-parse' package. Run `npm install` (see README-drive.md), then try again.");
  }
  const result = await pdfParse(buffer);
  return String(result.text || "").trim();
}

export async function extractDocumentText(buffer: Buffer, fileType: DocumentFileType): Promise<string> {
  switch (fileType) {
    case "docx": return extractDocxText(buffer);
    case "pptx": return extractPptxText(buffer);
    case "xlsx": return extractXlsxText(buffer);
    case "pdf": return extractPdfText(buffer);
    default: {
      const _exhaustive: never = fileType;
      throw new Error(`Unsupported document type: ${_exhaustive}`);
    }
  }
}
