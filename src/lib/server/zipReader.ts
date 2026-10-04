import zlib from "zlib";

const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * A minimal ZIP (central-directory) reader, just enough to pull named
 * entries out of an OOXML file (.docx/.pptx/.xlsx — all of which are a ZIP
 * of XML parts) without adding a new npm dependency. Supports the two
 * compression methods any real-world Office file uses: 0 (stored) and 8
 * (deflate, via Node's built-in zlib.inflateRawSync — no native module
 * needed). Good enough for reading; this never writes a ZIP.
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();

  // End Of Central Directory record: find it by scanning backward for its
  // signature (0x06054b50), since it can be followed by a variable-length
  // comment field.
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error("Not a valid zip-based Office file (no end-of-central-directory record found).");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  if (totalEntries > MAX_ZIP_ENTRIES) throw new Error("This Office file contains too many ZIP entries.");
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  let totalUncompressedBytes = 0;

  const CD_SIG = 0x02014b50;
  for (let i = 0; i < totalEntries; i++) {
    if (cdOffset + 46 > buffer.length) throw new Error("This Office file has a malformed ZIP directory.");
    if (buffer.readUInt32LE(cdOffset) !== CD_SIG) throw new Error("This Office file has a malformed ZIP directory.");
    const compressionMethod = buffer.readUInt16LE(cdOffset + 10);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);
    const nameLength = buffer.readUInt16LE(cdOffset + 28);
    const extraLength = buffer.readUInt16LE(cdOffset + 30);
    const commentLength = buffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
    const entryEnd = cdOffset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) throw new Error("This Office file has a malformed ZIP directory.");
    const name = buffer.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLength);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("This Office file expands beyond the safe extraction limit.");
    }

    // Local file header tells us the actual data offset (its name/extra
    // fields can differ in length from the central directory's copy).
    const LFH_SIG = 0x04034b50;
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
      throw new Error("This Office file has a malformed ZIP entry.");
    }
    const lfhNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLength + lfhExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("This Office file has a truncated ZIP entry.");
    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (compressionMethod === 0) {
      content = Buffer.from(raw);
    } else if (compressionMethod === 8) {
      content = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize + 1) });
    } else {
      throw new Error("This Office file uses an unsupported ZIP compression method.");
    }
    if (content.length !== uncompressedSize) throw new Error("This Office file has an invalid ZIP entry size.");
    entries.set(name, content);

    cdOffset = entryEnd;
  }

  return entries;
}
