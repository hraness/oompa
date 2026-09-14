import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, linkSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArguments, readProtectedAliasPlanFile, readProtectedProviderActivityEvidenceFile, readProtectedVercelAccessTokenFile } from "./current-project-alias-release";
import { readAliasInputBuffer } from "./alias-input-buffer";

const directories: string[] = [];
const fixture = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "oompa-alias-input-")));
  directories.push(directory);
  return directory;
};
const put = (directory: string, name: string, document: string | Uint8Array) => {
  const path = join(directory, name);
  writeFileSync(path, document, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const plan = {
  schemaVersion: 1, kind: "current-project-canonical-alias", alias: "oompa.app", version: "0.1.0",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  repository: { id: 1343008607, name: "hraness/oompa" },
  vercel: {
    projectId: "prj_8ciIt9t9foE3utG45frRN7cxckjS", teamId: "team_UAd1iD2XogJlbFg4h14mRaPM",
    source: { deploymentId: `dpl_${"a".repeat(24)}`, deploymentUrl: "oompa-source.vercel.app", sourceCommit: "a".repeat(40) },
    target: { deploymentId: `dpl_${"b".repeat(24)}`, deploymentUrl: "oompa-target.vercel.app", sourceCommit: "b".repeat(40) },
  },
  convex: { teamId: 513923, projectId: 2854545, deploymentId: 5089017,
    deploymentName: "qualified-hummingbird-537", deploymentUrl: "https://qualified-hummingbird-537.convex.cloud" },
};

describe("canonical alias explicit protected file arguments", () => {
  test("admits direct protected file inputs without inherited descriptors", () => {
    expect(parseArguments([
      "preflight", "--vercel-auth-file", "/private/session.json", "--plan-file", "/private/plan.json",
    ])).toEqual({
      operation: "preflight", planFd: 0,
      vercelAuthFile: "/private/session.json", planFile: "/private/plan.json",
    });
  });

  test("keeps descriptor mode and rejects ambiguous or unsafe file choices", () => {
    expect(parseArguments(["preflight", "--vercel-auth-fd", "3", "--plan-fd", "4"]))
      .toEqual({ operation: "preflight", vercelAuthFd: 3, planFd: 4 });
    expect(parseArguments(["recover-source", "--vercel-auth-file", "/private/auth.json",
      "--plan-file", "/private/plan.json", "--recovery-evidence-file", "/private/evidence.json"]))
      .toMatchObject({ operation: "recover-source", recoveryEvidenceFile: "/private/evidence.json" });
    const base = ["preflight", "--vercel-auth-file", "/private/auth.json"];
    for (const extra of [
      ["--vercel-auth-file", "/private/second.json"], ["--vercel-auth-fd", "3"],
      ["--vercel-cli", "/safe/vercel"], ["--plan-file", "/private/auth.json"],
      ["--plan-file", "/private/plan.json", "--plan-fd", "4"],
      ["--plan-fd", "4", "--plan-file", "/private/plan.json"],
      ["--recovery-evidence-file", "/private/evidence.json"],
    ]) expect(() => parseArguments([...base, ...extra])).toThrow("usage_invalid");
    for (const path of ["", "relative.json", "/private/../auth.json", "/private/./auth.json", "/".repeat(4097),
      ...Array.from({ length: 32 }, (_, index) => `/private/a${String.fromCharCode(index)}.json`), "/private/a\u007f.json"]) {
      for (const flag of ["--vercel-auth-file", "--plan-file", "--recovery-evidence-file"]) {
        const args = flag === "--vercel-auth-file" ? ["preflight", flag, path]
          : ["recover-source", "--vercel-auth-file", "/private/auth.json", flag, path];
        expect(() => parseArguments(args)).toThrow("usage_invalid");
      }
    }
    for (const tail of [
      ["--recovery-evidence-file", "/private/evidence.json", "--recovery-evidence-fd", "4"],
      ["--recovery-evidence-file", "/private/auth.json"],
      ["--recovery-evidence-file", "/private/evidence.json", "--recovery-evidence-file", "/private/other.json"],
    ]) expect(() => parseArguments(["recover-source", "--vercel-auth-file", "/private/auth.json", ...tail]))
      .toThrow("usage_invalid");
  });
});

describe("explicit protected alias files", () => {
  test("clears a partially populated buffer when the underlying read throws", () => {
    let retained: Buffer | undefined;
    const failure = new Error("synthetic partial read failure");
    expect(() => readAliasInputBuffer(20, (buffer, offset) => {
      retained = buffer;
      if (offset === 0) { buffer.fill(83, 0, 3); return 3; }
      throw failure;
    })).toThrow(failure);
    expect(retained).toBeDefined();
    expect(retained?.every((value) => value === 0)).toBe(true);
  });

  test("bounds partial reads and rejects truncated, growing or invalid byte counts", () => {
    for (let size = 1; size <= 32; size += 1) {
      for (let chunkSize = 1; chunkSize <= size; chunkSize += 1) {
        const actual = readAliasInputBuffer(size, (buffer, offset) => {
          const count = Math.min(chunkSize, size - offset);
          buffer.fill(83, offset, offset + count);
          return count;
        });
        expect(actual.subarray(0, size)).toEqual(Buffer.alloc(size, 83));
        expect(actual[size]).toBe(0);
      }
    }
    for (const count of [-1, 0, 4, 5, NaN, 1.5]) {
      let retained: Buffer | undefined;
      expect(() => readAliasInputBuffer(3, (buffer) => {
        retained = buffer; buffer.fill(83); return count;
      })).toThrow();
      expect(retained?.every((value) => value === 0)).toBe(true);
    }
    for (const size of [0, -1, 32769, NaN, 1.5]) {
      expect(() => readAliasInputBuffer(size, () => { throw new Error("must not read"); }))
        .toThrow("alias_input_size_invalid");
    }
  });
  test("reads exact private inputs and keeps the credential lifetime floor", () => {
    const directory = fixture();
    const auth = put(directory, "auth.json", JSON.stringify({ token: "fixture-session", expiresAt: 1900, refreshToken: "discarded" }));
    expect(readProtectedVercelAccessTokenFile(auth, 1000)).toBe("fixture-session");
    expect(() => readProtectedVercelAccessTokenFile(auth, 1001)).toThrow("provider_credentials_refused");
    const document = `${JSON.stringify(plan)}\n`;
    const planPath = put(directory, "plan.json", document);
    expect(readProtectedAliasPlanFile(planPath)).toBe(document);
    expect(() => readProtectedProviderActivityEvidenceFile(planPath)).toThrow("recovery_evidence_invalid");
    expect(() => readProtectedAliasPlanFile(put(directory, "foreign.json", JSON.stringify({ ...plan,
      vercel: { ...plan.vercel, projectId: "prj_retired_or_foreign" } })))).toThrow("input_invalid");
    const paddingBase = JSON.stringify({ token: "fixture-session", padding: "" });
    const maximumAuth = JSON.stringify({ token: "fixture-session", padding: "x".repeat(8192 - paddingBase.length) });
    expect(readProtectedVercelAccessTokenFile(put(directory, "maximum.json", maximumAuth))).toBe("fixture-session");
    expect(() => readProtectedVercelAccessTokenFile(put(directory, "too-large.json", `${maximumAuth} `)))
      .toThrow("provider_credentials_refused");
  });

  test("rejects symlinks, hardlinks, public permissions, special files and malformed bytes", () => {
    const directory = fixture();
    const readers = [readProtectedVercelAccessTokenFile, readProtectedAliasPlanFile, readProtectedProviderActivityEvidenceFile];
    const auth = put(directory, "auth.json", JSON.stringify({ token: "fixture-session" }));
    const symlink = join(directory, "symlink.json");
    symlinkSync(auth, symlink);
    const publicPath = put(directory, "public.json", JSON.stringify(plan));
    chmodSync(publicPath, 0o644);
    const empty = put(directory, "empty.json", "");
    const invalidUtf8 = put(directory, "invalid-utf8.json", new Uint8Array([0xff, 0xfe]));
    const oversized = put(directory, "oversized.json", "x".repeat(32 * 1024 + 1));
    for (const reader of readers) {
      for (const path of [symlink, publicPath, empty, invalidUtf8, oversized, directory, "/dev/null", join(directory, "absent")]) {
        expect(() => reader(path)).toThrow();
      }
    }
    const linked = join(directory, "hardlink.json");
    linkSync(auth, linked);
    for (const reader of readers) expect(() => reader(linked)).toThrow();
  });

  test("owned file opens do not repurpose inherited descriptors under allocation pressure", () => {
    const directory = fixture();
    const auth = put(directory, "auth.json", JSON.stringify({ token: "fixture-session" }));
    const held: number[] = [];
    try {
      while ((held.at(-1) ?? 0) <= 255) held.push(openSync("/dev/null", constants.O_RDONLY));
      const identities = held.map((fd) => fstatSync(fd));
      const nextAvailable = openSync("/dev/null", constants.O_RDONLY);
      closeSync(nextAvailable);
      expect(readProtectedVercelAccessTokenFile(auth)).toBe("fixture-session");
      const afterRead = openSync("/dev/null", constants.O_RDONLY);
      try { expect(afterRead).toBe(nextAvailable); } finally { closeSync(afterRead); }
      for (const [index, fd] of held.entries()) {
        const current = fstatSync(fd);
        expect([current.dev, current.ino, current.mode]).toEqual([
          identities[index]!.dev, identities[index]!.ino, identities[index]!.mode,
        ]);
      }
    } finally {
      for (const fd of held) closeSync(fd);
    }
  });

  test("rejects Darwin ACL grants on explicit file inputs", () => {
    if (process.platform !== "darwin") return;
    const directory = fixture();
    const path = put(directory, "acl.json", JSON.stringify({ token: "fixture-session" }));
    const result = spawnSync("/bin/chmod", ["+a", "everyone allow read", path], {
      timeout: 5000, maxBuffer: 8192, encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(() => readProtectedVercelAccessTokenFile(path)).toThrow("provider_credentials_refused");
    expect(() => readProtectedAliasPlanFile(path)).toThrow("input_not_protected");
    expect(() => readProtectedProviderActivityEvidenceFile(path)).toThrow("recovery_evidence_invalid");
  });

  test("real direct executable refuses a wrong-target file plan without exposing private input", () => {
    const directory = fixture();
    const auth = put(directory, "auth.json", JSON.stringify({ token: "fixture-session" }));
    const badPlan = put(directory, "bad-plan.json", JSON.stringify({ ...plan, alias: "foreign.example" }));
    const result = spawnSync(process.execPath, [join(import.meta.dir, "current-project-alias-release.ts"),
      "preflight", "--vercel-auth-file", auth, "--plan-file", badPlan], {
      timeout: 5000, maxBuffer: 8192, encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ status: "refused", code: "input_invalid" });
    expect(result.stderr).not.toContain("fixture-session");
    expect(result.stderr).not.toContain(directory);
  });
});
