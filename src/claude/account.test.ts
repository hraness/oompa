import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeAccountDocumentPath,
  readClaudeAccountMetadataIdentity,
  readClaudeAccountProjection,
  spawnClaudeAuthStatusProbe,
  type ClaudeAuthStatusProbe,
} from "./account";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "./pin";
import type { PinnedClaudeRuntime } from "./runtime";

const runtime: PinnedClaudeRuntime = Object.freeze({
  argv: ["/synthetic/bin/claude"] as const,
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/synthetic/bin/claude",
  model: CLAUDE_PIN_MODEL,
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  version: CLAUDE_PIN,
});

const accountMetadata = (identity: Readonly<Record<string, unknown>> = {}) => ({
  oauthAccount: {
    accountUuid: " Account-A ",
    emailAddress: " Account-A@Example.test ",
    organizationUuid: " Organization-A ",
    ...identity,
  },
});

function fifoTestsSupported(): boolean {
  return process.platform !== "win32" && Bun.which("mkfifo") !== null;
}

function makeFifo(path: string): void {
  const created = Bun.spawnSync({ cmd: ["mkfifo", path] });
  if (created.exitCode !== 0) {
    throw new Error(`mkfifo failed: ${new TextDecoder().decode(created.stderr)}`);
  }
}

async function rejectBeforeFifoWriter(pending: Promise<unknown>, fifo: string): Promise<void> {
  type Outcome =
    | Readonly<{ kind: "blocked" }>
    | Readonly<{ kind: "rejected"; error: unknown }>
    | Readonly<{ kind: "resolved" }>;
  const completion: Promise<Outcome> = pending.then(
    () => ({ kind: "resolved" }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "blocked" }), 1_000);
  });
  const outcome = await Promise.race([completion, blocked]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "rejected") {
    expect(outcome.error).toMatchObject({ code: "AUTHORITY_STALE" });
    return;
  }
  if (outcome.kind === "resolved") {
    throw new Error("Claude account FIFO was accepted as metadata.");
  }

  const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  await writer.close();
  await completion;
  throw new Error("Claude account FIFO open blocked instead of failing promptly.");
}

