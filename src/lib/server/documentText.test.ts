import assert from "node:assert/strict";
import zlib from "node:zlib";
import { describe, it } from "node:test";
import * as XLSX from "xlsx";

import { extractDocumentText } from "./documentText";
import { readZipEntries } from "./zipReader";

interface ZipFixtureEntry {
  name: string;
  content: Buffer | string;
  declaredSize?: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const compressed = zlib.deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.declaredSize ?? content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.declaredSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makePdf(text: string): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function makeDocx(text: string): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", content: "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>" },
    { name: "_rels/.rels", content: "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>" },
    { name: "word/document.xml", content: `<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ]);
}

function makePptx(): Buffer {
  return makeZip([
    { name: "ppt/presentation.xml", content: "<p:presentation xmlns:p=\"p\" xmlns:r=\"r\"><p:sldIdLst><p:sldId id=\"1\" r:id=\"rIdA\"/><p:sldId id=\"2\" r:id=\"rIdB\"/></p:sldIdLst></p:presentation>" },
    { name: "ppt/_rels/presentation.xml.rels", content: "<Relationships><Relationship Id=\"rIdA\" Type=\"slide\" Target=\"slides/slideZ.xml\"/><Relationship Id=\"rIdB\" Type=\"slide\" Target=\"slides/slideA.xml\"/></Relationships>" },
    { name: "ppt/slides/slideZ.xml", content: "<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>" },
    { name: "ppt/slides/slideA.xml", content: "<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>" },
    { name: "ppt/slides/_rels/slideZ.xml.rels", content: "<Relationships><Relationship Id=\"rNotes\" Type=\"notesSlide\" Target=\"../notesSlides/notesSlide1.xml\"/></Relationships>" },
    { name: "ppt/notesSlides/notesSlide1.xml", content: "<p:notes><a:p><a:r><a:t>Presenter notes</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r><p:ph type=\"sldNum\"/></a:p></p:notes>" },
  ]);
}

function makeXlsx(rowCount = 2): Buffer {
  const workbook = XLSX.utils.book_new();
  const rows: string[][] = [["Name", "Score"]];
  for (let index = 1; index < rowCount; index += 1) rows.push([`Student ${index}`, String(index)]);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Grades");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("document text extraction", () => {
  it("extracts PDF text and reports scanned PDFs clearly", async () => {
    assert.match(await extractDocumentText(makePdf("Readable PDF text"), "pdf"), /Readable PDF text/);
    await assert.rejects(extractDocumentText(makePdf(""), "pdf"), /This looks like a scanned PDF; text extraction needs OCR/);
  });

  it("extracts DOCX raw text with Mammoth", async () => {
    assert.match(await extractDocumentText(makeDocx("Word document text"), "docx"), /Word document text/);
  });

  it("orders PPTX slides by presentation relationships and includes notes", async () => {
    const text = await extractDocumentText(makePptx(), "pptx");
    assert.ok(text.indexOf("Slide 1: First slide") < text.indexOf("Slide 2: Second slide"));
    assert.match(text, /Notes 1: Presenter notes/);
    assert.doesNotMatch(text, /Notes 1: Presenter notes 2/);
  });

  it("extracts labeled XLSX rows and caps output at 5,000 rows per sheet", async () => {
    const text = await extractDocumentText(makeXlsx(5_010), "xlsx");
    assert.match(text, /Sheet: Grades/);
    assert.match(text, /Student 1\t1/);
    assert.doesNotMatch(text, /Student 5009/);
  });

  it("caps extracted text length", async () => {
    const text = await extractDocumentText(makeDocx("x".repeat(200_100)), "docx");
    assert.equal(text.length, 200_000);
  });

  it("rejects ZIP entries over the declared uncompressed-size budget before inflating", () => {
    const archive = makeZip([{ name: "oversized.xml", content: "tiny", declaredSize: 200 * 1024 * 1024 + 1 }]);
    assert.throws(() => readZipEntries(archive), /expands beyond the safe extraction limit/);
  });
});
