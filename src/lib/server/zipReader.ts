import zlib from "zlib";

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
  let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const CD_SIG = 0x02014b50;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(cdOffset) !== CD_SIG) break;
    const compressionMethod = buffer.readUInt16LE(cdOffset + 10);
    const compressedSize = buffer.readUInt32LE(cdOffset + 20);
    const nameLength = buffer.readUInt16LE(cdOffset + 28);
    const extraLength = buffer.readUInt16LE(cdOffset + 30);
    const commentLength = buffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
    const name = buffer.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLength);

    // Local file header tells us the actual data offset (its name/extra
    // fields can differ in length from the central directory's copy).
    const LFH_SIG = 0x04034b50;
    if (buffer.readUInt32LE(localHeaderOffset) === LFH_SIG) {
      const lfhNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfhNameLength + lfhExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        entries.set(name, compressionMethod === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
      } catch {
        // A corrupt or unsupported entry shouldn't abort the whole read —
        // callers only need a handful of specific parts (document.xml,
        // sharedStrings.xml, slideN.xml), not every entry to succeed.
      }
    }

    cdOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
