import { gzipSync, gunzipSync } from "node:zlib";

export const NATIVE_ARCHIVE_MAX_PACKED = 64 * 1024 * 1024;
export const NATIVE_ARCHIVE_MAX_EXPANDED = 160 * 1024 * 1024;
export const NATIVE_ARCHIVE_MAX_MEMBERS = 512;
const maximumFileBytes = 32 * 1024 * 1024;
const blockSize = 512;
export type NativeArchiveFile = Readonly<{ path: string; mode: 0o644 | 0o755; bytes: Uint8Array }>;

function refuse(): never { throw Error("NATIVE_PROCESS_ARCHIVE_INVALID"); }
function memberPath(path: string): string {
  if (!/^package\/[A-Za-z0-9._/-]+$/u.test(path) || path.length > 255
    || path.split("/").some(part => part === "" || part === "." || part === "..")) refuse();
  return path;
}
function admitUniquePath(seen: Set<string>, path: string): void {
  // macOS commonly extracts onto a case-insensitive filesystem. Also refuse a
  // regular file that another member would need to treat as its directory.
  const folded = path.toLowerCase();
  for (const previous of seen) {
    if (previous === folded || previous.startsWith(folded + "/") || folded.startsWith(previous + "/")) refuse();
  }
  seen.add(folded);
}
function textField(block: Buffer, start: number, size: number): string {
  const bytes = block.subarray(start, start + size);
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) refuse();
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(block: Buffer, start: number, size: number): number {
  const bytes = block.subarray(start, start + size);
  if (bytes.some(byte => byte > 0x7f)) refuse();
  const value = bytes.toString("ascii");
  if (!/^[0-7]+(?:\0| )*$/u.test(value)) refuse();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) refuse();
  return parsed;
}
function checksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < blockSize; index += 1) {
    const byte = block[index];
    if (byte === undefined) refuse();
    sum += index >= 148 && index < 156 ? 32 : byte;
  }
  return sum;
}

/** Inspect before extraction. This intentionally admits the small ordinary
 * USTAR dialect produced below: regular files only, exact canonical names,
 * bounded sizes, no extended metadata or link semantics. */
export function inspectNativeProcessArchive(compressed: Uint8Array): readonly NativeArchiveFile[] {
  if (compressed.byteLength < 1 || compressed.byteLength > NATIVE_ARCHIVE_MAX_PACKED) refuse();
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: NATIVE_ARCHIVE_MAX_EXPANDED }); }
  catch { return refuse(); }
  if (tar.length < blockSize * 3 || tar.length % blockSize !== 0) refuse();
  const files: NativeArchiveFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let ended = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every(byte => byte === 0)) {
      if (offset + blockSize * 2 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) refuse();
      ended = true;
      break;
    }
    if (files.length >= NATIVE_ARCHIVE_MAX_MEMBERS || octal(header, 148, 8) !== checksum(header)
      || !header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00", "ascii"))
      || (header[156] !== 0 && header[156] !== 48)
      || header.subarray(157, 257).some(byte => byte !== 0)) refuse();
    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    const path = memberPath(prefix === "" ? name : `${prefix}/${name}`);
    admitUniquePath(seen, path);
    const mode = octal(header, 100, 8);
    const size = octal(header, 124, 12);
    if ((mode !== 0o644 && mode !== 0o755) || size > maximumFileBytes) refuse();
    const begin = offset + blockSize;
    const next = begin + Math.ceil(size / blockSize) * blockSize;
    if (next > tar.length || tar.subarray(begin + size, next).some(byte => byte !== 0)) refuse();
    files.push(Object.freeze({ path, mode, bytes: Buffer.from(tar.subarray(begin, begin + size)) }));
    offset = next;
  }
  if (!ended || files.length === 0) refuse();
  return Object.freeze(files);
}

function writeOctal(header: Buffer, start: number, size: number, value: number): void {
  const text = value.toString(8).padStart(size - 1, "0");
  if (text.length !== size - 1) refuse();
  header.write(text, start, size - 1, "ascii");
}

/** Produce an npm-compatible archive once. No lifecycle script, package-manager
 * manifest rewriting, source discovery, or compression timestamp participates. */
export function createNativeProcessArchive(input: readonly NativeArchiveFile[]): Buffer {
  if (input.length === 0 || input.length > NATIVE_ARCHIVE_MAX_MEMBERS) refuse();
  const files = [...input].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  let total = blockSize * 2;
  for (const file of files) {
    const path = memberPath(file.path);
    if (file.bytes.byteLength > maximumFileBytes) refuse();
    admitUniquePath(seen, path);
    const header = Buffer.alloc(blockSize);
    let name = path, prefix = "";
    if (name.length > 100) {
      const split = path.lastIndexOf("/", 155);
      if (split < 1) refuse();
      prefix = path.slice(0, split); name = path.slice(split + 1);
    }
    if (name.length > 100 || prefix.length > 155) refuse();
    header.write(name, 0, 100, "ascii");
    header.write(prefix, 345, 155, "ascii");
    writeOctal(header, 100, 8, file.mode);
    writeOctal(header, 108, 8, 0); writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, file.bytes.byteLength); writeOctal(header, 136, 12, 0);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    header.write(checksum(header).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    const padded = Buffer.alloc(Math.ceil(file.bytes.byteLength / blockSize) * blockSize);
    padded.set(file.bytes);
    total += blockSize + padded.length;
    if (total > NATIVE_ARCHIVE_MAX_EXPANDED) refuse();
    chunks.push(header, padded);
  }
  chunks.push(Buffer.alloc(blockSize * 2));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (compressed.byteLength > NATIVE_ARCHIVE_MAX_PACKED) refuse();
  return compressed;
}
