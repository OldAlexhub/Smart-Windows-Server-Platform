/** A tiny streaming ZIP writer for CSV exports. Files are stored without compression so exports
 * never need to be held in memory, even when a database contains large tables. */

export interface CsvZipFile {
  name: string;
  content: AsyncIterable<string | Uint8Array>;
}

interface ZipEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const ZIP32_MAX = 0xffff_ffff;
const UTF8_WITH_DESCRIPTOR = 0x0808;
const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function updateCrc(crc: number, data: Uint8Array): number {
  let next = crc;
  for (const byte of data) next = crcTable[(next ^ byte) & 0xff]! ^ (next >>> 8);
  return next >>> 0;
}

function dosTimestamp(now: Date): { time: number; date: number } {
  const year = Math.max(1980, now.getFullYear());
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX)
    throw new Error(`${label} is too large for one CSV archive.`);
}

/** Builds a standards-compatible .zip as an async stream. */
export async function* zipCsvFiles(files: CsvZipFile[], now = new Date()): AsyncGenerator<Buffer> {
  if (files.length > 0xffff) throw new Error("There are too many tables for one CSV archive.");
  const entries: ZipEntry[] = [];
  let offset = 0;
  const stamp = dosTimestamp(now);

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    if (!name.length || name.length > 0xffff) throw new Error("A table name is too long to export.");
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_WITH_DESCRIPTOR, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0xffff_ffff;
    let size = 0;
    for await (const part of file.content) {
      const chunk = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
      crc = updateCrc(crc, chunk);
      size += chunk.length;
      assertZip32(size, `Table ${file.name}`);
      yield chunk;
      offset += chunk.length;
      assertZip32(offset, "CSV archive");
    }
    crc = (crc ^ 0xffff_ffff) >>> 0;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x0807_4b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;
    entries.push({ name, crc, size, offset: localOffset, ...stamp });
  }

  const centralOffset = offset;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_WITH_DESCRIPTOR, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.size, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(entry.offset, 42);
    yield central;
    yield entry.name;
    offset += central.length + entry.name.length;
  }

  const centralSize = offset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}
