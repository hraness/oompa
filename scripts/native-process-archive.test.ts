import { expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createNativeProcessArchive, inspectNativeProcessArchive } from "./native-process-archive.ts";

const archive = () => createNativeProcessArchive([
  { path: "package/package.json", mode: 0o644, bytes: Buffer.from('{"name":"fixture"}\n') },
  { path: "package/native-artifacts/aarch64-apple-darwin/oompa-process-kernel", mode: 0o755, bytes: Buffer.from([1, 2, 3]) },
]);
function mutation(change: (tar: Buffer) => void, repairChecksum = true): Buffer {
  const tar = gunzipSync(archive()); change(tar);
  if (repairChecksum) {
    tar.fill(32, 148, 156);
    const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    tar.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  }
  return gzipSync(tar);
}
test("deterministic ordinary tar preserves exact bytes, long canonical names, and executable mode", () => {
  expect(archive()).toEqual(archive());
  const files = inspectNativeProcessArchive(archive());
  expect(files.map(file => [file.path, file.mode])).toEqual([
    ["package/native-artifacts/aarch64-apple-darwin/oompa-process-kernel", 0o755], ["package/package.json", 0o644],
  ]);
  expect(files[0]?.bytes).toEqual(Buffer.from([1, 2, 3]));
  const longPath = `package/native-artifacts/licenses/${"a".repeat(110)}/LICENSE.txt`;
  expect(inspectNativeProcessArchive(createNativeProcessArchive([{ path: longPath, mode: 0o644, bytes: new Uint8Array() }]))[0]?.path).toBe(longPath);
});
test("refuses symbolic links, hard links, devices, directories and extended tar metadata", () => {
  for (const type of ["1", "2", "3", "4", "5", "6", "x", "g", "L"]) {
    expect(() => inspectNativeProcessArchive(mutation(tar => { tar[156] = type.charCodeAt(0); }))).toThrow("ARCHIVE_INVALID");
  }
});
test("refuses escaping, absolute, empty-component, dot and noncanonical names before extraction", () => {
  for (const path of ["/tmp/file", "package/../file", "package/a/../../file", "package//file", "package/./file", "other/file", "package/a\\b"]) {
    expect(() => inspectNativeProcessArchive(mutation(tar => { tar.fill(0, 0, 100); tar.write(path, 0, 100); }))).toThrow("ARCHIVE_INVALID");
  }
});
test("refuses duplicate members, unsafe modes, link targets and invalid checksums", () => {
  expect(() => inspectNativeProcessArchive(mutation(tar => {
    tar.fill(0, 0, 100); tar.write("package/package.json", 0, 100);
  }))).toThrow("ARCHIVE_INVALID");
  expect(() => inspectNativeProcessArchive(mutation(tar => { tar.write("0000777\0", 100, 8); }))).toThrow("ARCHIVE_INVALID");
  expect(() => inspectNativeProcessArchive(mutation(tar => { tar.write("other", 157); }))).toThrow("ARCHIVE_INVALID");
  expect(() => inspectNativeProcessArchive(mutation(tar => { tar[0] = 0; }, false))).toThrow("ARCHIVE_INVALID");
});
test("refuses case collisions and file/directory-prefix conflicts before extraction", () => {
  for (const path of ["package/PACKAGE.json", "package/package.json/child"]) {
    expect(() => inspectNativeProcessArchive(mutation(tar => {
      tar.fill(0, 0, 100); tar.write(path, 0, 100);
    }))).toThrow("ARCHIVE_INVALID");
  }
});
test("refuses truncated contents, missing end blocks, nonzero padding and trailing payload", () => {
  const tar = gunzipSync(archive());
  expect(() => inspectNativeProcessArchive(gzipSync(tar.subarray(0, 700)))).toThrow("ARCHIVE_INVALID");
  expect(() => inspectNativeProcessArchive(gzipSync(tar.subarray(0, tar.length - 512)))).toThrow("ARCHIVE_INVALID");
  expect(() => inspectNativeProcessArchive(mutation(bytes => { bytes[515] = 9; }))).toThrow("ARCHIVE_INVALID");
  const appended = Buffer.concat([tar, Buffer.alloc(512, 1)]);
  expect(() => inspectNativeProcessArchive(gzipSync(appended))).toThrow("ARCHIVE_INVALID");
});
test("refuses forged oversized member lengths before slicing body", () => {
  expect(() => inspectNativeProcessArchive(mutation(tar => { tar.write("77777777777\0", 124, 12); }))).toThrow("ARCHIVE_INVALID");
});
test("refuses checksummed high-bit numeric and USTAR identity aliases", () => {
  for (const offset of [100, 124, 257, 262, 263, 264]) {
    expect(() => inspectNativeProcessArchive(mutation(tar => { tar[offset] = (tar[offset] ?? 0) | 0x80; }))).toThrow("ARCHIVE_INVALID");
  }
  // The checksum field is excluded from its own sum, so this remains a valid
  // checksum after ASCII decoding masks the high bit. Reject the raw byte.
  expect(() => inspectNativeProcessArchive(mutation(tar => { tar[148] = (tar[148] ?? 0) | 0x80; }, false))).toThrow("ARCHIVE_INVALID");
});