describe("Claude account projection", () => {
  test("the production status probe accepts coherent signed-out exit 1 and rejects contradictory exit 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-claude-account-status-"));
    const configDir = join(root, "config");
    const executablePath = join(root, "status-fixture");
    try {
      for (const exitCode of [1, 0]) {
        await writeFile(executablePath, [
          `#!${process.execPath}`,
          `console.log(${JSON.stringify(JSON.stringify({
            loggedIn: false,
            authMethod: "none",
            apiProvider: "firstParty",
            analyticsDisabled: false,
            projectsDirectory: join(configDir, "projects"),
          }))});`,
          `process.exit(${String(exitCode)});`,
        ].join("\n"), { mode: 0o700 });
        const pending = spawnClaudeAuthStatusProbe({
          configDir,
          configHome: "personal",
          runtime: { ...runtime, executablePath, argv: [executablePath] },
          signal: new AbortController().signal,
        });
        if (exitCode === 1) {
          await expect(pending).resolves.toMatchObject({ loggedIn: false });
        } else {
          await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("uses the documented personal and isolated account document paths", () => {
    expect(claudeAccountDocumentPath("/synthetic/.claude", "personal"))
      .toBe("/synthetic/.claude.json");
    expect(claudeAccountDocumentPath("/synthetic/profiles/work", "isolated"))
      .toBe("/synthetic/profiles/work/.claude.json");
    expect(() => claudeAccountDocumentPath("relative", "isolated"))
      .toThrow("must be absolute");
  });

  test("the metadata-only reader returns normalized scalars without authentication or document fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-claude-metadata-"));
    try {
      for (const configHome of ["personal", "isolated"] as const) {
        const configDir = join(root, configHome);
        await mkdir(configDir, { mode: 0o700 });
        const input = { configDir, configHome };
        expect(await readClaudeAccountMetadataIdentity(input)).toBeNull();
        const accountPath = claudeAccountDocumentPath(configDir, configHome);
        await writeFile(accountPath, JSON.stringify({
          ...accountMetadata(), unrelatedConfiguration: "fixture-only",
        }), { mode: 0o600 });
        const identity = await readClaudeAccountMetadataIdentity(input);
        expect(identity).toEqual({
          accountUuid: "account-a", email: "account-a@example.test", organizationUuid: "organization-a",
        });
        expect(Object.isFrozen(identity)).toBeTrue();
        await writeFile(accountPath, JSON.stringify(accountMetadata({ accountUuid: "x".repeat(321) })));
        await expect(readClaudeAccountMetadataIdentity(input)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
        await writeFile(accountPath, JSON.stringify(accountMetadata()));
        await chmod(accountPath, 0o644);
        await expect(readClaudeAccountMetadataIdentity(input)).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      }
      await expect(readClaudeAccountMetadataIdentity({ configDir: "relative", configHome: "isolated" }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fences a stable pre-status-post identity and projects account organization metadata", async () => {
    const calls: string[] = [];
    const statusInputs: unknown[] = [];
    const projection = await readClaudeAccountProjection({
      configDir: "/synthetic/profiles/work",
      configHome: "isolated",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async (path) => {
        calls.push(`metadata:${path}`);
        return accountMetadata();
      },
      probeAuthStatus: async (input) => {
        calls.push("status");
        statusInputs.push(input);
        return { loggedIn: true, authentication: "claude_ai" };
      },
    });

    expect(calls).toEqual([
      "metadata:/synthetic/profiles/work/.claude.json",
      "status",
      "metadata:/synthetic/profiles/work/.claude.json",
    ]);
    expect(statusInputs).toEqual([{
      configDir: "/synthetic/profiles/work",
      configHome: "isolated",
      runtime,
      signal: expect.any(AbortSignal),
    }]);
    expect(projection).toEqual({
      accountId: "account-a",
      email: "account-a@example.test",
      organizationId: "organization-a",
      signedIn: true,
    });
  });

  test("does not project metadata when the current status is signed out", async () => {
    const projection = await readClaudeAccountProjection({
      configDir: "/synthetic/.claude",
      configHome: "personal",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async () => accountMetadata(),
      probeAuthStatus: async () => ({ loggedIn: false, authentication: "none" }),
    });

    expect(projection).toEqual({ signedIn: false });
  });

  test.each([
    ["personal", false], ["personal", true], ["isolated", false], ["isolated", true],
  ] as const)("latches the original metadata profile across status (%s, changed=%s)", async (configHome, changedOriginal) => {
    const root = await mkdtemp(join(tmpdir(), "oompa-claude-account-latch-"));
    const configDir = join(root, "original"); const otherDir = join(root, "replacement");
    const otherHome = configHome === "personal" ? "isolated" : "personal";
    try {
      await mkdir(configDir, { mode: 0o700 }); await mkdir(otherDir, { mode: 0o700 });
      const originalPath = claudeAccountDocumentPath(configDir, configHome);
      await writeFile(originalPath, JSON.stringify(accountMetadata()), { mode: 0o600 });
      await writeFile(claudeAccountDocumentPath(otherDir, otherHome), JSON.stringify(accountMetadata({
        accountUuid: changedOriginal ? "account-a" : "account-b",
      })), { mode: 0o600 });
      const entered = Promise.withResolvers<Parameters<ClaudeAuthStatusProbe>[0]>();
      const finish = Promise.withResolvers<undefined>();
      const probeAuthStatus: ClaudeAuthStatusProbe = async (observed) => {
        entered.resolve(observed); await finish.promise;
        return { loggedIn: true, authentication: "claude_ai" };
      };
      const input = { configDir, configHome, runtime, signal: new AbortController().signal, probeAuthStatus };
      const completion = readClaudeAccountProjection(input).then(
        (projection) => ({ kind: "resolved" as const, projection }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      try {
        const observed = await Promise.race([entered.promise, completion.then(() => { throw new Error("status fixture was not reached"); })]);
        expect(observed).toMatchObject({ configDir, configHome });
        input.configDir = otherDir; input.configHome = otherHome;
        if (changedOriginal) await writeFile(originalPath, JSON.stringify(accountMetadata({ accountUuid: "account-b" })));
        finish.resolve(undefined);
        const outcome = await completion;
        if (changedOriginal) expect(outcome).toMatchObject({ kind: "rejected", error: { code: "AUTHORITY_STALE" } });
        else expect(outcome).toMatchObject({ kind: "resolved", projection: { signedIn: true, accountId: "account-a" } });
      } finally { finish.resolve(undefined); await completion; }
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  test("latches the probe profile before an injected metadata reader yields", async () => {
    const paths: string[] = []; const probes: unknown[] = [];
    const input = {
      configDir: "/synthetic/original", configHome: "isolated" as "isolated" | "personal", runtime, signal: new AbortController().signal,
      readMetadata: async (path: string) => {
        paths.push(path); input.configDir = "/synthetic/replacement"; input.configHome = "personal";
        return accountMetadata();
      },
      probeAuthStatus: async (observed: Parameters<ClaudeAuthStatusProbe>[0]) => {
        probes.push(observed); return { loggedIn: true, authentication: "claude_ai" };
      },
    };
    await expect(readClaudeAccountProjection(input)).resolves.toMatchObject({ accountId: "account-a" });
    expect(paths).toEqual(["/synthetic/original/.claude.json", "/synthetic/original/.claude.json"]);
    expect(probes).toEqual([{ configDir: "/synthetic/original", configHome: "isolated", runtime, signal: input.signal }]);
  });

  test("rejects an identity swap across the protected status read", async () => {
    let reads = 0;
    const projection = readClaudeAccountProjection({
      configDir: "/synthetic/.claude",
      configHome: "personal",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async () => {
        reads += 1;
        return accountMetadata({ accountUuid: reads === 1 ? "account-a" : "account-b" });
      },
      probeAuthStatus: async () => ({ loggedIn: true, authentication: "claude_ai" }),
    });

    await expect(projection).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
  });

  test("rejects bounded and unsafe metadata before trusting status", async () => {
    for (const accountUuid of ["x".repeat(321), "account\u0000-a"]) {
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir: "/synthetic/.claude",
        configHome: "personal",
        runtime,
        signal: new AbortController().signal,
        readMetadata: async () => accountMetadata({ accountUuid }),
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true, authentication: "claude_ai" };
        },
      });

      await expect(projection).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      expect(probed).toBeFalse();
    }
  });

  test("rejects a metadata document that fails its custody mode check", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-claude-account-"));
    const configDir = join(root, "config");
    const accountPath = claudeAccountDocumentPath(configDir, "isolated");
    try {
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await writeFile(accountPath, JSON.stringify(accountMetadata()), { mode: 0o644 });
      await chmod(accountPath, 0o644);
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir,
        configHome: "isolated",
        runtime,
        signal: new AbortController().signal,
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true, authentication: "claude_ai" };
        },
      });

      await expect(projection).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
      expect(probed).toBeFalse();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses a swapped account FIFO without waiting for a writer", async () => {
    if (!fifoTestsSupported()) return;
    const root = await mkdtemp(join(tmpdir(), "oompa-claude-account-fifo-"));
    const configDir = join(root, "config");
    const accountPath = claudeAccountDocumentPath(configDir, "isolated");
    try {
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      makeFifo(accountPath);
      let probed = false;
      const projection = readClaudeAccountProjection({
        configDir,
        configHome: "isolated",
        runtime,
        signal: new AbortController().signal,
        probeAuthStatus: async () => {
          probed = true;
          return { loggedIn: true, authentication: "claude_ai" };
        },
      });

      await rejectBeforeFifoWriter(projection, accountPath);
      expect(probed).toBeFalse();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("never attributes stale OAuth identity to another authenticated mode", async () => {
    const projection = await readClaudeAccountProjection({
      configDir: "/synthetic/.claude",
      configHome: "personal",
      runtime,
      signal: new AbortController().signal,
      readMetadata: async () => accountMetadata(),
      probeAuthStatus: async () => ({ loggedIn: true, authentication: "other" }),
    });
    expect(projection).toEqual({ signedIn: true });
  });

  test("rejects missing, widened, and incoherent authentication-mode evidence", async () => {
    for (const status of [
      { loggedIn: true },
      { loggedIn: true, authentication: "claude_ai", token: "must-not-cross" },
      { loggedIn: true, authentication: "none" },
      { loggedIn: false, authentication: "claude_ai" },
    ]) {
      await expect(readClaudeAccountProjection({
        configDir: "/synthetic/.claude",
        configHome: "personal",
        runtime,
        signal: new AbortController().signal,
        readMetadata: async () => accountMetadata(),
        probeAuthStatus: async () => status,
      })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    }
  });
});
