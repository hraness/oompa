import { gunzipSync } from "node:zlib";

import { nativeInputHash } from "./native-process-build-inputs.ts";

export const NATIVE_CRATE_MAX_PACKED = 16 * 1024 * 1024;
const maximumExpanded = 32 * 1024 * 1024;
const blockSize = 512;
function refuse(): never { throw Error("NATIVE_PROCESS_CRATE_ARCHIVE_INVALID"); }
function text(block: Buffer, start: number, size: number): string {
  const bytes = block.subarray(start, start + size), end = bytes.indexOf(0);
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

/** Cargo registry archives are authenticated as a whole by Cargo.lock. Admit
 * only their bounded ordinary GNU regular-file dialect, without extracting or
 * interpreting GNU long names, links, sparse files, or extended metadata. This
 * separate parser does not broaden the public package's USTAR-only contract. */
export function nativeCrateChecksums(compressed: Uint8Array, stem: string, expectedSha256: string): Readonly<Record<string, string>> {
  if (!/^[a-zA-Z0-9_-]+-[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(stem)
    || stem.length > 257 || !/^[a-f0-9]{64}$/u.test(expectedSha256)
    || compressed.byteLength < 1 || compressed.byteLength > NATIVE_CRATE_MAX_PACKED
    || nativeInputHash(compressed) !== expectedSha256) refuse();
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: maximumExpanded }); }
  catch { return refuse(); }
  if (tar.length < 3 * blockSize || tar.length % blockSize !== 0) refuse();
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>(), directories = new Set<string>();
  let offset = 0, ended = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every(byte => byte === 0)) {
      if (offset + 2 * blockSize > tar.length || tar.subarray(offset).some(byte => byte !== 0)) refuse();
      ended = true; break;
    }
    let checksum = 0;
    for (let index = 0; index < blockSize; index += 1) {
      const byte = header[index];
      if (byte === undefined) refuse();
      checksum += index >= 148 && index < 156 ? 32 : byte;
    }
    if (seen.size >= 32_768 || octal(header, 148, 8) !== checksum
      || !header.subarray(257, 265).equals(Buffer.from("ustar  \0", "ascii"))
      || (header[156] !== 0 && header[156] !== 48)
      || header.subarray(157, 257).some(byte => byte !== 0)
      || header.subarray(345).some(byte => byte !== 0)) refuse();
    const path = text(header, 0, 100);
    if (!path.startsWith(stem + "/")) refuse();
    const local = path.slice(stem.length + 1), parts = local.split("/");
    if (!/^[a-zA-Z0-9._/-]+$/u.test(local) || parts.length > 16
      || parts.some(part => part === "" || part === "." || part === "..")) refuse();
    const folded = local.toLowerCase();
    if (seen.has(folded) || directories.has(folded)) refuse();
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/").toLowerCase());
    for (const parent of parents) if (seen.has(parent)) refuse();
    seen.add(folded);
    for (const parent of parents) directories.add(parent);
    const mode = octal(header, 100, 8), size = octal(header, 124, 12);
    if ((mode !== 0o644 && mode !== 0o755) || size > 16 * 1024 * 1024) refuse();
    const begin = offset + blockSize, next = begin + Math.ceil(size / blockSize) * blockSize;
    if (next > tar.length || tar.subarray(begin + size, next).some(byte => byte !== 0)) refuse();
    files[local] = nativeInputHash(tar.subarray(begin, begin + size));
    offset = next;
  }
  if (!ended || seen.size === 0 || files["Cargo.toml"] === undefined) refuse();
  return Object.freeze(files);
}
