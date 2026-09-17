import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { z } from "zod";

import packageMetadata from "../package.json";

import {
  admitExactDaemonStop,
  daemonRunProcessArguments,
  daemonRunProcessOptions,
  DAEMON_ENVIRONMENT_KEYS,
  EDITOR_ENVIRONMENT_KEYS,
  HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES,
  initialize,
  isExactProviderRuntimeAuthorityCurrent,
  main,
  personalClaudeConfigHomeForInstallation,
  providerRuntimeAuthorityPredicate,
  protectedTerminalControlLibrariesForPlatform,
  protectedTerminalInputQueueForPlatform,
  readHiddenProtectedLineFromTerminal,
  releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration,
  renderRemoteSuccess,
  resolveDaemonCloudStartup,
  resolveSessionEventCursorCodec,
  runDaemon,
  selectDaemonCloudControl,
  stopDaemonWithExactAuthority,
  withProtectedTerminalLifecycle,
  type DaemonStopDependencies,
} from "./cli";
import { readClaudeAccountProjection } from "./claude/account";
import { spawnBunClaudeProcess } from "./claude/process";
import { allowlistedEnvironment, SAFE_ENVIRONMENT_KEYS } from "./codex/index";
import {
  ClaudeError,
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  type ClaudeLoginSignal,
  type ClaudeLoginSignalSource,
} from "./claude/index";
import {
  DEVIN_MODEL,
  DEVIN_PIN,
} from "./devin/index";
import { ShellTerminalCoordinator } from "./cli/shell-terminal";
import {
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudDaemonJournal,
  MemoryCloudDaemonJournal,
  type CloudProjectionRecoveryJournalEntry,
} from "./cloud/daemon-journal";
import {
  cloudDeploymentAuthorityFromEnvironment,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
} from "./cloud/identity-custody";
import type { CloudSecretCustodyPort } from "./cloud/local-control";
import type { CommandResponse, LocalCommand } from "./domain/contracts";
import { describeWorkProtocol } from "./domain/work-protocol";
import {
  PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
  type ProtectedInteractionDetailDocument,
} from "./domain/interactions";
import type { RootStatus } from "./domain/observation";
import { claudeAccountLoginAbandonCommand, claudeAccountLoginCommand, usageForGroup } from "./cli/parser";
import { renderProtectedInteractionDetail } from "./cli/render";
import {
  DAEMON_PROTOCOL,
  DaemonAuthoritySafetyError,
  DaemonLock,
  daemonAuthorityDatabasePath,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityReceipt,
} from "./daemon/daemon-lock";
import {
  LocalDaemonIndeterminateError,
  LocalDaemonUnavailableError,
} from "./daemon/local-transport";
import { createAcceptanceInstallation } from "../scripts/live-acceptance-installation";
import { createProductionInstallation } from "./installation";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "./storage/paths";
import { FileSecretBackend, GenerationalSecretCustody } from "./storage/secret-custody";
import { StateStore } from "./storage/state-store";
import { privateTask48DatabaseBytes } from "../scripts/fixtures/private-task48";

const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    output: { writeStdout: (value: string) => { stdout += value; }, writeStderr: (value: string) => { stderr += value; } },
    read: () => ({ stdout, stderr }),
  };
};

const cliClaudeRuntime = {
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  argv: ["/test/claude", "--print"] as const,
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/test/claude",
  model: CLAUDE_PIN_MODEL,
  version: CLAUDE_PIN,
} as const;

const cliDevinRuntime = {
  argv: ["/test/devin", "acp", "--model", DEVIN_MODEL] as const,
  build: "bcbe88c7",
  executablePath: "/test/devin",
  model: DEVIN_MODEL,
  version: DEVIN_PIN,
  versionOutput: `devin ${DEVIN_PIN} (bcbe88c7)`,
} as const;

class CliClaudeLoginSignalSource implements ClaudeLoginSignalSource {
  readonly listeners = new Map<ClaudeLoginSignal, Set<() => void>>();

  add(signal: ClaudeLoginSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  remove(signal: ClaudeLoginSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ClaudeLoginSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

// Install a byte-authentic older private release. Selective teardown of the
// combined schema would invent a historical cohort that no binary wrote.
const installPrivateTask48State = (databasePath: string): void => {
  const database = new Database(databasePath, { create: false, strict: true });
  const projects = database.query<{
    id: string; label: string; label_key: string; root_path: string; is_default: number;
    created_at: number; updated_at: number;
  }, []>("SELECT id,label,label_key,root_path,is_default,created_at,updated_at FROM projects").all();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close(false);
  writeFileSync(databasePath, privateTask48DatabaseBytes(), { mode: 0o600 });
  // Preserve the real `init`-created project through the compatible released
  // project table. This does not rewrite any schema or custody evidence.
  const historical = new Database(databasePath, { create: false, strict: true });
  try {
    for (const project of projects) {
      historical.query(`INSERT INTO projects
        (id,label,label_key,root_path,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run(project.id, project.label, project.label_key, project.root_path, project.is_default,
          project.created_at, project.updated_at);
    }
  } finally {
    historical.close(false);
  }
};
// An install written by a newer Oompa build than this one. No migration exists for
// it, so every entry point must refuse instead of guessing.
// Keep this expectation independent of the implementation's schema constant.
const expectedStateSchemaVersion = 62;
const advanceStateSchema = (databasePath: string): void => {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    database.exec(`PRAGMA user_version=${expectedStateSchemaVersion + 1}`);
  } finally {
    database.close(false);
  }
};

const stateSchemaVersion = (databasePath: string): number => {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close(false);
  }
};

const readFixtureDaemonGeneration = (databasePath: string): number => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = database.query<{ generation: number }, []>(
      "SELECT generation FROM daemon_state WHERE singleton=1",
    ).get();
    if (row === null) throw new Error("Expected fixture daemon state.");
    return row.generation;
  } finally {
    database.close();
  }
};

// Compare all logical database content, including immutable evidence, complete
// schema SQL, column metadata, ledger and user_version. Only row order is sorted.
const stateSchemaSnapshot = (databasePath: string): string => {
  const database = new Database(databasePath, { readonly: true, strict: true });
  const read = (sql: string) => {
    const statement = database.prepare(sql);
    try { return statement.all(); } finally { statement.finalize(); }
  };
  try {
    return database.transaction(() => {
      const schema = read("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
      const tables = z.array(z.object({ type: z.string(), name: z.string().regex(/^[A-Za-z0-9_]+$/u) }))
        .parse(schema).filter((row) => row.type === "table");
      return JSON.stringify({
        schema,
        tables: tables.map(({ name }) => ({
          name,
          columns: read(`PRAGMA table_xinfo("${name}")`),
          rows: read(`SELECT * FROM "${name}"`).map((row) => JSON.stringify(row)).sort(),
        })),
        version: read("PRAGMA user_version"),
      });
    }).deferred();
  } finally { database.close(false); }
};

const upgradeFixture = async (
  name: string,
): Promise<Readonly<{ installation: ReturnType<typeof createAcceptanceInstallation>; runRoot: string }>> => {
  const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)));
  return {
    installation: createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, `project-a-${name}`),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, `device-a-${name}`),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    }),
    runRoot,
  };
};

const stagedClaudeStartupRecoveryFixture = async (
  name: string,
  pid: number,
) => {
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), `oompa-claude-startup-${name}-`)));
  const paths = resolveStatePaths({ homeDirectory: runRoot, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: (() => {
    let value = 1_000;
    return () => value++;
  })() });
  try {
    const created = store.createProfile(`Claude startup ${name}`);
    const generation = store.nextProfileGeneration(created.id);
    if (!store.setProfileState(
      generation.id,
      generation.processGeneration,
      "signed_in",
      { email: `claude-startup-${name}@example.com`, plan: "Plus" },
    )) throw new Error("Expected the startup recovery profile to sign in.");
    const profile = store.requireProfileById(generation.id);
    const providerAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const claimed = store.recordClaimedClaudeProcessAuthority({
      providerAuthority,
      providerThreadId: `claude-startup-${name}`,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid,
        pidDomain: "darwin",
        procStart: `claude-startup-process-${name}`,
      },
    });
    const authority = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimed.providerThreadId,
      profileId: claimed.profileId,
      runtimeScope: claimed.runtimeScope,
      expectedRevision: claimed.revision,
      identity: claimed.identity,
    });
    const revocation = store.stageProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    });
    if (!store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: `claude-startup-${name}@example.com`, plan: "Plus" },
    )) throw new Error("Expected the startup recovery profile to enter recovery.");
    return {
      authority,
      paths,
      profile: store.requireProfileById(profile.id),
      revocation,
      runRoot,
      store,
    };
  } catch (error: unknown) {
    store.close();
    await rm(runRoot, { force: true, recursive: true });
    throw error;
  }
};

const stagedClaudeLaunchIntentStartupFixture = async (name: string) => {
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), `oompa-claude-launch-${name}-`)));
  const paths = resolveStatePaths({ homeDirectory: runRoot, platform: "darwin" });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: (() => {
    let value = 2_000;
    return () => value++;
  })() });
  try {
    const created = store.createProfile(`Claude launch ${name}`);
    const generation = store.nextProfileGeneration(created.id);
    if (!store.setProfileState(
      generation.id,
      generation.processGeneration,
      "signed_in",
      { email: `claude-launch-${name}@example.com`, plan: "Plus" },
    )) throw new Error("Expected the launch-intent profile to sign in.");
    const profile = store.requireProfileById(generation.id);
    const providerThreadId = `claude-launch-${name}`;
    const providerAccountKey = `v1:claude:${"a".repeat(64)}`;
    const providerAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const session = store.upsertProviderSession({
      providerAuthority,
      profileId: profile.id,
      provider: "claude",
      providerThreadId,
      title: `Claude launch ${name}`,
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
      providerAccountKey,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority,
      providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey,
      sessionId: session.id,
    });
    return { intent, paths, profile, runRoot, session, store };
  } catch (error: unknown) {
    store.close();
    await rm(runRoot, { force: true, recursive: true });
    throw error;
  }
};

const cursorWireSignature = "A".repeat(43);
const cursorWire = (label: string): string =>
  `hra1.${Buffer.from(`fixture:${label}`).toString("base64url")}.${cursorWireSignature}`;

const emptyRootStatus = (): RootStatus => ({
  version: 1,
  scope: "local_only",
  localObservation: {
    source: "sqlite",
    coverage: "complete",
    freshness: "fresh",
    observedAt: 1,
    tables: [
      "profiles",
      "sessions",
      "provider_interactions",
      "queue_entries",
      "usage_snapshots",
      "usage_poll_failures",
    ],
  },
  providerObservation: {
    source: "codex_app_server",
    coverage: "not_attempted",
    freshness: "unknown",
    observedAt: null,
  },
  cloudObservation: {
    source: "convex",
    coverage: "not_attempted",
    freshness: "unknown",
    observedAt: null,
    devices: { registered: null, online: null },
  },
  counts: {
    accounts: { signedOut: 0, loginPending: 0, signedIn: 0, recoveryRequired: 0 },
    sessions: { starting: 0, active: 0, idle: 0, terminal: 0, recoveryRequired: 0 },
    interactions: {
      pending: 0,
      responsePrepared: 0,
      responseWritten: 0,
      resolved: 0,
      declined: 0,
      canceled: 0,
      expired: 0,
      resolutionUnknown: 0,
    },
    queue: { pending: 0, dispatching: 0, applied: 0, failed: 0, ambiguous: 0, cancelled: 0 },
    usage: { observed: 0, failed: 0, missing: 0 },
  },
  attention: { records: [], total: 0, truncated: false },
});

const rawTerminalInput = (): PassThrough & {
  isRaw: boolean;
  isTTY: true;
  rawModes: boolean[];
  setRawMode(mode: boolean): PassThrough;
} => {
  const input = new PassThrough() as PassThrough & {
    isRaw: boolean;
    isTTY: true;
    rawModes: boolean[];
    setRawMode(mode: boolean): PassThrough;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
    return input;
  };
  return input;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for CLI test state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const resumePhraseFrom = (stderr: string): string => {
  const match = /Type (RESUME-[A-F0-9]{6})/u.exec(stderr);
  if (match?.[1] === undefined) throw new Error("Protected-input resume phrase was not rendered.");
  return match[1];
};

const beginPhraseFrom = (stderr: string): string => {
  const match = /Type (BEGIN-[A-F0-9]{6})/u.exec(stderr);
  if (match?.[1] === undefined) throw new Error("Protected-input begin phrase was not rendered.");
  return match[1];
};

class MemoryCloudCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();

  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return Promise.resolve(this.values.get(slot) ?? null);
  }

  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.values.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return Promise.resolve(null);
    const committed = { generation: (current?.generation ?? -1) + 1, value };
    this.values.set(slot, committed);
    return Promise.resolve(committed);
  }

  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (this.values.get(slot)?.generation !== expectedGeneration) return Promise.resolve(false);
    return Promise.resolve(this.values.delete(slot));
  }
}

const runningDaemonResponse = () => ({
  ok: true as const,
  version: 1 as const,
  requestId: crypto.randomUUID(),
  data: {
    running: true as const,
    daemon: {
      protocol: DAEMON_PROTOCOL,
      pid: 123,
      nonce: "018bcfe5-6800-7000-8000-000000000700",
      generation: 1,
      bootId: `boot_${"a".repeat(32)}`,
    },
  },
});

const readyDaemonStatus = () => {
  const daemon = runningDaemonResponse().data.daemon;
  return { running: true as const, pid: daemon.pid, daemon };
};

const stopDaemonIdentity = runningDaemonResponse().data.daemon;

const daemonAuthorityReceipt = (
  state: DaemonAuthorityReceipt["state"],
  identity = stopDaemonIdentity,
): DaemonAuthorityReceipt => ({
  version: 2,
  protocol: DAEMON_PROTOCOL,
  pid: identity.pid,
  nonce: identity.nonce,
  state,
  acquiredAt: 1,
  updatedAt: 2,
  generation: identity.generation,
  bootId: identity.bootId,
  ...(state === "failed" ? { failure: "bounded shutdown failure" } : {}),
});

const acknowledgedDaemonStopResponse = (): CommandResponse => ({
  ok: true,
  version: 1,
  requestId: crypto.randomUUID(),
  data: {
    stopping: true,
    running: true,
    daemon: stopDaemonIdentity,
  },
});

const exactStopDependencies = (
  overrides: Partial<DaemonStopDependencies> = {},
): DaemonStopDependencies => ({
  requestStop: () => Promise.resolve(acknowledgedDaemonStopResponse()),
  observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("ready")),
  waitForRelease: () => Promise.resolve({
    replacement: null,
    finalReceipt: daemonAuthorityReceipt("stopped"),
  }),
  inspectAuthority: () => Promise.resolve({
    state: "held",
    database: { authority: "held", custody: "safe" },
    receipt: { custody: "safe", state: "ready" },
  }),
  authorityHeld: () => Promise.resolve(false),
  sleep: () => Promise.resolve(),
  ...overrides,
});

describe("CLI entry point", () => {
  test("requires exact child authority while allowing all provider generations to diverge", () => {
    const profileId = "acct_00000000000000000000000000000000" as const;
    let profileGeneration = 7;
    let claudeGeneration = 3;
    let devinGeneration = 13;
    const codexAuthority = () => ({
      providerAccountId: profileId,
      profileId,
      provider: "codex" as const,
      bindingGeneration: 2,
      processGeneration: profileGeneration,
    });
    const claudeAuthority = () => ({
      providerAccountId: "pact_00000000000000000000000000000000" as const,
      profileId,
      provider: "claude" as const,
      bindingGeneration: 5,
      processGeneration: claudeGeneration,
    });
    const devinAuthority = () => ({
      providerAccountId: "dact_00000000000000000000000000000000" as const,
      profileId,
      provider: "devin" as const,
      bindingGeneration: 9,
      processGeneration: devinGeneration,
    });
    const providerAuthority = (provider: "codex" | "claude" | "devin") => {
      switch (provider) {
        case "codex": return codexAuthority();
        case "claude": return claudeAuthority();
        case "devin": return devinAuthority();
      }
    };
    const store = {
      requireProfile: () => ({ id: profileId, processGeneration: profileGeneration, state: "signed_in" }),
      requireProviderAccountAuthority: (_selector: string, provider: "codex" | "claude" | "devin") =>
        providerAuthority(provider),
    } as unknown as Pick<StateStore, "requireProfile" | "requireProviderAccountAuthority">;
    const live = (provider: "codex" | "claude" | "devin") => {
      const authority = providerAuthority(provider);
      return {
        id: profileId,
        generation: authority.processGeneration,
        provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        codexHome: "/profiles/account/codex-home",
        desktopUserData: "/profiles/account/desktop-user-data",
      } as const;
    };

    expect(isExactProviderRuntimeAuthorityCurrent(store, "codex", live("codex"))).toBe(true);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "claude", live("claude"))).toBe(true);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "claude", live("codex"))).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "codex", live("claude"))).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", live("devin"))).toBe(true);
    for (const provider of ["codex", "claude"] as const) {
      expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", live(provider))).toBe(false);
      expect(isExactProviderRuntimeAuthorityCurrent(store, provider, live("devin"))).toBe(false);
    }
    const oldDevin = live("devin");
    devinGeneration = 17;
    expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", oldDevin)).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", live("devin"))).toBe(true);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", {
      ...live("devin"),
      bindingGeneration: 8,
    })).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "devin", {
      ...live("devin"),
      providerAccountId: claudeAuthority().providerAccountId,
    })).toBe(false);
    claudeGeneration = 11;
    expect(isExactProviderRuntimeAuthorityCurrent(store, "claude", live("claude"))).toBe(true);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "claude", {
      ...live("claude"),
      bindingGeneration: 4,
    })).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "codex", {
      id: profileId,
      generation: profileGeneration,
      codexHome: "/profiles/account/codex-home",
      desktopUserData: "/profiles/account/desktop-user-data",
    } as never)).toBe(false);
    expect(isExactProviderRuntimeAuthorityCurrent(store, "codex", {
      ...live("codex"),
      providerAccountId: undefined,
    } as never)).toBe(false);

    profileGeneration = 8;
    expect(isExactProviderRuntimeAuthorityCurrent(store, "codex", {
      ...live("codex"),
      generation: 7,
    })).toBe(false);
  });

  test("binds every runtime manager to its own provider fence, never the profile's Codex generation", async () => {
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "oompa-runtime-authority-")));
    const paths = resolveStatePaths({ homeDirectory: runRoot, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: (() => {
      let value = 1_000;
      return () => value++;
    })() });
    try {
      const profile = store.createProfile("Devin runtime authority");
      // The profile's Codex process generation stays 0 because Devin sign-in
      // never touches the Codex account state machine.
      expect(store.requireProfileById(profile.id).processGeneration).toBe(0);
      const advanced = store.advanceProviderAccountProcessGeneration({
        profileId: profile.id, provider: "devin", expectedProcessGeneration: 0,
      });
      expect(advanced.processGeneration).toBe(1);
      const owned = profilePaths(paths, profile.id);
      const authority = {
        id: profile.id,
        generation: advanced.processGeneration,
        codexHome: owned.codexHome,
        desktopUserData: owned.desktopUserData,
        provider: "devin" as const,
        providerAccountId: advanced.providerAccountId,
        bindingGeneration: advanced.bindingGeneration,
      };
      for (const provider of ["codex", "claude", "devin"] as const) {
        expect(providerRuntimeAuthorityPredicate(store, provider)(authority))
          .toBe(provider === "devin");
      }
      expect(providerRuntimeAuthorityPredicate(store, "devin")({
        ...authority, generation: store.requireProfileById(profile.id).processGeneration,
      })).toBe(false);
      expect(providerRuntimeAuthorityPredicate(store, "devin")({
        ...authority, bindingGeneration: advanced.bindingGeneration + 1,
      })).toBe(false);
    } finally {
      store.close();
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  test("redirects acceptance personal Claude account reads and processes into fixture custody", async () => {
    const value = await upgradeFixture("personal-claude-home");
    try {
      const configDir = value.installation.personalProviderHomes.claudeConfigDir;
      const configHome = personalClaudeConfigHomeForInstallation(value.installation);
      expect(configHome).toBe("isolated");
      expect(personalClaudeConfigHomeForInstallation(createProductionInstallation()))
        .toBe("personal");

      const runtime = Object.freeze({
        argv: [process.execPath] as const,
        effort: CLAUDE_PIN_EFFORT,
        executablePath: process.execPath,
        model: CLAUDE_PIN_MODEL,
        nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
        version: CLAUDE_PIN,
      });
      const metadataPaths: string[] = [];
      const account = await readClaudeAccountProjection({
        configDir,
        configHome,
        runtime,
        signal: new AbortController().signal,
        readMetadata: (path) => {
          metadataPaths.push(path);
          return Promise.resolve({
            oauthAccount: {
              accountUuid: "acceptance-account",
              emailAddress: "acceptance@example.test",
              organizationUuid: "acceptance-organization",
            },
          });
        },
        probeAuthStatus: (input) => {
          expect(input.configDir).toBe(configDir);
          expect(input.configHome).toBe("isolated");
          return Promise.resolve({ loggedIn: true, authentication: "claude_ai" });
        },
      });
      expect(account).toMatchObject({
        accountId: "acceptance-account",
        email: "acceptance@example.test",
        signedIn: true,
      });
      expect(metadataPaths).toEqual([
        join(configDir, ".claude.json"),
        join(configDir, ".claude.json"),
      ]);

      const child = spawnBunClaudeProcess({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.env.CLAUDE_CONFIG_DIR ?? 'missing')",
        ],
        configDir,
        configHome,
        inspectIdentity: (pid) => Promise.resolve({
          pid,
          pidDomain: "darwin",
          procStart: "Fri Sep  4 12:00:00 2026",
        }),
      });
      const output: Uint8Array[] = [];
      for await (const chunk of child.stdout) output.push(chunk);
      expect(await child.exited).toBe(0);
      expect(new TextDecoder().decode(Buffer.concat(output))).toBe(configDir);
    } finally {
      await rm(value.runRoot, { force: true, recursive: true });
    }
  });

  test("startup preserves live or unknown Claude launch intent authority and generation", async () => {
    for (const [index, liveness] of (["live", "unknown"] as const).entries()) {
      const value = await stagedClaudeLaunchIntentStartupFixture(liveness);
      const daemonBefore = readFixtureDaemonGeneration(value.paths.database);
      const providerBefore = value.store.requireProviderAccountAuthority(value.profile.id, "claude");
      const deadlineAt = 34_567 + index;
      const controller = new AbortController();
      let probes = 0;
      try {
        await expect(releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
          value.store,
          {
            deadlineAt,
            signal: controller.signal,
            launchIntentProbe: {
              probe: (providerThreadId, input) => {
                probes += 1;
                expect(providerThreadId).toBe(value.intent.providerThreadId);
                expect(input.deadlineAt).toBe(deadlineAt);
                expect(input.signal).toBe(controller.signal);
                return Promise.resolve(liveness);
              },
            },
            probe: () => {
              throw new Error("Exact process liveness must not run for a launch intent.");
            },
          },
        )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(probes).toBe(1);
        expect(value.store.readClaudeProcessLaunchIntent({
          providerThreadId: value.intent.providerThreadId,
          profileId: value.intent.profileId,
          runtimeScope: value.intent.runtimeScope,
        })).toEqual(value.intent);
        expect(value.store.requireProfileById(value.profile.id)).toEqual(value.profile);

        expect(readFixtureDaemonGeneration(value.paths.database)).toBe(daemonBefore);
        expect(value.store.requireProviderAccountAuthority(value.profile.id, "claude")).toEqual(providerBefore);
      } finally {
        value.store.close();
        await rm(value.runRoot, { force: true, recursive: true });
      }
    }
  });

  test("startup cancels a proven-dead Claude launch intent before generation advance", async () => {
    const value = await stagedClaudeLaunchIntentStartupFixture("not-live");
    const deadlineAt = 45_678;
    const controller = new AbortController();
    let probes = 0;
    try {
      await releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
        value.store,
        {
          deadlineAt,
          signal: controller.signal,
          launchIntentProbe: {
            probe: (providerThreadId, input) => {
              probes += 1;
              expect(providerThreadId).toBe(value.intent.providerThreadId);
              expect(input.deadlineAt).toBe(deadlineAt);
              expect(input.signal).toBe(controller.signal);
              return Promise.resolve("not_live");
            },
          },
          probe: () => {
            throw new Error("Exact process liveness must not run for a launch intent.");
          },
        },
      );
      expect(probes).toBe(1);
      expect(value.store.readClaudeProcessLaunchIntent({
        providerThreadId: value.intent.providerThreadId,
        profileId: value.intent.profileId,
        runtimeScope: value.intent.runtimeScope,
      })).toBeNull();
      expect(value.store.requireProfileById(value.profile.id)).toEqual(value.profile);

      expect(value.store.nextDaemonGeneration(`boot_${"f".repeat(32)}`)).toBe(1);
      expect(value.store.requireProfileById(value.profile.id)).toMatchObject({
        processGeneration: value.profile.processGeneration + 1,
        state: "signed_in",
      });
    } finally {
      value.store.close();
      await rm(value.runRoot, { force: true, recursive: true });
    }
  });

  test("startup cannot cancel a restaged Claude launch intent through ABA", async () => {
    const value = await stagedClaudeLaunchIntentStartupFixture("aba");
    let replacement: typeof value.intent | undefined;
    try {
      await expect(releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
        value.store,
        {
          launchIntentProbe: {
            probe: () => {
              value.store.cancelClaudeProcessLaunchIntent({
                providerThreadId: value.intent.providerThreadId,
                profileId: value.intent.profileId,
                profileGeneration: value.intent.profileGeneration,
                runtimeScope: value.intent.runtimeScope,
                intentId: value.intent.intentId,
                expectedRevision: value.intent.revision,
              });
              replacement = value.store.stageClaudeProcessLaunchIntent({
                providerAuthority: value.store.requireProviderAccountAuthority(value.session.profileId, "claude"),
                providerThreadId: value.intent.providerThreadId,
                profileId: value.intent.profileId,
                profileGeneration: value.intent.profileGeneration,
                runtimeScope: value.intent.runtimeScope,
                providerAccountKey: value.intent.providerAccountKey
                  ?? `v1:claude:${"a".repeat(64)}`,
                sessionId: value.session.id,
              });
              return Promise.resolve("not_live");
            },
          },
        },
      )).rejects.toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
      if (replacement === undefined) throw new Error("Expected the launch intent to be restaged.");
      expect(replacement.intentId).not.toBe(value.intent.intentId);
      expect(replacement.revision).toBe(value.intent.revision);
      expect(value.store.readClaudeProcessLaunchIntent({
        providerThreadId: value.intent.providerThreadId,
        profileId: value.intent.profileId,
        runtimeScope: value.intent.runtimeScope,
      })).toEqual(replacement);
      expect(value.store.requireProfileById(value.profile.id)).toEqual(value.profile);
    } finally {
      value.store.close();
      await rm(value.runRoot, { force: true, recursive: true });
    }
  });

  for (const [index, liveness] of (["live", "unknown"] as const).entries()) {
    test(`startup refuses ${liveness} Claude custody during a staged revocation`, async () => {
      const value = await stagedClaudeStartupRecoveryFixture(
        liveness,
        61_001 + index,
      );
      const daemonBefore = readFixtureDaemonGeneration(value.paths.database);
      const providerBefore = value.store.requireProviderAccountAuthority(value.profile.id, "claude");
      const deadlineAt = 12_345;
      const controller = new AbortController();
      let probes = 0;
      try {
        await expect(releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
          value.store,
          {
            deadlineAt,
            signal: controller.signal,
            probe: (identity, input) => {
              probes += 1;
              expect(identity).toEqual(value.authority.identity);
              expect(input.deadlineAt).toBe(deadlineAt);
              expect(input.signal).toBe(controller.signal);
              return Promise.resolve(liveness);
            },
          },
        )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(probes).toBe(1);
        expect(value.store.requireProfileById(value.profile.id)).toEqual(value.profile);
        expect(value.store.readClaudeProcessAuthority({
          providerThreadId: value.authority.providerThreadId,
          profileId: value.authority.profileId,
          runtimeScope: value.authority.runtimeScope,
        })).toEqual(value.authority);
        expect(value.store.readProfilePersonalAuthorityRevocation(value.profile.id))
          .toEqual(value.revocation);

        expect(readFixtureDaemonGeneration(value.paths.database)).toBe(daemonBefore);
        expect(value.store.requireProviderAccountAuthority(value.profile.id, "claude")).toEqual(providerBefore);
      } finally {
        value.store.close();
        await rm(value.runRoot, { force: true, recursive: true });
      }
    });
  }

  test("startup releases proven-dead Claude custody before advancing daemon generation", async () => {
    const value = await stagedClaudeStartupRecoveryFixture("not-live", 61_003);
    const deadlineAt = 23_456;
    const controller = new AbortController();
    let probes = 0;
    try {
      await releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
        value.store,
        {
          deadlineAt,
          signal: controller.signal,
          probe: (identity, input) => {
            probes += 1;
            expect(identity).toEqual(value.authority.identity);
            expect(input.deadlineAt).toBe(deadlineAt);
            expect(input.signal).toBe(controller.signal);
            return Promise.resolve("not_live");
          },
        },
      );
      expect(probes).toBe(1);
      const released = value.store.readClaudeProcessAuthority({
        providerThreadId: value.authority.providerThreadId,
        profileId: value.authority.profileId,
        runtimeScope: value.authority.runtimeScope,
      });
      expect(released).toMatchObject({
        identity: value.authority.identity,
        profileGeneration: value.profile.processGeneration,
        revision: value.authority.revision + 1,
        state: "released",
      });
      expect(value.store.requireProfileById(value.profile.id)).toEqual(value.profile);
      expect(value.store.readProfilePersonalAuthorityRevocation(value.profile.id))
        .toEqual(value.revocation);

      expect(value.store.nextDaemonGeneration(`boot_${"c".repeat(32)}`)).toBe(1);
      expect(value.store.requireProfileById(value.profile.id)).toMatchObject({
        processGeneration: value.profile.processGeneration + 1,
        state: "recovery_required",
      });
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId: value.authority.providerThreadId,
        profileId: value.authority.profileId,
        runtimeScope: value.authority.runtimeScope,
      })).toEqual(released);
    } finally {
      value.store.close();
      await rm(value.runRoot, { force: true, recursive: true });
    }
  });

  test("reads root status locally without daemon autostart or transport", async () => {
    const captured = capture();
    let daemonCalls = 0;
    let daemonStarts = 0;
    let localReads = 0;
    expect(await main(["status", "--json"], captured.output, {
      callDaemon: async () => {
        daemonCalls += 1;
        throw new Error("root status must not call the daemon");
      },
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
      readRootStatus: () => {
        localReads += 1;
        return emptyRootStatus();
      },
    })).toBe(0);
    expect({ daemonCalls, daemonStarts, localReads }).toEqual({
      daemonCalls: 0,
      daemonStarts: 0,
      localReads: 1,
    });
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      version: 1,
      command: "status",
      data: {
        scope: "local_only",
        providerObservation: { coverage: "not_attempted" },
        cloudObservation: { coverage: "not_attempted" },
      },
    });
    expect(captured.read().stderr).toBe("");
  });

  test("diagnoses corrupt local status state without describing daemon startup", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)));
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-corrupt"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-corrupt"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    try {
      await initializeStatePaths(installation.paths);
      await writeFile(installation.paths.database, "not a sqlite database", { mode: 0o600 });
      const captured = capture();
      expect(await main(["status", "--json"], captured.output, {
        installation,
        startDaemon: () => { throw new Error("Local status must not start the daemon."); },
        callDaemon: () => { throw new Error("Local status must not call the daemon."); },
      })).toBe(7);
      const rendered = JSON.parse(captured.read().stdout) as {
        error: { message: string };
      };
      expect(rendered.error.message).toContain("before reading local status");
      expect(rendered.error.message).not.toContain("starting the daemon");
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("exports a transcript only to a new private file and never overwrites it", async () => {
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "oompa-transcript-export-")));
    const outputPath = join(runRoot, "transcript.json");
    const sessionId = `sess_${"e".repeat(32)}`;
    const transcript = {
      version: 1 as const,
      sessionId,
      provider: "codex" as const,
      records: [{
        sequence: 1,
        throughSequence: 1,
        recordedAt: 1_700_000_000_000,
        kind: "user" as const,
        actor: "human" as const,
        turnId: null,
        text: "private transcript body",
        omittedCharacters: 0,
      }],
      throughSequence: 1,
      nextSequence: null,
      omittedRecords: 0,
      omittedCharacters: 0,
      digest: "a".repeat(64),
    };
    const callDaemon = (command: LocalCommand): Promise<CommandResponse> => {
      expect(command).toMatchObject({
        kind: "session.transcript",
        limit: 500,
        session: sessionId,
        tail: true,
      });
      return Promise.resolve({
        ok: true,
        version: 1,
        requestId: crypto.randomUUID(),
        data: transcript,
      });
    };
    try {
      const first = capture();
      expect(await main([
        "session",
        "export",
        sessionId,
        "--format",
        "json",
        "--out",
        outputPath,
      ], first.output, { callDaemon })).toBe(0);
      expect(first.read().stdout).toBe("");
      expect(first.read().stderr).toBe("Wrote 1 transcript records.\n");
      expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(transcript);

      const before = await readFile(outputPath, "utf8");
      const second = capture();
      expect(await main([
        "session",
        "export",
        sessionId,
        "--format",
        "json",
        "--out",
        outputPath,
      ], second.output, { callDaemon })).toBe(1);
      expect(second.read().stdout).toBe("");
      expect(second.read().stderr).toBe(
        "oompa: Oompa failed before a safe command response was available.\n",
      );
      expect(await readFile(outputPath, "utf8")).toBe(before);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("human watch seeds current interaction revisions and treats closed stdout as completion", async () => {
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const interactionId = "10300000-0000-4000-8000-000000000001";
    const pendingInteractionId = "10300000-0000-4000-8000-000000000003";
    const streamEpoch = "10300000-0000-4000-8000-000000000002";
    const turnId = `opaque_v2_${"c".repeat(64)}`;
    const itemId = `opaque_v2_${"d".repeat(64)}`;
    const calls: LocalCommand[] = [];
    let stdout = "";
    let stderr = "";
    let stdoutWrites = 0;
    const exitCode = await main([
      "session",
      "watch",
      "current",
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => {
        stdout += value;
        stdoutWrites += 1;
        if (stdoutWrites > 1) {
          throw Object.assign(new Error("stdout closed"), { code: "EPIPE" });
        }
      },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        calls.push(command);
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [
                {
                  id: interactionId,
                  sessionId,
                  kind: "command_approval",
                  state: "response_prepared",
                  revision: 2,
                  blocking: true,
                  display: { summary: "Prepared response" },
                },
                {
                  id: pendingInteractionId,
                  sessionId,
                  kind: "user_input",
                  state: "pending",
                  revision: 4,
                  blocking: true,
                  display: { summary: "Choose a release channel" },
                },
              ],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected watch command: ${command.kind}`);
        }
        const base = {
          version: 1 as const,
          sessionId,
          streamEpoch,
          recordedAt: 1_700_000_000_000,
          accountId,
          providerGeneration: 1,
          providerConnectionId: null,
        };
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            version: 1,
            sessionId,
            requestedCursor: cursorWire("status-cursor"),
            retentionFloorCursor: cursorWire("floor"),
            observedThroughCursor: cursorWire("next-cursor"),
            nextCursor: cursorWire("next-cursor"),
            gap: null,
            events: [
              {
                ...base,
                sequence: 1,
                body: {
                  type: "interaction_requested" as const,
                  interactionId,
                  interactionKind: "command_approval" as const,
                  revision: 1,
                  blocking: true,
                  summary: "Stale request",
                },
              },
              {
                ...base,
                sequence: 2,
                body: {
                  type: "item_started" as const,
                  turnId,
                  itemId,
                  itemKind: "assistant" as const,
                },
              },
              {
                ...base,
                sequence: 3,
                body: {
                  type: "assistant_delta" as const,
                  turnId,
                  itemId,
                  text: "partial output",
                },
              },
            ],
          },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(calls.map((command) => command.kind)).toEqual([
      "session.interactions",
      "session.events",
    ]);
    expect(calls[1]).toMatchObject({
      session: sessionId,
      cursor: cursorWire("status-cursor"),
    });
    expect(stdout).toContain(`Interaction in progress: command approval ${interactionId}`);
    expect(stdout).not.toContain(`Interaction required: command approval ${interactionId}`);
    expect(stdout).toContain(`Show: oompa interaction show ${pendingInteractionId}`);
    expect(stdout).toContain("does not carry complete decision authority");
    expect(stdout).not.toContain(
      `oompa interaction answer ${pendingInteractionId} --revision 4 --input-stdin`,
    );
    expect(stdout).not.toMatch(/\n\s*\//u);
    expect(stdout).toContain("Trailing live delta text omitted");
    expect(stderr).toBe("");
  });

  test("human watch removes signal listeners before a final output failure escapes", async () => {
    const sessionId = `sess_${"4".repeat(32)}`;
    const accountId = `acct_${"5".repeat(32)}`;
    const interactionId = "10400000-0000-4000-8000-000000000001";
    const streamEpoch = "10400000-0000-4000-8000-000000000002";
    const turnId = `opaque_v2_${"e".repeat(64)}`;
    const itemId = `opaque_v2_${"f".repeat(64)}`;
    const listenerCounts = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    };
    let eventReads = 0;
    let stdoutWrites = 0;
    let stderr = "";
    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: () => { throw new Error("Human watch must use the async output boundary."); },
      writeStdoutAsync: (value) => {
        stdoutWrites += 1;
        if (stdoutWrites <= 2 && (stdoutWrites > 1 || value.includes("Interaction in progress"))) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("final output failed"));
      },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [{
                id: interactionId,
                sessionId,
                kind: "command_approval",
                state: "response_prepared",
                revision: 2,
                blocking: true,
                display: { summary: "Prepared response" },
              }],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") throw new Error("Expected session events.");
        eventReads += 1;
        if (eventReads > 1) {
          return Promise.resolve({
            ok: false,
            version: 1,
            requestId: crypto.randomUUID(),
            error: { code: "INVALID_INPUT", message: "Stop the fixture." },
          });
        }
        const base = {
          version: 1 as const,
          sessionId,
          streamEpoch,
          recordedAt: 1_700_000_000_000,
          accountId,
          providerGeneration: 1,
          providerConnectionId: null,
        };
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            version: 1,
            sessionId,
            requestedCursor: command.cursor ?? null,
            retentionFloorCursor: cursorWire("floor"),
            observedThroughCursor: cursorWire("next-cursor"),
            nextCursor: cursorWire("next-cursor"),
            gap: null,
            events: [
              {
                ...base,
                sequence: 1,
                body: {
                  type: "item_started" as const,
                  turnId,
                  itemId,
                  itemKind: "assistant" as const,
                },
              },
              {
                ...base,
                sequence: 2,
                body: {
                  type: "assistant_delta" as const,
                  turnId,
                  itemId,
                  text: "api_key=",
                },
              },
            ],
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(stdoutWrites).toBe(3);
    expect(stderr).not.toBe("");
    expect(process.listenerCount("SIGINT")).toBe(listenerCounts.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(listenerCounts.sigterm);
  });

  test("human watch withholds partial interaction guidance when bootstrap fails", async () => {
    const sessionId = `sess_${"6".repeat(32)}`;
    const interactionId = "10500000-0000-4000-8000-000000000001";
    let stdout = "";
    let stderr = "";
    let interactionPages = 0;
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Event follow must not begin after an incomplete bootstrap.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        interactionPages += 1;
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId,
            interactions: [{
              id: interactionId,
              sessionId,
              kind: "command_approval",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "Must remain withheld" },
            }],
            nextCursor: interactionPages === 1 ? "page-2" : null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(interactionPages).toBe(2);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(interactionId);
    expect(stderr).not.toContain("Must remain withheld");
  });

  test("human watch bounds its atomic interaction bootstrap before writing stdout", async () => {
    const sessionId = `sess_${"b".repeat(32)}`;
    let bootstrapObserved = false;
    let eventCalls = 0;
    let interactionPages = 0;
    let stdout = "";
    let stderr = "";
    const interactionsPerPage = 100;
    const maximumFixturePages = 10;

    const exitCode = await main([
      "session",
      "watch",
      sessionId,
      "--cursor",
      cursorWire("bounded-bootstrap-status"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Event follow must not begin after bootstrap output exceeds its bound.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected a bounded interaction bootstrap.");
        }
        const pageIndex = interactionPages;
        interactionPages += 1;
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId,
            interactions: Array.from({ length: interactionsPerPage }, (_, index) => ({
              id: `10700000-0000-4000-8000-${String(
                pageIndex * interactionsPerPage + index + 1,
              ).padStart(12, "0")}`,
              sessionId,
              kind: "user_input",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "x".repeat(2_048) },
            })),
            nextCursor: interactionPages < maximumFixturePages
              ? `bootstrap-page-${String(interactionPages + 1)}`
              : null,
          },
        });
      },
      onHumanSessionObserverBootstrap: () => { bootstrapObserved = true; },
    });

    expect(HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES).toBe(1_048_576);
    expect(exitCode).not.toBe(0);
    expect(interactionPages).toBeGreaterThan(1);
    expect(interactionPages).toBeLessThan(maximumFixturePages);
    expect(eventCalls).toBe(0);
    expect(bootstrapObserved).toBe(false);
    expect(stdout).toBe("");
    expect(stderr).toContain("Pending interaction guidance exceeds the bounded human watch bootstrap");
    expect(stderr).not.toContain("10700000-0000-4000-8000-");
  });

  test("human watch rejects a foreign bootstrap page for an exact session ID", async () => {
    const requestedSessionId = `sess_${"7".repeat(32)}`;
    const foreignSessionId = `sess_${"8".repeat(32)}`;
    let stdout = "";
    let stderr = "";
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      requestedSessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Foreign bootstrap must prevent event follow.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId: foreignSessionId,
            interactions: [],
            nextCursor: null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(foreignSessionId);
  });

  test("human watch rejects a foreign interaction nested in a correctly scoped bootstrap page", async () => {
    const requestedSessionId = `sess_${"9".repeat(32)}`;
    const foreignSessionId = `sess_${"a".repeat(32)}`;
    const foreignInteractionId = "10600000-0000-4000-8000-000000000001";
    let stdout = "";
    let stderr = "";
    let eventCalls = 0;
    const exitCode = await main([
      "session",
      "watch",
      requestedSessionId,
      "--cursor",
      cursorWire("status-cursor"),
    ], {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    }, {
      callDaemon: (command) => {
        if (command.kind === "session.events") {
          eventCalls += 1;
          throw new Error("Foreign nested interaction must prevent event follow.");
        }
        if (command.kind !== "session.interactions") {
          throw new Error("Expected interaction bootstrap.");
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: {
            sessionId: requestedSessionId,
            interactions: [{
              id: foreignInteractionId,
              sessionId: foreignSessionId,
              kind: "command_approval",
              state: "pending",
              revision: 1,
              blocking: true,
              display: { summary: "Foreign interaction" },
            }],
            nextCursor: null,
          },
        });
      },
    });

    expect(exitCode).not.toBe(0);
    expect(eventCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
    expect(stderr).not.toContain(foreignSessionId);
    expect(stderr).not.toContain(foreignInteractionId);
  });

  test("uses each supported platform's native terminal input queue selector", () => {
    expect(protectedTerminalInputQueueForPlatform("darwin")).toBe(1);
    expect(protectedTerminalInputQueueForPlatform("linux")).toBe(0);
    expect(protectedTerminalInputQueueForPlatform("win32")).toBeNull();
    expect(protectedTerminalControlLibrariesForPlatform("darwin", "arm64")).toEqual([
      "/usr/lib/libSystem.B.dylib",
    ]);
    expect(protectedTerminalControlLibrariesForPlatform("linux", "x64")).toContain(
      "libc.musl-x86_64.so.1",
    );
    expect(protectedTerminalControlLibrariesForPlatform("linux", "arm64")).toContain(
      "libc.musl-aarch64.so.1",
    );
    expect(protectedTerminalControlLibrariesForPlatform("win32", "x64")).toEqual([]);
  });

  test("hidden terminal input settles on EOF and restores raw mode", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.end();
    await expect(read).rejects.toThrow("ended before a document");
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal input discards pretype injected at both flush boundaries", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const stale = '{"answer":"stale-pretyped"}';
    let flushes = 0;
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => {
      flushes += 1;
      input.write(`${stale}\n`);
    });
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\n`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"fresh"}\n');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\n`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"fresh"}');
    expect(bytes.toString("utf8")).not.toContain("stale-pretyped");
    expect(flushes).toBe(3);
    expect(input.rawModes).toEqual([true, false]);
    bytes.fill(0);
  });

  test("hidden terminal input drains a split trailing paste before ordinary input resumes", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    setTimeout(() => input.write("SECRET_TAIL\n"), 30);
    await waitFor(() => captured.read().stderr.includes("Trailing input was discarded"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\n`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"secret"}');
    expect(input.read()).toBeNull();
    bytes.fill(0);

    const output = new PassThrough();
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      output,
      terminal: true,
    });
    const next = coordinator.question("next> ");
    input.write("safe\n");
    expect(await next).toBe("safe");
    coordinator.close();
  });

  test("hidden terminal input requires its unpredictable readiness phrase", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    let scheduled = false;
    const output = {
      writeStdout: captured.output.writeStdout,
      writeStderr: (value: string) => {
        captured.output.writeStderr(value);
        if (!scheduled && value.includes("Type BEGIN-")) {
          scheduled = true;
          input.write("stale-first-line\r");
          setTimeout(() => input.write('{"answer":"pre-scheduled"}\r'), 30);
        }
      },
    };
    const read = readHiddenProtectedLineFromTerminal(input, output, () => undefined);
    await waitFor(() => captured.read().stderr.match(/Queued input was discarded/gu)?.length === 2);
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"fresh"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe('{"answer":"fresh"}');
    expect(bytes.toString("utf8")).not.toContain("pre-scheduled");
    bytes.fill(0);
  });

  test("hidden terminal accepts bytes entered in direct response to its visible document prompt", async () => {
    const input = rawTerminalInput();
    let stderr = "";
    const fresh = '{"answer":"prompt-response"}';
    const output = {
      writeStdout: () => undefined,
      writeStderr: (value: string) => {
        stderr += value;
        if (value.includes("Protected JSON input (hidden)")) input.write(`${fresh}\r`);
        const phrase = /Type (RESUME-[A-F0-9]{6})/u.exec(value)?.[1];
        if (phrase !== undefined) input.write(`${phrase}\r`);
      },
    };
    const read = readHiddenProtectedLineFromTerminal(input, output, () => undefined);
    await waitFor(() => stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(stderr)}\r`);
    const bytes = await read;
    expect(bytes.toString("utf8")).toBe(fresh);
    bytes.fill(0);
  });

  test("hidden terminal input bounds a no-newline paste and quarantines its tail", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\n`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write("x".repeat(64 * 1_024 + 1));
    await waitFor(() => captured.read().stderr.includes("exceeded its bound"));
    input.write("tail-must-be-drained\n");
    input.end();
    await expect(read).rejects.toThrow("exceeds 65536 UTF-8 bytes");
    expect(input.read()).toBeNull();
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal bounds repeated readiness and return-handoff attempts", async () => {
    for (const phase of ["readiness", "return"] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      if (phase === "return") {
        input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
        await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
        input.write('{"answer":"must-be-zeroed"}\r');
        await waitFor(() => captured.read().stderr.includes("Protected input captured"));
      }
      const repeatedNotice = phase === "readiness" ? "Queued input was discarded" : "Trailing input was discarded";
      for (let attempt = 1; attempt < 8; attempt += 1) {
        input.write(`wrong-${String(attempt)}\r`);
        await waitFor(() => (captured.read().stderr.match(new RegExp(repeatedNotice, "gu"))?.length ?? 0) >= attempt);
      }
      input.write("wrong-8\r");
      await waitFor(() => captured.read().stderr.includes("could not prove a human handoff"));
      input.end();
      await expect(read).rejects.toThrow("bounded");
      expect(captured.read().stderr).not.toContain("must-be-zeroed");
      expect(input.rawModes).toEqual([true, false]);
    }
  });

  test("hidden terminal flush quarantine survives a throwing display", async () => {
    const input = rawTerminalInput();
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: () => { throw new Error("display unavailable"); },
    }, () => { throw new Error("tcflush failed"); });
    await expect(read).rejects.toThrow("could not establish an empty input queue");
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
  });

  test("hidden terminal aborts and fences an initial flush quarantine", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const controller = new AbortController();
    const read = readHiddenProtectedLineFromTerminal(
      input,
      captured.output,
      () => { throw new Error("tcflush failed"); },
      controller.signal,
    );
    await waitFor(() => captured.read().stderr.includes("discard input until EOF"));
    controller.abort(new Error("display closed"));
    await expect(read).rejects.toThrow("could not establish an empty input queue");
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
  });

  test("hidden terminal prompt failure restores raw mode before returning", async () => {
    const input = rawTerminalInput();
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: () => { throw new Error("prompt unavailable"); },
    }, () => undefined);
    await expect(read).rejects.toThrow("prompt became unavailable");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal restores and fences before honoring raw Ctrl-Z", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write("\u001a");
    await expect(read).rejects.toThrow("was suspended");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal drains delayed Ctrl-backslash and Ctrl-Z tails before re-signalling", async () => {
    for (const [byte, expectedSignal] of [[0x1c, "SIGQUIT"], [0x1a, "SIGTSTP"]] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const signalListeners = new Map<NodeJS.Signals, () => void>();
      const resignalled: NodeJS.Signals[] = [];
      const propagationStates: Array<Readonly<{
        destroyed: boolean;
        listenerCount: number;
        raw: boolean;
      }>> = [];
      let flushes = 0;
      const read = withProtectedTerminalLifecycle(
        async (signal) => await readHiddenProtectedLineFromTerminal(
          input,
          captured.output,
          () => { flushes += 1; },
          signal,
        ),
        undefined,
        {
          onOutputFailure: () => () => undefined,
          onSignal: (signal, listener) => {
            signalListeners.set(signal, listener);
            return () => { signalListeners.delete(signal); };
          },
          resignal: (signal) => {
            propagationStates.push({
              destroyed: input.destroyed,
              listenerCount: signalListeners.size,
              raw: input.isRaw,
            });
            resignalled.push(signal);
          },
        },
      );
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      input.write(Buffer.from([byte]));
      let delayedTailArrivedWhileRaw = false;
      setTimeout(() => {
        delayedTailArrivedWhileRaw = input.isRaw;
        input.write("must-not-reach-parent\n");
      }, 30);
      await expect(read).rejects.toThrow(expectedSignal === "SIGQUIT" ? "SIGQUIT" : "was suspended");
      expect(delayedTailArrivedWhileRaw).toBe(true);
      expect(flushes).toBe(2);
      expect(input.rawModes).toEqual([true, false]);
      expect(input.destroyed).toBe(true);
      expect(input.read()).toBeNull();
      expect(resignalled).toEqual([expectedSignal]);
      expect(propagationStates).toEqual([{ destroyed: true, listenerCount: 0, raw: false }]);
    }
  });

  test("hidden terminal fails closed when the final raw-signal flush is unavailable", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const resignalled: NodeJS.Signals[] = [];
    let flushes = 0;
    const read = withProtectedTerminalLifecycle(
      async (signal) => await readHiddenProtectedLineFromTerminal(
        input,
        captured.output,
        () => {
          flushes += 1;
          if (flushes === 2) throw new Error("final flush unavailable");
        },
        signal,
      ),
      undefined,
      {
        onOutputFailure: () => () => undefined,
        onSignal: () => () => undefined,
        resignal: (signal) => { resignalled.push(signal); },
      },
    );
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write("\u001c");
    await expect(read).rejects.toThrow("quiet signal boundary");
    expect(resignalled).toEqual([]);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("hidden terminal restores and re-signals raw Ctrl-backslash at every protected handoff", async () => {
    for (const phase of ["readiness", "document", "return"] as const) {
      const input = rawTerminalInput();
      const captured = capture();
      const resignalled: NodeJS.Signals[] = [];
      const read = withProtectedTerminalLifecycle(
        async (signal) => await readHiddenProtectedLineFromTerminal(
          input,
          captured.output,
          () => undefined,
          signal,
        ),
        undefined,
        {
          onOutputFailure: () => () => undefined,
          onSignal: () => () => undefined,
          resignal: (signal) => { resignalled.push(signal); },
        },
      );
      await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
      if (phase !== "readiness") {
        input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
        await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
      }
      if (phase === "return") {
        input.write('{"answer":"must-be-zeroed"}\r');
        await waitFor(() => captured.read().stderr.includes("Protected input captured"));
      }
      input.write("\u001c");
      await expect(read).rejects.toThrow("SIGQUIT");
      expect(input.rawModes).toEqual([true, false]);
      expect(input.destroyed).toBe(true);
      expect(resignalled).toEqual(["SIGQUIT"]);
      expect(captured.read().stderr).not.toContain("must-be-zeroed");
    }
  });

  test("hidden terminal treats Ctrl-D during its quiet handoff as cancellation", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    setTimeout(() => input.write("\u0004"), 5);
    await waitFor(() => captured.read().stderr.includes("remains hidden while Oompa discards its tail"));
    input.write("\u0004");
    await expect(read).rejects.toThrow("ended before a document");
    expect(captured.read().stderr).not.toContain("Protected JSON input (hidden)");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
  });

  test("direct hidden input restores before propagating process termination", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const signalListeners = new Map<NodeJS.Signals, () => void>();
    let outputFailure: (() => void) | null = null;
    const resignalled: NodeJS.Signals[] = [];
    const read = withProtectedTerminalLifecycle(
      async (signal) => await readHiddenProtectedLineFromTerminal(
        input,
        captured.output,
        () => undefined,
        signal,
      ),
      undefined,
      {
        onOutputFailure: (listener) => {
          outputFailure = listener;
          return () => { outputFailure = null; };
        },
        onSignal: (signal, listener) => {
          signalListeners.set(signal, listener);
          return () => { signalListeners.delete(signal); };
        },
        resignal: (signal) => { resignalled.push(signal); },
      },
    );
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    expect(outputFailure).not.toBeNull();
    signalListeners.get("SIGTERM")?.();
    await expect(read).rejects.toThrow("cancelled");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.destroyed).toBe(true);
    expect(signalListeners.size).toBe(0);
    expect(outputFailure).toBeNull();
    expect(resignalled).toEqual(["SIGTERM"]);
  });

  test("hidden terminal fences input when raw activation is a silent no-op", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      return input;
    };
    const captured = capture();
    await expect(readHiddenProtectedLineFromTerminal(
      input,
      captured.output,
      () => undefined,
    )).rejects.toThrow("could not establish raw no-echo mode");
    expect(input.rawModes).toEqual([true, true]);
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(true);
    expect(captured.read().stderr).toContain("could not disable echo");
    expect(captured.read().stderr).not.toContain("remains hidden");
  });

  test("hidden terminal couples raw input to the coordinator display lifecycle", async () => {
    const input = rawTerminalInput();
    const terminalOutput = new PassThrough();
    let stderr = "";
    const coordinator = new ShellTerminalCoordinator({
      flushInput: () => undefined,
      input,
      output: terminalOutput,
      terminal: true,
    });
    const read = readHiddenProtectedLineFromTerminal(input, {
      writeStdout: () => undefined,
      writeStderr: (value: string) => {
        stderr += value;
        terminalOutput.write(value);
      },
    }, () => undefined, coordinator.lifecycleSignal);
    await waitFor(() => stderr.includes("Type BEGIN-"));
    terminalOutput.destroy();
    await expect(read).rejects.toThrow("cancelled");
    expect(input.isRaw).toBe(false);
    expect(input.destroyed).toBe(true);
    expect(await coordinator.question("must-not-open> ")).toBeNull();
    coordinator.close();
  });

  test("hidden terminal keeps echo disabled while quarantining a cancelled secret tail", async () => {
    const input = rawTerminalInput();
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write("\u0003");
    await waitFor(() => captured.read().stderr.includes("remains hidden"));
    let tailArrivedWhileRaw = false;
    setTimeout(() => {
      tailArrivedWhileRaw = input.isRaw;
      input.write("SECRET_AFTER_CANCEL\n");
      setTimeout(() => {
        input.write("\u0004");
        setTimeout(() => input.write("SECRET_AFTER_QUARANTINE_EXIT\n", () => undefined), 30);
      }, 10);
    }, 30);
    await expect(read).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setTimeout(resolve, 45));
    expect(tailArrivedWhileRaw).toBe(true);
    expect(input.destroyed).toBe(true);
    expect(input.read()).toBeNull();
    expect(input.rawModes).toEqual([true, false]);
  });

  test("hidden terminal closes input when raw-mode restoration cannot be proven", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      if (!mode) throw new Error("restore failed");
      input.isRaw = true;
      return input;
    };
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    await expect(read).rejects.toThrow("raw mode restoration failed");
    expect(input.destroyed).toBe(true);
    expect(input.rawModes.filter((mode) => !mode)).toHaveLength(2);
  });

  test("hidden terminal rejects a silent raw-mode restoration no-op and zeroes custody", async () => {
    const input = rawTerminalInput();
    input.setRawMode = (mode: boolean) => {
      input.rawModes.push(mode);
      if (mode) input.isRaw = true;
      return input;
    };
    const captured = capture();
    const read = readHiddenProtectedLineFromTerminal(input, captured.output, () => undefined);
    await waitFor(() => captured.read().stderr.includes("Type BEGIN-"));
    input.write(`${beginPhraseFrom(captured.read().stderr)}\r`);
    await waitFor(() => captured.read().stderr.includes("Protected JSON input (hidden)"));
    input.write('{"answer":"secret"}\r');
    await waitFor(() => captured.read().stderr.includes("Protected input captured"));
    input.write(`${resumePhraseFrom(captured.read().stderr)}\r`);
    await expect(read).rejects.toThrow("raw mode could not be restored");
    expect(input.destroyed).toBe(true);
    expect(input.rawModes.filter((mode) => !mode)).toHaveLength(2);
  });

  test("help is offline and stable", async () => {
    const captured = capture();
    expect(await main(["--help"], captured.output)).toBe(0);
    expect(captured.read().stdout).toContain("oompa session");
    expect(captured.read().stdout).toContain("Usage:\n  oompa\n");
    expect(captured.read().stdout).toContain("--json                    Emit one versioned JSON result");
    expect(captured.read().stdout).toContain("oompa device list|pair|approve|revoke|key-loss");
    expect(captured.read().stdout).toContain("Run bare `oompa` in a TTY to start the persistent agent-and-human shell.");
    expect(captured.read().stderr).toBe("");

    const group = capture();
    expect(await main(["session", "--help"], group.output)).toBe(0);
    expect(group.read().stdout).toContain("Oompa session");
    expect(group.read().stdout).toContain("oompa session events");
    expect(group.read().stdout).toContain("oompa session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]");
    expect(group.read().stdout).toContain("oompa session task create <session>");
    expect(group.read().stdout).toContain("They never create a standalone task or a new conversation.");
    expect(group.read().stdout).not.toContain("oompa device pair");
    expect(group.read().stderr).toBe("");

    const protectedGroup = capture();
    expect(await main(["interaction", "answer", "--help"], protectedGroup.output)).toBe(0);
    expect(protectedGroup.read().stdout).toContain("--input-stdin|--input-fd");
    expect(protectedGroup.read().stdout).not.toContain("oompa interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]");
    expect(protectedGroup.read().stdout).toContain("Protected values");
    expect(protectedGroup.read().stderr).toBe("");
  });

  test("leaf help prints only that leaf and the help alias matches --help byte for byte", async () => {
    const leafHelp = [
      "Oompa session events",
      "",
      "Usage:",
      "  oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
      "",
      "Examples:",
      "  oompa session events my-session --wait-ms 30000 --jsonl",
      "",
    ].join("\n");
    for (const argv of [
      ["session", "events", "--help"],
      ["help", "session", "events"],
      ["session", "events", "my-session", "-h"],
    ]) {
      const captured = capture();
      expect(await main(argv, captured.output)).toBe(0);
      expect(captured.read()).toEqual({ stdout: leafHelp, stderr: "" });
    }
    const root = capture();
    expect(await main(["help"], root.output)).toBe(0);
    expect(root.read()).toEqual({ stdout: `${usageForGroup(undefined)}\n`, stderr: "" });
    expect(root.read().stdout).toContain("Run `oompa <group> --help` or `oompa help <group> [<command>]` for command examples.");
    const group = capture();
    expect(await main(["help", "session"], group.output)).toBe(0);
    expect(group.read()).toEqual({ stdout: `${usageForGroup("session")}\n`, stderr: "" });
  });

  test("help and version honor --json with one versioned envelope", async () => {
    const rootHelp = capture();
    expect(await main(["--json", "--help"], rootHelp.output)).toBe(0);
    expect(JSON.parse(rootHelp.read().stdout)).toEqual({
      ok: true,
      version: 1,
      command: "help",
      data: { usage: usageForGroup(undefined) },
    });
    expect(rootHelp.read().stderr).toBe("");

    const leafHelp = capture();
    expect(await main(["--json", "help", "session", "events"], leafHelp.output)).toBe(0);
    expect(JSON.parse(leafHelp.read().stdout)).toEqual({
      ok: true,
      version: 1,
      command: "help",
      data: { group: "session", leaf: "events", usage: usageForGroup("session", "events") },
    });

    const unknown = capture();
    expect(await main(["--json", "help", "bogus-group", "bogus-leaf"], unknown.output)).toBe(0);
    expect(JSON.parse(unknown.read().stdout)).toEqual({
      ok: true,
      version: 1,
      command: "help",
      data: { usage: usageForGroup(undefined) },
    });
    expect(unknown.read().stdout).not.toContain("bogus");

    for (const argv of [["--version", "--json"], ["--json", "-v"]]) {
      const version = capture();
      expect(await main(argv, version.output)).toBe(0);
      expect(JSON.parse(version.read().stdout)).toEqual({
        ok: true,
        version: 1,
        command: "version",
        data: { version: packageMetadata.version },
      });
      expect(version.read().stderr).toBe("");
    }
  });

  test("work protocol is served locally before initialization and matches the daemon document", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4e";
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)));
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-first-run"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-first-run"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    let daemonStarts = 0;
    let daemonCalls = 0;
    const input = {
      installation,
      callDaemon: () => {
        daemonCalls += 1;
        return Promise.reject(new Error("work protocol must not reach the daemon"));
      },
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      for (const entry of [
        { argv: ["--json", "work", "protocol"], query: { kind: "index" } },
        { argv: ["work", "protocol", "--topic", "errors"], query: { kind: "topic", topic: "errors" } },
        { argv: ["work", "protocol", "--operation", "attempt.dispatch"], query: { kind: "operation", operation: "attempt.dispatch" } },
      ] as const) {
        const captured = capture();
        expect(await main([...entry.argv], captured.output, input)).toBe(0);
        // The daemon answers `work.protocol` with the same pure function (service.ts), so this
        // equality is the local-versus-daemon parity check for the index and one shard.
        expect(JSON.parse(captured.read().stdout)).toEqual({
          ok: true,
          version: 1,
          command: "work.protocol",
          data: JSON.parse(JSON.stringify(describeWorkProtocol(entry.query))),
        });
        expect(captured.read().stderr).toBe("");
      }
      expect(daemonStarts).toBe(0);
      expect(daemonCalls).toBe(0);
      await expect(lstat(installation.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("offline doctor returns one JSON value", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oompa-doctor-"));
    try {
      const captured = capture();
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(0);
      const parsed = JSON.parse(captured.read().stdout) as { ok: boolean; data: { networkChecks: string } };
      expect(parsed).toMatchObject({ ok: true, data: { networkChecks: "skipped" } });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor treats a private pre-initialization root without a database as not initialized", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-preinit-")));
    try {
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      await mkdir(statePaths.root, { recursive: true, mode: 0o700 });
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          healthy: true,
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor makes a released failed daemon receipt an explicit restart-safe observation", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-daemon-failed-")));
    const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(statePaths);
      const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
      await authority.release({ state: "failed", failure: "bounded test failure" });
      expect(await stopDaemonWithExactAuthority(statePaths)).toMatchObject({
        error: { code: "RECOVERY_REQUIRED", details: { nextCommand: "oompa doctor --offline" } },
        kind: "failure",
      });

      const json = capture();
      expect(await main(["doctor", "--offline", "--json"], json.output, { statePaths })).toBe(0);
      expect(JSON.parse(json.read().stdout)).toMatchObject({
        data: {
          healthy: true,
          state: {
            daemonAuthority: {
              database: { authority: "released", custody: "safe" },
              receipt: { custody: "safe", state: "failed" },
              state: "released",
            },
          },
        },
        ok: true,
      });

      const human = capture();
      expect(await main(["doctor", "--offline"], human.output, { statePaths })).toBe(0);
      expect(human.read().stdout).toContain(
        "daemon authority released after a failed daemon; safe to restart after these checks.",
      );
      expect(human.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor refuses restart when a live receipt outlives its named authority database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-daemon-missing-authority-")));
    const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(statePaths);
      const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
      await authority.publish({
        bootId: `boot_${"1".repeat(32)}`,
        generation: 1,
        state: "ready",
      });
      await authority.release();
      const receipt = await readDaemonAuthorityReceipt(statePaths);
      if (receipt === null) throw new Error("Expected a daemon receipt fixture.");
      await writeFile(statePaths.daemonLock, `${JSON.stringify({ ...receipt, state: "ready" })}\n`);
      await unlink(daemonAuthorityDatabasePath(statePaths));

      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          healthy: false,
          state: {
            daemonAuthority: {
              database: { custody: "absent" },
              receipt: { custody: "safe", state: "ready" },
              state: "indeterminate",
            },
          },
        },
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        ok: false,
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor diagnoses every immediate daemon-stop authority recovery without leaking paths", async () => {
    for (const scenario of ["unsafe_receipt", "unsafe_database", "invalid_database"] as const) {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `oompa-doctor-daemon-${scenario}-`)));
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      try {
        await initializeStatePaths(statePaths);
        const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
        await authority.release();
        if (scenario === "unsafe_receipt") {
          await chmod(statePaths.daemonLock, 0o640);
        } else if (scenario === "unsafe_database") {
          await chmod(daemonAuthorityDatabasePath(statePaths), 0o640);
        } else {
          await writeFile(daemonAuthorityDatabasePath(statePaths), "not a sqlite database");
        }

        expect(await stopDaemonWithExactAuthority(statePaths)).toMatchObject({
          error: { code: "RECOVERY_REQUIRED", details: { nextCommand: "oompa doctor --offline" } },
          kind: "failure",
        });
        const captured = capture();
        expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
        const result = JSON.parse(captured.read().stdout) as unknown;
        expect(result).toMatchObject({
          data: {
            healthy: false,
            state: { daemonAuthority: { state: scenario } },
          },
          error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
          ok: false,
        });
        expect(JSON.stringify(result)).not.toContain(temporary);
        expect(captured.read().stderr).toBe("");
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    }
  });

  test("offline doctor rejects a state root not owned by the invoking user", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-owner-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await mkdir(statePaths.root, { recursive: true, mode: 0o700 });
      const metadata = await lstat(statePaths.root);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        offlineDoctorOwnerUid: metadata.uid + 1,
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a state root reached through a symbolic-link ancestor", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oompa-doctor-symlink-"));
    try {
      const actualParent = join(temporary, "actual");
      const linkedParent = join(temporary, "linked");
      await mkdir(join(actualParent, "state"), { recursive: true, mode: 0o700 });
      await symlink(actualParent, linkedParent);
      const statePaths = resolveStatePaths({ rootDirectory: join(linkedParent, "state") });
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a group-readable local database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-database-mode-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await initializeStatePaths(statePaths);
      const store = new StateStore(statePaths);
      store.close();
      await chmod(statePaths.database, 0o640);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: ["The local database check failed without exposing its runtime diagnostic."],
          state: { database: "invalid", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor rejects a dangling state-root symbolic link instead of treating it as absent", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-dangling-root-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await symlink(join(temporary, "missing-target"), statePaths.root);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, {
        statePaths,
      })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: ["The state root is not a private canonical directory."],
          state: { database: "not_initialized", initialized: false },
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("threads a source-only installation through initialization without changing HOME", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const documentsDirectory = join(runRoot, "project-a-fixture");
    await mkdir(documentsDirectory, { mode: 0o700 });
    try {
      const expectedHomeDirectory = process.env.HOME;
      if (expectedHomeDirectory === undefined) throw new Error("Test requires HOME.");
      const installation = createAcceptanceInstallation({
        device: "a",
        documentsDirectory,
        expectedHomeDirectory,
        rootDirectory: join(runRoot, "device-a-fixture"),
        runId,
        type: "hra-live-acceptance-device",
        version: 1,
      });
      const captured = capture();

      expect(await main(["init", "--yes", "--json"], captured.output, {
        installation,
      })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          defaultProjectCreated: true,
          initialized: true,
          stateRoot: installation.paths.root,
        },
        ok: true,
        version: 1,
      });
      expect(process.env.HOME).toBe(expectedHomeDirectory);
      expect((await lstat(installation.paths.database)).isFile()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("refresh-all skips signed-out accounts, bounds concurrency, and reports every outcome", async () => {
    const accounts = Array.from({ length: 7 }, (_, index) => ({
      id: `acct_${String(index).padStart(32, "0")}`,
      label: `Account ${String(index)}`,
      processGeneration: index === 0 ? 0 : 1,
      providerEmail: undefined,
      providerPlan: undefined,
      state: index === 0 ? "signed_out" as const : "signed_in" as const,
      updatedAt: index,
    }));
    let active = 0;
    let maximumActive = 0;
    let releaseWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseWave = resolve; });
    const commands: LocalCommand[] = [];
    const captured = capture();
    const automaticReset = (accountId: string) => ({
      threshold: { remainingPercent: 1, usedPercent: 99 },
      policy: { state: "active" as const },
      observation: {
        state: "unavailable" as const,
        reason: "weekly_window_unavailable" as const,
      },
      lastAttempt: accountId === accounts[1]?.id
        ? {
            state: "settled" as const,
            outcome: "reset" as const,
            weeklyWindowResetsAt: 2_000_000_000_000,
          }
        : null,
    });
    expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
      callDaemon: async (command) => {
        commands.push(command);
        if (command.kind === "account.list") {
          return { ok: true, version: 1, requestId: crypto.randomUUID(), data: { accounts: [...accounts].reverse() } };
        }
        if (command.kind === "account.usage" && command.refresh && command.account !== undefined) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          if (maximumActive === 4) releaseWave();
          await firstWave;
          active -= 1;
          if (command.account === accounts[3]?.id) {
            return {
              ok: false,
              version: 1,
              requestId: crypto.randomUUID(),
              error: {
                code: "UNAVAILABLE",
                message: "provider token=do-not-return failed at /private/account",
              },
            };
          }
          return {
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              usage: [{
                account: { id: command.account },
                automaticReset: automaticReset(command.account),
              }],
            },
          };
        }
        if (command.kind === "account.usage" && !command.refresh && command.account === undefined) {
          return {
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              usage: [...accounts].reverse().map((account) => ({
                account,
                automaticReset: automaticReset(account.id),
                poll: { state: "never_observed" },
                snapshot: null,
                velocity: {},
              })),
            },
          };
        }
        throw new Error("Unexpected refresh-all command.");
      },
    })).toBe(0);
    expect(maximumActive).toBe(4);
    expect(commands.filter((command) => command.kind === "account.usage" && command.refresh)).toHaveLength(6);
    expect(commands.some((command) =>
      command.kind === "account.usage" && command.refresh && command.account === accounts[0]?.id)).toBe(false);
    const payload = JSON.parse(captured.read().stdout) as {
      data: {
        refresh: { outcomes: Array<{ accountId: string; code?: string; state: string }> };
        usage: Array<{
          account: { id: string };
          automaticReset?: unknown;
        }>;
      };
    };
    expect(payload.data.refresh.outcomes.map((outcome) => outcome.accountId)).toEqual(
      accounts.map((account) => account.id),
    );
    expect(payload.data.refresh.outcomes[0]).toMatchObject({ state: "skipped" });
    expect(payload.data.refresh.outcomes[3]).toMatchObject({ code: "UNAVAILABLE", state: "failed" });
    expect(payload.data.usage.map((entry) => entry.account.id)).toEqual(accounts.map((account) => account.id));
    expect(payload.data.usage[1]).toMatchObject({
      automaticReset: {
        lastAttempt: {
          state: "settled",
          outcome: "reset",
          weeklyWindowResetsAt: 2_000_000_000_000,
        },
      },
    });
    expect(captured.read().stdout).not.toContain("do-not-return");
    expect(captured.read().stdout).not.toContain("/private/account");
    expect(captured.read().stderr).toBe("");
  });

  test("refresh-all rejects an oversized account set before any usage effect", async () => {
    const accounts = Array.from({ length: 33 }, (_, index) => ({
      id: `acct_${index.toString(16).padStart(32, "0")}`,
      label: `Account ${String(index)}`,
      processGeneration: 1,
      state: "signed_in" as const,
      updatedAt: index,
    }));
    const commands: LocalCommand[] = [];
    const captured = capture();
    expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: { accounts },
        });
      },
    })).toBe(5);
    expect(commands).toEqual([{ kind: "account.list" }]);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        details: { accountCount: 33, accountLimit: 32 },
      },
    });
  });

  test("refresh-all retains every outcome when the post-effect usage view is unavailable", async () => {
    const accounts = [
      {
        id: `acct_${"1".repeat(32)}`,
        label: "Signed in",
        processGeneration: 1,
        state: "signed_in" as const,
        updatedAt: 1,
      },
      {
        id: `acct_${"2".repeat(32)}`,
        label: "Signed out",
        processGeneration: 0,
        state: "signed_out" as const,
        updatedAt: 2,
      },
    ];
    const secret = "POST_REFRESH_HISTORY_SENTINEL_DO_NOT_RETURN";
    for (const historyFailure of ["invalid_response", "internal_failure"] as const) {
      const captured = capture();
      let refreshEffects = 0;
      expect(await main(["account", "usage", "--refresh", "--json"], captured.output, {
        callDaemon: async (command) => {
          if (command.kind === "account.list") {
            return {
              data: { accounts: [...accounts].reverse() },
              ok: true,
              requestId: crypto.randomUUID(),
              version: 1,
            };
          }
          if (command.kind === "account.usage" && command.refresh && command.account === accounts[0]?.id) {
            refreshEffects += 1;
            return {
              data: { usage: [{ account: { id: command.account } }] },
              ok: true,
              requestId: crypto.randomUUID(),
              version: 1,
            };
          }
          if (command.kind === "account.usage" && !command.refresh && command.account === undefined) {
            return historyFailure === "invalid_response"
              ? {
                  data: { diagnostic: secret, usage: "malformed" },
                  ok: true,
                  requestId: crypto.randomUUID(),
                  version: 1,
                }
              : {
                  error: {
                    code: "INTERNAL" as const,
                    details: { diagnostic: secret },
                    message: `provider unavailable ${secret}`,
                  },
                  ok: false,
                  requestId: crypto.randomUUID(),
                  version: 1,
                };
          }
          throw new Error("Unexpected refresh-all command.");
        },
      })).toBe(5);
      expect(refreshEffects).toBe(1);
      const payload = JSON.parse(captured.read().stdout) as {
        error: {
          code: string;
          details: {
            refresh: {
              accountLimit: number;
              concurrency: number;
              outcomes: Array<{ accountId: string; state: string }>;
            };
            usageView: { reasonCode: string; state: string };
          };
          message: string;
        };
      };
      expect(payload.error).toMatchObject({
        code: "UNAVAILABLE",
        details: {
          refresh: {
            accountLimit: 32,
            concurrency: 4,
            outcomes: [
              { accountId: accounts[0]?.id, state: "refreshed" },
              { accountId: accounts[1]?.id, state: "skipped" },
            ],
          },
          usageView: {
            reasonCode: historyFailure === "invalid_response" ? "INVALID_RESPONSE" : "INTERNAL",
            state: "unavailable",
          },
        },
        message: "Refresh outcomes were recorded, but the final usage view is unavailable.",
      });
      expect(captured.read().stdout).not.toContain(secret);
      expect(captured.read().stderr).toBe("");
    }
  });

  test("invalid input writes diagnostics only to stderr", async () => {
    const captured = capture();
    expect(await main(["session", "fast", "x", "maybe"], captured.output)).toBe(2);
    expect(captured.read().stdout).toBe("");
    expect(captured.read().stderr).toContain("Fast must be");
  });

  test("argv and unexpected runtime failures never echo foreign diagnostics", async () => {
    const attack = "token=do-not-echo\u001b]52;c;attack\u0007";
    const usage = capture();
    expect(await main(["account", "list", attack], usage.output)).toBe(2);
    expect(usage.read().stderr).not.toContain("do-not-echo");
    expect(usage.read().stderr).not.toContain("\u001b");

    const runtime = capture();
    expect(await main(["account", "list", "--json"], runtime.output, {
      callDaemon: () => { throw new Error(`/private/runtime ${attack}`); },
    })).toBe(1);
    expect(JSON.parse(runtime.read().stdout)).toEqual({
      ok: false,
      version: 1,
      error: {
        code: "INTERNAL",
        message: "Oompa could not complete the request safely.",
      },
    });
    expect(runtime.read().stdout).not.toContain("do-not-echo");
    expect(runtime.read().stdout).not.toContain("/private/runtime");
  });

  test("json intent survives parser and startup failures as one machine value", async () => {
    const captured = capture();
    expect(await main(["session", "fast", "x", "maybe", "--json"], captured.output)).toBe(2);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      version: 1,
      error: { code: "INVALID_INPUT", message: "Fast must be `on` or `off`." },
    });
    expect(captured.read().stdout.trim().split("\n")).toHaveLength(1);
    expect(captured.read().stderr).toBe("");
  });

  test("jsonl and follow intent keep malformed invocations machine-readable on stderr", async () => {
    for (const argv of [
      ["session", "events", "release", "--jsonl", "--wait-ms", "0"],
      ["account", "list", "--follow"],
    ]) {
      const captured = capture();
      expect(await main(argv, captured.output)).toBe(2);
      expect(captured.read().stdout).toBe("");
      expect(captured.read().stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(captured.read().stderr)).toMatchObject({
        error: { code: "INVALID_INPUT" },
        ok: false,
        version: 1,
      });
      expect(captured.read().stderr).not.toContain("Usage:");
    }
  });

  test("rejects malformed command-specific success data as INVALID_RESPONSE", async () => {
    const secret = "PRIVATE-MALFORMED-DEVICE-RESPONSE";
    const json = capture();
    expect(await main(["device", "list", "--json"], json.output, {
      callDaemon: () => Promise.resolve({
        data: { devices: [{ encryptedLabel: secret }] },
        ok: true,
        requestId: "018bcfe5-6800-7000-8000-000000000799",
        version: 1,
      }),
    })).toBe(1);
    expect(json.read().stderr).toBe("");
    expect(JSON.parse(json.read().stdout)).toMatchObject({
      error: {
        code: "INVALID_RESPONSE",
        message: "The Oompa daemon returned an invalid response for this command.",
      },
      ok: false,
      version: 1,
    });
    expect(json.read().stdout).not.toContain(secret);

    const human = capture();
    expect(await main(["device", "list"], human.output, {
      callDaemon: () => Promise.resolve({
        data: { devices: [{ encryptedLabel: secret }] },
        ok: true,
        requestId: "018bcfe5-6800-7000-8000-000000000799",
        version: 1,
      }),
    })).toBe(1);
    expect(human.read().stdout).toBe("");
    expect(human.read().stderr).toBe("oompa: The Oompa daemon returned an invalid response for this command.\n");
    expect(human.read().stderr).not.toContain(secret);
  });

  test("version is sourced from package metadata", async () => {
    const captured = capture();
    expect(await main(["--version"], captured.output)).toBe(0);
    expect(captured.read()).toEqual({ stdout: `oompa ${packageMetadata.version}\n`, stderr: "" });
  });

  test("completes protected interaction input outside argv and never renders its value", async () => {
    const captured = capture();
    const commands: unknown[] = [];
    const interaction = "018bcfe5-6800-7000-8000-000000000777";
    const secretAnswer = "value-that-must-not-be-rendered";
    expect(await main([
      "interaction",
      "answer",
      interaction,
      "--revision",
      "4",
      "--input-stdin",
      "--json",
    ], captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: "018bcfe5-6800-7000-8000-000000000778",
          data: {
            interaction: {
              version: 1,
              id: interaction,
              sessionId: null,
              kind: "user_input",
              state: "response_written",
              revision: 6,
              blocking: true,
              display: {
                kind: "user_input",
                summary: "Answer recorded",
                blocking: true,
                questions: [{
                  id: "question_1",
                  header: "Question",
                  question: "Provide an answer.",
                  options: null,
                  allowsOther: true,
                  secret: true,
                }],
              },
              responseRecorded: true,
              context: { turnId: null, itemId: null },
              requestedAt: 1_000,
              deadlineAt: 61_000,
              updatedAt: 2_000,
              terminalAt: null,
            },
            responseWritten: true,
          },
        });
      },
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve({
        answers: { question_1: { answers: [secretAnswer] } },
      }),
    })).toBe(0);
    expect(commands).toEqual([{
      kind: "interaction.resolve",
      interaction,
      expectedRevision: 4,
      resolution: {
        kind: "user_answers",
        answers: { question_1: { answers: [secretAnswer] } },
      },
    }]);
    expect(JSON.stringify(captured.read())).not.toContain(secretAnswer);
  });

  test("reads the gateway key from a descriptor and keeps it off argv and output", async () => {
    // Twenty-four printable characters, assembled rather than written.
    const key = ["gw", "k".repeat(22)].join("");
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-gateway-key-")));
    try {
      const file = join(home, "key");
      await writeFile(file, `${key}\n`, { mode: 0o600 });
      const descriptor = openSync(file, "r");
      try {
        const captured = capture();
        const commands: LocalCommand[] = [];
        const argv = ["autorespond", "gateway", "set", "--from-fd", String(descriptor), "--json"];
        expect(argv.join(" ")).not.toContain(key);
        expect(await main(argv, captured.output, {
          callDaemon: (command) => {
            commands.push(command);
            return Promise.resolve({
              data: { gateway: "configured", version: 1 },
              ok: true,
              requestId: "018bcfe5-6800-7000-8000-00000000077a",
              version: 1,
            });
          },
          isTerminalDescriptor: () => false,
        })).toBe(0);
        expect(commands).toEqual([{ key, kind: "autorespond.gateway-set" }]);
        expect(JSON.stringify(captured.read())).not.toContain(key);
        expect(captured.read().stdout).toContain("autorespond.gateway-set");
      } finally {
        closeSync(descriptor);
      }
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("refuses a gateway key that is not one printable line", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-gateway-key-bad-")));
    try {
      const file = join(home, "key");
      await writeFile(file, "short\n", { mode: 0o600 });
      const descriptor = openSync(file, "r");
      try {
        const captured = capture();
        let daemonCalls = 0;
        expect(await main(
          ["autorespond", "gateway", "set", "--from-fd", String(descriptor), "--json"],
          captured.output,
          {
            callDaemon: () => {
              daemonCalls += 1;
              throw new Error("Daemon must not be called.");
            },
            isTerminalDescriptor: () => false,
          },
        )).not.toBe(0);
        expect(daemonCalls).toBe(0);
      } finally {
        closeSync(descriptor);
      }
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  test("keeps identity invites and verification codes off argv and output", async () => {
    const captured = capture();
    const commands: LocalCommand[] = [];
    const invite = `hra_invite_identity_v1_${"A".repeat(43)}`;
    const argv = ["auth", "login", "--input-fd", "3", "--json"];
    expect(argv.join(" ")).not.toContain(invite);
    expect(await main(argv, captured.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          data: { codeRequestedOrRejected: true, signedIn: false },
          ok: true,
          requestId: "018bcfe5-6800-7000-8000-000000000779",
          version: 1,
        });
      },
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve({
        email: "reader@example.com",
        invite,
      }),
    })).toBe(0);
    expect(commands).toEqual([{
      email: "reader@example.com",
      invite,
      kind: "auth.login",
    }]);
    expect(JSON.stringify(captured.read())).not.toContain(invite);
  });

  test("json protected commands refuse terminal input before reading or prompting", async () => {
    const interaction = "018bcfe5-6800-7000-8000-000000000777";
    for (const argv of [
      ["auth", "login", "--input-stdin", "--json"],
      [
        "interaction",
        "answer",
        interaction,
        "--revision",
        "4",
        "--input-stdin",
        "--json",
      ],
    ] as const) {
      const captured = capture();
      let reads = 0;
      let daemonCalls = 0;
      expect(await main(argv, captured.output, {
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("Daemon must not be called.");
        },
        isTerminalDescriptor: (fd) => {
          expect(fd).toBe(0);
          return true;
        },
        readProtectedDocument: () => {
          reads += 1;
          throw new Error("Protected input must not be read.");
        },
      })).toBe(6);
      expect(reads).toBe(0);
      expect(daemonCalls).toBe(0);
      expect(captured.read().stderr).toBe("");
      const response = JSON.parse(captured.read().stdout) as {
        error: { code: string; details: { nextCommand: string } };
        ok: boolean;
      };
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INTERACTION_REQUIRED",
          details: { nextCommand: expect.stringContaining("--input-stdin --json") },
        },
      });
      expect(captured.read().stdout).not.toContain("hidden");
    }
  });

  test("human protected commands refuse an invisible terminal prompt", async () => {
    const captured = capture();
    let daemonCalls = 0;
    expect(await main([
      "interaction",
      "answer",
      "018bcfe5-6800-7000-8000-000000000777",
      "--revision",
      "4",
      "--input-stdin",
    ], captured.output, {
      callDaemon: () => {
        daemonCalls += 1;
        throw new Error("Daemon must not be called.");
      },
      interactive: false,
      isTerminalDescriptor: () => true,
    })).toBe(2);
    expect(daemonCalls).toBe(0);
    expect(captured.read().stderr).toContain("visible terminal on stderr");
    expect(captured.read().stderr).not.toContain("Type BEGIN-");
  });

  test("requires a protected account-login handoff before noninteractive dispatch", async () => {
    for (const argv of [
      ["account", "login", "personal", "--device-code", "--json"],
      ["account", "login", "personal", "--device-code"],
    ] as const) {
      const captured = capture();
      let daemonCalls = 0;
      expect(await main(argv, captured.output, {
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("Login must not dispatch.");
        },
        interactive: false,
      })).toBe(6);
      expect(daemonCalls).toBe(0);
      const rendered = `${captured.read().stdout}${captured.read().stderr}`;
      expect(rendered).toContain("--idempotency-key");
      expect(rendered).toContain("--handoff-file /absolute/path/to/empty-protected-login.json");
    }
  });

  test("requires protected output before inspecting live approval authority noninteractively", async () => {
    const captured = capture();
    let daemonCalls = 0;
    const interaction = "40000000-0000-4000-8000-000000000001";
    expect(await main([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "3",
      "--json",
    ], captured.output, {
      callDaemon: () => {
        daemonCalls += 1;
        throw new Error("Protected inspection must not dispatch.");
      },
      interactive: false,
    })).toBe(6);
    expect(daemonCalls).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      error: {
        code: "INTERACTION_REQUIRED",
        details: {
          nextCommand: `oompa interaction inspect ${interaction} --revision 3 --handoff-file /absolute/path/to/empty-protected-approval.json --json`,
        },
      },
      ok: false,
    });
  });

  test("writes exact live approval authority only to the pre-proven protected file", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "oompa-cli-approval-"));
    const handoff = join(root, "approval.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const interaction = "40000000-0000-4000-8000-000000000001";
    const privateCommand = "git reset --hard CLI-PRIVATE-APPROVAL-SENTINEL";
    const document = {
      type: "hra_protected_interaction_detail" as const,
      version: 1 as const,
      binding: {
        interactionId: interaction,
        revision: 3,
        kind: "command_approval" as const,
        sessionId: `sess_${"2".repeat(32)}`,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 4,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval" as const,
        command: privateCommand,
        reason: "Apply the exact reset",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/private/workspace",
        environmentId: "environment-1",
        commandActions: [{ type: "unknown", command: privateCommand }],
        networkApprovalContext: { host: "private.example", protocol: "https" },
        additionalPermissions: { network: { enabled: true } },
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const captured = capture();
    try {
      expect(await main([
        "interaction",
        "inspect",
        interaction,
        "--revision",
        "3",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: (command) => {
          expect(command).toEqual({
            kind: "interaction.inspect",
            interaction,
            expectedRevision: 3,
          });
          return Promise.resolve({
            data: document,
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          });
        },
        interactive: false,
      })).toBe(0);
      const rendered = captured.read();
      expect(rendered.stderr).toBe("");
      expect(rendered.stdout).not.toContain("CLI-PRIVATE-APPROVAL-SENTINEL");
      expect(rendered.stdout).not.toContain("/private/workspace");
      expect(JSON.parse(rendered.stdout)).toMatchObject({
        data: {
          interactionId: interaction,
          revision: 3,
          protectedOutput: {
            disposition: "preserved_caller_removes_after_decision",
            documentVersion: 1,
            path: handoff,
            status: "written",
          },
        },
        ok: true,
      });
      expect(JSON.parse(await readFile(handoff, "utf8"))).toEqual(document);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("shows exact approval authority only in a proven foreground terminal", async () => {
    const interaction = "40000000-0000-4000-8000-000000000001";
    const privatePermission = "/private/PERMISSION-VALUE-SENTINEL";
    const captured = capture();
    const protectedTerminalOutput = {
      ...captured.output,
      writeProtectedStderr: captured.output.writeStderr,
    };
    expect(await main([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "4",
    ], protectedTerminalOutput, {
      callDaemon: () => Promise.resolve({
        data: {
          type: "hra_protected_interaction_detail",
          version: 1,
          binding: {
            interactionId: interaction,
            revision: 4,
            kind: "permission_approval",
            sessionId: null,
            profileId: `acct_${"1".repeat(32)}`,
            processGeneration: 4,
            connectionId: "40000000-0000-4000-8000-000000000002",
          },
          authority: {
            kind: "permission_approval",
            permissions: { fileSystem: { read: [privatePermission] } },
            reason: "Read the exact path",
            workingDirectory: "/private/workspace",
            environmentId: null,
          },
        },
        ok: true,
        requestId: crypto.randomUUID(),
        version: 1,
      }),
      interactive: true,
      isTerminalDescriptor: (fd) => fd === 2,
    })).toBe(0);
    expect(captured.read().stderr).toContain(privatePermission);
    expect(captured.read().stderr).toContain("Exact requested permissions");
    expect(captured.read().stdout).toContain("shown in the foreground terminal");
    expect(captured.read().stdout).not.toContain(privatePermission);
  });

  test("uses one exact terminal byte limit and requires a protected file above it", async () => {
    const interaction = "40000000-0000-4000-8000-000000000001";
    const sentinel = "TERMINAL-APPROVAL-SENTINEL";
    const base: ProtectedInteractionDetailDocument = {
      type: "hra_protected_interaction_detail",
      version: 1,
      binding: {
        interactionId: interaction,
        revision: 5,
        kind: "command_approval",
        sessionId: null,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 4,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval",
        command: `git status ${sentinel}`,
        reason: "Inspect terminal bound",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/workspace",
        environmentId: null,
        commandActions: [],
        networkApprovalContext: null,
        additionalPermissions: "",
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const emptyEncoded = new TextEncoder().encode(renderProtectedInteractionDetail(base));
    const fillerBytes = PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES - emptyEncoded.byteLength;
    emptyEncoded.fill(0);
    const baseAuthority = base.authority;
    if (fillerBytes < 0 || baseAuthority.kind !== "command_approval") {
      throw new Error("Terminal approval fixture is invalid.");
    }
    const documentAt = (bytes: number): ProtectedInteractionDetailDocument => ({
      ...base,
      authority: {
        ...baseAuthority,
        additionalPermissions: "a".repeat(fillerBytes + bytes - PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES),
      },
    });
    for (const target of [
      PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
      PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES + 1,
    ]) {
      const document = documentAt(target);
      const encoded = new TextEncoder().encode(renderProtectedInteractionDetail(document));
      expect(encoded.byteLength).toBe(target);
      encoded.fill(0);
      const captured = capture();
      const protectedTerminalOutput = {
        ...captured.output,
        writeProtectedStderr: captured.output.writeStderr,
      };
      expect(await main([
        "interaction",
        "inspect",
        interaction,
        "--revision",
        "5",
      ], protectedTerminalOutput, {
        callDaemon: () => Promise.resolve({
          data: document,
          ok: true,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
        interactive: true,
        isTerminalDescriptor: (fd) => fd === 2,
      })).toBe(target === PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES ? 0 : 6);
      if (target === PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES) {
        expect(captured.read().stderr).toContain(sentinel);
      } else {
        expect(captured.read().stderr).not.toContain(sentinel);
        expect(captured.read().stderr).toContain(
          `oompa interaction inspect ${interaction} --revision 5 --handoff-file /absolute/path/to/empty-protected-approval.json`,
        );
      }
    }
  });

  test("does not invent cancellation authority when the pre-effect account lookup is uncertain", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "oompa-cli-login-lookup-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const captured = capture();
    let calls = 0;
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: () => {
          calls += 1;
          throw new LocalDaemonIndeterminateError("read response lost");
        },
        interactive: false,
      })).toBe(5);
      expect(calls).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        error: {
          code: "UNAVAILABLE",
          details: { providerEffectDispatched: false },
        },
        ok: false,
      });
      expect(captured.read().stdout).not.toContain("cancelCommand");
      expect(await readFile(handoff, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("surfaces the exact generated device key after an indeterminate daemon response", async () => {
    const captured = capture();
    let generatedKey = "";
    expect(await main([
      "device",
      "approve",
      "device_pending",
      "--fingerprint",
      "0000-1111-2222-3333-4444-5555-6666-7777",
      "--json",
    ], captured.output, {
      callDaemon: (command) => {
        if (command.kind === "device.approve") generatedKey = command.idempotencyKey;
        throw new LocalDaemonIndeterminateError("device response lost");
      },
    })).toBe(7);
    expect(generatedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const rendered = JSON.parse(captured.read().stdout) as {
      error: {
        code: string;
        details: { idempotencyKey: string; nextCommand: string; sameKeyReplay: boolean };
      };
    };
    expect(rendered).toMatchObject({
      error: {
        code: "RECOVERY_REQUIRED",
        details: { idempotencyKey: generatedKey, sameKeyReplay: true },
      },
    });
    expect(rendered.error.details.nextCommand)
      .toBe(
        "oompa device approve device_pending"
        + " --fingerprint 0000-1111-2222-3333-4444-5555-6666-7777"
        + ` --idempotency-key ${generatedKey} --json`,
      );
  });

  test("keeps rejected projection recovery as an immutable receipt with one status action", async () => {
    const session = `sess_${"6".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000700";
    for (const json of [false, true]) {
      const captured = capture();
      expect(await main([
        "sync",
        "projection",
        "recover",
        session,
        "--acknowledge-gap",
        "--idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ], captured.output, {
        callDaemon: () => Promise.resolve({
          data: {
            idempotencyKey,
            phase: "rejected",
            rejectionCode: "REMOTE_HEAD_CHANGED",
            sessionPublicId: session,
          },
          ok: true,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
      })).toBe(0);
      const rendered = captured.read();
      const replayCommand = [
        "oompa sync projection recover",
        session,
        "--acknowledge-gap --idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ].join(" ");
      if (json) {
        expect(JSON.parse(rendered.stdout)).toEqual({
          command: "sync.projection-recover",
          data: {
            idempotencyKey,
            nextCommand: "oompa sync status --json",
            phase: "rejected",
            rejectionCode: "REMOTE_HEAD_CHANGED",
            sameKeyReplay: { command: replayCommand, supported: true },
            session,
          },
          ok: true,
          version: 1,
        });
      } else {
        expect(rendered.stdout).toBe([
          `Projection recovery rejected for ${session}.`,
          "Reason: REMOTE_HEAD_CHANGED",
          "Encrypted cloud history and provider/app state were unchanged.",
          `Same-key replay: ${replayCommand}`,
          "Next: oompa sync status --json",
          "",
        ].join("\n"));
      }
      expect(rendered.stderr).toBe("");
    }
  });

  test("preserves only the exact projection-status recovery action across human and JSON failures", async () => {
    const session = `sess_${"7".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000701";
    const providerSentinel = "PRIVATE-PROVIDER-PROJECTION-DETAIL";
    for (const json of [false, true]) {
      const captured = capture();
      expect(await main([
        "sync",
        "projection",
        "recover",
        session,
        "--acknowledge-gap",
        "--idempotency-key",
        idempotencyKey,
        ...(json ? ["--json"] : []),
      ], captured.output, {
        callDaemon: () => Promise.resolve({
          error: {
            code: "RECOVERY_REQUIRED",
            details: {
              nextCommand: "oompa sync status --json",
              providerDetail: providerSentinel,
              providerPath: "/private/provider/projection",
            },
            message: "Projection recovery requires local status inspection.",
          },
          ok: false,
          requestId: crypto.randomUUID(),
          version: 1,
        }),
      })).toBe(7);
      const rendered = captured.read();
      expect(rendered.stdout).not.toContain(providerSentinel);
      expect(rendered.stderr).not.toContain(providerSentinel);
      expect(rendered.stdout).not.toContain("/private/provider/projection");
      expect(rendered.stderr).not.toContain("/private/provider/projection");
      if (json) {
        expect(JSON.parse(rendered.stdout)).toEqual({
          error: {
            code: "RECOVERY_REQUIRED",
            details: { nextCommand: "oompa sync status --json" },
            message: "Projection recovery requires local status inspection.",
          },
          ok: false,
          version: 1,
        });
        expect(rendered.stderr).toBe("");
      } else {
        expect(rendered.stdout).toBe("");
        expect(rendered.stderr).toBe([
          "oompa: Projection recovery requires local status inspection.",
          "Next: oompa sync status --json",
          "",
        ].join("\n"));
      }
    }
  });

  test("drops every unrecognized projection-recovery failure detail", async () => {
    const session = `sess_${"8".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000702";
    const providerSentinel = "PRIVATE-PROVIDER-FAILURE-DETAIL";
    for (const details of [
      { nextCommand: "oompa sync status --json; touch /tmp/unsafe", providerDetail: providerSentinel },
      { nextCommand: "oompa doctor", providerDetail: providerSentinel },
      { providerDetail: providerSentinel },
    ]) {
      for (const json of [false, true]) {
        const captured = capture();
        expect(await main([
          "sync",
          "projection",
          "recover",
          session,
          "--acknowledge-gap",
          "--idempotency-key",
          idempotencyKey,
          ...(json ? ["--json"] : []),
        ], captured.output, {
          callDaemon: () => Promise.resolve({
            error: {
              code: "RECOVERY_REQUIRED",
              details,
              message: "Projection recovery requires local status inspection.",
            },
            ok: false,
            requestId: crypto.randomUUID(),
            version: 1,
          }),
        })).toBe(7);
        const rendered = captured.read();
        expect(rendered.stdout).not.toContain(providerSentinel);
        expect(rendered.stderr).not.toContain(providerSentinel);
        expect(rendered.stdout).not.toContain("touch /tmp/unsafe");
        expect(rendered.stderr).not.toContain("touch /tmp/unsafe");
        if (json) {
          const document = JSON.parse(rendered.stdout) as { error: Record<string, unknown> };
          expect(document.error).not.toHaveProperty("details");
          expect(rendered.stderr).toBe("");
        } else {
          expect(rendered.stdout).toBe("");
          expect(rendered.stderr).toBe(
            "oompa: Projection recovery requires local status inspection.\n",
          );
        }
      }
    }
  });

  test("an uncertain automatic policy response preserves the original key and revision without retrying", async () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000151";
    for (const json of [false, true]) {
      const captured = capture();
      const calls: unknown[] = [];
      expect(await main([
        "usage", "auto", "off", "codex", "--revision", "7",
        "--idempotency-key", idempotencyKey, ...(json ? ["--json"] : []),
      ], captured.output, {
        callDaemon: (command) => {
          calls.push(command);
          throw new LocalDaemonIndeterminateError("private-policy-transport-sentinel");
        },
      })).toBe(7);
      expect(calls).toEqual([{
        kind: "usage.auto.set", idempotencyKey, expectedAutomaticPolicyRevision: 7,
        change: { kind: "set_override", provider: "codex", override: "off" },
      }]);
      const rendered = captured.read();
      expect(rendered.stdout + rendered.stderr).not.toContain("private-policy-transport-sentinel");
      expect(rendered.stdout + rendered.stderr).toContain("original command unchanged");
      if (json) {
        expect(JSON.parse(rendered.stdout)).toMatchObject({
          error: { code: "RECOVERY_REQUIRED", details: {
            idempotencyKey, sameKeyReplay: true,
            replayArguments: ["--idempotency-key", idempotencyKey],
          } },
        });
      } else {
        expect(rendered.stdout).toBe("");
        expect(rendered.stderr).toContain(idempotencyKey);
      }
    }
  });

  test("surfaces same-key replay arguments for every indeterminate local mutation without echoing its payload", async () => {
    const privatePayload = "message-private-sentinel";
    const commands = [
      ["account", "logout", "personal", "--json"],
      ["session", "start", "personal", "--json"],
      ["session", "start", "personal", "--provider", "claude", "--json"],
      ["session", "send", "session-1", privatePayload, "--json"],
      ["session", "queue", "session-1", privatePayload, "--json"],
      ["session", "steer", "session-1", privatePayload, "--json"],
      ["session", "stop", "session-1", "--json"],
      ["session", "rename", "session-1", privatePayload, "--json"],
      ["session", "switch", "session-1", "--provider", "codex", "--preset", "high", "--json"],
      ["session", "task", "create", "session-1", "--name", "review", "--every-minutes", "15", "--json", "--", privatePayload],
      ["session", "task", "edit", "session-1", `stask_${"1".repeat(32)}`, "--revision", "1", "--json", "--", privatePayload],
      ["session", "task", "delete", "session-1", `stask_${"1".repeat(32)}`, "--revision", "1", "--json"],
      ["memory", "remember", "session-1", "preferences.review", "--title", "Review style", "--summary", "Private summary", "--json", "--", privatePayload],
      ["memory", "share", "session-1", "preferences.review", "--reason", privatePayload, "--json"],
      ["memory", "hosted", "create", privatePayload, "--json"],
    ] as const;

    for (const argv of commands) {
      const captured = capture();
      let generatedKey = "";
      let authoredPresetContract: 1 | 2 | undefined;
      expect(await main(argv, captured.output, {
        callDaemon: (command) => {
          generatedKey = "idempotencyKey" in command
            && typeof command.idempotencyKey === "string"
            ? command.idempotencyKey
            : "";
          authoredPresetContract = command.kind === "session.start"
            || command.kind === "session.switch"
            ? command.presetContract
            : undefined;
          throw new LocalDaemonIndeterminateError("mutation response lost");
        },
      })).toBe(7);
      expect(generatedKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      const rendered = JSON.parse(captured.read().stdout) as {
        error: {
          code: string;
          details: {
            idempotencyKey: string;
            replayArguments: string[];
            replayPlacement: string;
            sameKeyReplay: boolean;
          };
        };
      };
      expect(rendered).toMatchObject({
        error: {
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: generatedKey,
            replayArguments: [
              "--idempotency-key",
              generatedKey,
              ...(authoredPresetContract === undefined
                ? []
                : ["--preset-contract", String(authoredPresetContract)]),
            ],
            replayPlacement: "before_double_dash",
            sameKeyReplay: true,
          },
        },
      });
      expect(captured.read().stdout).not.toContain(privatePayload);
    }

    const human = capture();
    let humanKey = "";
    expect(await main([
      "session",
      "queue",
      "session-1",
      "--",
      privatePayload,
    ], human.output, {
      callDaemon: (command) => {
        humanKey = command.kind === "session.queue"
          && typeof command.idempotencyKey === "string"
          ? command.idempotencyKey
          : "";
        throw new LocalDaemonIndeterminateError("mutation response lost");
      },
    })).toBe(7);
    expect(human.read().stdout).toBe("");
    expect(human.read().stderr).toContain(humanKey);
    expect(human.read().stderr).toContain("before_double_dash");
    expect(human.read().stderr).not.toContain(privatePayload);
  });

  test("writes first-use Codex login secrets only to the held protected file", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "oompa-cli-login-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const secretCode = "CLIX-SECRET-CODE";
    const secretUrl = "https://example.test/device?secret=cli-sentinel";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--json",
      ], captured.output, {
        callDaemon: (command) => {
          if (command.kind === "account.list") {
            return Promise.resolve({
              data: {
                accounts: [{
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 0,
                  state: "signed_out",
                  updatedAt: 0,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            });
          }
          if (command.kind !== "account.login" || command.idempotencyKey === undefined) {
            throw new Error("Expected account login.");
          }
          expect(command.account).toBe(`acct_${"1".repeat(32)}`);
          return Promise.resolve({
            data: {
              account: {
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey: command.idempotencyKey,
              login: {
                loginId: "provider-login",
                next: `oompa account login-cancel acct_${"1".repeat(32)}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true,
            requestId: crypto.randomUUID(),
            version: 1,
          });
        },
        interactive: false,
      })).toBe(0);
      const rendered = JSON.stringify(captured.read());
      expect(rendered).not.toContain(secretCode);
      expect(rendered).not.toContain("cli-sentinel");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: {
          login: {
            handoff: {
              disposition: "preserved_caller_removes_after_login",
              documentVersion: 1,
              path: handoff,
              status: "written",
            },
            status: "pending",
          },
        },
      });
      expect(JSON.parse(await readFile(handoff, "utf8"))).toMatchObject({
        type: "codex_device_login",
        userCode: secretCode,
        verificationUrl: secretUrl,
        version: 1,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("runs Devin's pinned foreground login in all five isolated directories", async () => {
    const { installation, runRoot } = await upgradeFixture("devin-account-login");
    const accountId = `acct_${"d".repeat(32)}` as const;
    const attemptId = `attempt_${"e".repeat(32)}` as const;
    const idempotencyKey = "00000000-0000-4000-8000-000000000321";
    const calls: LocalCommand[] = [];
    let preflights = 0;
    let loginDirectories: Readonly<{
      home: string;
      configHome: string;
      dataHome: string;
      cacheHome: string;
      stateHome: string;
    }> | undefined;
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--provider",
        "devin",
        "--manual-token-flow",
        "--idempotency-key",
        idempotencyKey,
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        callDaemon: async (command) => {
          calls.push(command);
          if (command.kind === "account.show") {
            return {
              data: {
                account: { id: accountId, label: "Personal" },
                authentication: { provider: "devin", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider devin`,
                providerGeneration: 7,
                usage: {
                  allowance: "unknown",
                  reason: "Devin exposes no account allowance or reset window.",
                  source: "devin_acp",
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind === "account.devin-login.prepare") {
            return {
              data: {
                account: { id: accountId, label: "Personal" },
                authentication: { provider: "devin", signedIn: false },
                login: {
                  status: "launch_granted",
                  attemptId,
                  idempotencyKey,
                  providerGeneration: 7,
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind !== "account.devin-login.complete") throw new Error("Unexpected command.");
          return {
            data: {
              account: { id: accountId, label: "Personal" },
              authentication: { provider: "devin", signedIn: true },
              login: {
                status: "signed_in",
                attemptId,
                idempotencyKey,
                providerGeneration: 7,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        runDevinForegroundLogin: async ({ directories, manualTokenFlow, stdio }) => {
          loginDirectories = directories;
          expect(manualTokenFlow).toBe(true);
          expect(stdio).toEqual({ stderr: 2, stdin: 0, stdout: 1 });
          return { state: "joined", exitCode: 0, interruptedBy: null };
        },
        resolveDevinRuntime: async () => {
          preflights += 1;
          return cliDevinRuntime;
        },
      })).toBe(0);
      expect(calls).toEqual([
        { account: "Personal", kind: "account.show", provider: "devin" },
        {
          account: "Personal",
          idempotencyKey,
          kind: "account.devin-login.prepare",
          manualTokenFlow: true,
        },
        {
          account: accountId,
          attemptId,
          idempotencyKey,
          kind: "account.devin-login.complete",
          outcome: { state: "joined", exitCode: 0, interruptedBy: null },
          providerGeneration: 7,
        },
      ]);
      expect(loginDirectories).toEqual({
        home: join(installation.paths.profiles, accountId, "devin-home"),
        configHome: join(installation.paths.profiles, accountId, "devin-config"),
        dataHome: join(installation.paths.profiles, accountId, "devin-data"),
        cacheHome: join(installation.paths.profiles, accountId, "devin-cache"),
        stateHome: join(installation.paths.profiles, accountId, "devin-state"),
      });
      expect(preflights).toBe(2);
      if (loginDirectories === undefined) throw new Error("Devin login did not receive directories.");
      for (const directory of Object.values(loginDirectories)) {
        expect((await lstat(directory)).mode & 0o077).toBe(0);
      }
      expect(captured.read()).toEqual({
        stderr: "",
        stdout: "Devin is signed in for Personal.\n",
      });
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test.each(["provider_default", "owner_manual"] as const)("preflights Claude and completes the exact attempt with %s", async (browserMode) => {
    const { installation, runRoot } = await upgradeFixture("claude-account-login");
    const accountId = `acct_${"1".repeat(32)}` as const;
    const attemptId = `attempt_${"2".repeat(32)}` as const;
    const idempotencyKey = "00000000-0000-4000-8000-000000000301";
    const calls: LocalCommand[] = [];
    let preflights = 0;
    let loginConfigDir = "";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--provider",
        "claude",
        ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
        "--idempotency-key",
        idempotencyKey,
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        callDaemon: async (command) => {
          calls.push(command);
          if (command.kind === "account.show") {
            return {
              data: {
                account: { id: accountId, label: "Personal" },
                authentication: { provider: "claude", signedIn: true },
                providerGeneration: 7,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind === "account.claude-login.prepare") {
            return {
              data: {
                account: { id: accountId, label: "Personal" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "launch_granted", attemptId, idempotencyKey, providerGeneration: 7 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind !== "account.claude-login.complete") throw new Error("Unexpected command.");
          return {
            data: {
              account: { id: accountId, label: "Personal" },
              authentication: { provider: "claude", signedIn: true },
              login: { status: "signed_in", attemptId, idempotencyKey, providerGeneration: 7 },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        runClaudeForegroundLogin: async ({ configDir, stdio, browserMode: launchMode }) => {
          expect(launchMode).toBe(browserMode);
          expect(captured.read().stderr.includes("Claude login for Oompa profile Personal.")).toBe(browserMode === "owner_manual");
          loginConfigDir = configDir;
          expect(stdio).toEqual({ stderr: 2, stdin: 0, stdout: 1 });
          return { state: "joined", exitCode: 0, interruptedBy: null };
        },
        resolveClaudeRuntime: async () => { preflights += 1; return cliClaudeRuntime; },
      })).toBe(0);
      expect(calls).toEqual([
        { account: "Personal", kind: "account.show", provider: "claude" },
        { account: "Personal", idempotencyKey, kind: "account.claude-login.prepare" },
        {
          account: accountId,
          attemptId,
          idempotencyKey,
          kind: "account.claude-login.complete",
          outcome: { state: "joined", exitCode: 0, interruptedBy: null },
          providerGeneration: 7,
        },
      ]);
      expect(loginConfigDir).toBe(join(installation.paths.profiles, accountId, "claude-config"));
      expect(preflights).toBe(2);
      expect((await lstat(loginConfigDir)).mode & 0o077).toBe(0);
      expect(captured.read()).toEqual({
        stderr: browserMode === "owner_manual"
          ? "Claude login for Oompa profile Personal.\n"
            + "Close all prior private/incognito windows, then open one fresh private window; keep normal browser sessions unchanged.\n"
            + "Copy Claude's printed link unchanged into that window. Check the intended account before approving sign-in.\n"
          : "",
        stdout: "Claude Code is signed in for Personal.\n",
      });
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("rejects incoherent Claude authentication and login response states", async () => {
    const cases = [
      { phase: "prepare", loginStatus: "signed_in", signedIn: false },
      { phase: "prepare", loginStatus: "launch_granted", signedIn: true },
      { phase: "complete", loginStatus: "signed_in", signedIn: false },
      { phase: "complete", loginStatus: "signed_out", signedIn: true },
    ] as const;
    for (const [index, scenario] of cases.entries()) {
      const { installation, runRoot } = await upgradeFixture(`claude-login-incoherent-${index}`);
      const accountId = `acct_${String(index + 3).repeat(32)}` as const;
      const attemptId = `attempt_${String(index + 3).repeat(32)}` as const;
      const idempotencyKey = `00000000-0000-4000-8000-00000000030${index + 2}`;
      const captured = capture();
      let foregroundCalls = 0;
      try {
        expect(await main([
          "account", "login", accountId, "--provider", "claude", "--idempotency-key", idempotencyKey,
        ], captured.output, {
          installation,
          interactive: true,
          isTerminalDescriptor: () => true,
          resolveClaudeRuntime: async () => cliClaudeRuntime,
          runClaudeForegroundLogin: async () => {
            foregroundCalls += 1;
            return { state: "joined", exitCode: 0, interruptedBy: null };
          },
          callDaemon: async (command) => {
            if (command.kind === "account.show") return {
              data: {
                account: { id: accountId, label: "Incoherent" },
                authentication: { provider: "claude", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider claude`,
                providerGeneration: 7,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            if (command.kind === "account.claude-login.prepare") {
              if (scenario.phase === "prepare") return {
                data: {
                  account: { id: accountId, label: "Incoherent" },
                  authentication: { provider: "claude", signedIn: scenario.signedIn },
                  login: scenario.loginStatus === "signed_in"
                    ? { status: "signed_in" as const }
                    : {
                        status: "launch_granted" as const,
                        attemptId,
                        idempotencyKey,
                        providerGeneration: 7,
                      },
                },
                ok: true as const,
                requestId: crypto.randomUUID(),
                version: 1 as const,
              };
              return {
                data: {
                  account: { id: accountId, label: "Incoherent" },
                  authentication: { provider: "claude", signedIn: false },
                  login: { status: "launch_granted", attemptId, idempotencyKey, providerGeneration: 7 },
                },
                ok: true as const,
                requestId: crypto.randomUUID(),
                version: 1 as const,
              };
            }
            if (scenario.phase !== "complete" || command.kind !== "account.claude-login.complete") {
              throw new Error("Unexpected command.");
            }
            return {
              data: {
                account: { id: accountId, label: "Incoherent" },
                authentication: { provider: "claude", signedIn: scenario.signedIn },
                login: {
                  status: scenario.loginStatus,
                  attemptId,
                  idempotencyKey,
                  providerGeneration: 7,
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          },
        })).toBe(7);
        expect(foregroundCalls).toBe(scenario.phase === "complete" ? 1 : 0);
        expect(captured.read().stderr).toContain("sameKeyReplayCommand");
      } finally {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  });

  test("reports Claude status without changing Codex account state", async () => {
    const { installation, runRoot } = await upgradeFixture("claude-account-status");
    const accountId = `acct_${"2".repeat(32)}` as const;
    const captured = capture();
    try {
      expect(await main([
        "account",
        "show",
        accountId,
        "--provider",
        "claude",
        "--json",
      ], captured.output, {
        installation,
        interactive: false,
        callDaemon: async (command) => {
          expect(command).toEqual({ account: accountId, kind: "account.show", provider: "claude" });
          return {
            data: {
              account: { id: accountId, label: "Work" },
              authentication: { provider: "claude", signedIn: false },
              nextCommand: `oompa account login ${accountId} --provider claude`,
              providerGeneration: 7,
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        runClaudeForegroundLogin: async () => {
          throw new Error("Status must not start login.");
        },
      })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toEqual({
        command: "account.show",
        data: {
          account: { id: accountId, label: "Work" },
          authentication: { provider: "claude", signedIn: false },
          nextCommand: `oompa account login ${accountId} --provider claude`,
          providerGeneration: 7,
        },
        ok: true,
        version: 1,
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test.each(["provider_default", "owner_manual"] as const)("short-circuits exact Claude recovery before runtime preflight with %s", async (browserMode) => {
    const { installation, runRoot } = await upgradeFixture("claude-account-recovery");
    const accountId = `acct_${"7".repeat(32)}` as const;
    const attemptId = `attempt_${"8".repeat(32)}` as const;
    const key = "00000000-0000-4000-8000-000000000314";
    const providerGeneration = 4;
    const abandonCommand = claudeAccountLoginAbandonCommand(
      accountId,
      attemptId,
      key,
      providerGeneration,
    );
    const captured = capture();
    const commands: LocalCommand[] = [];
    try {
      expect(await main([
        "account", "login", accountId, "--provider", "claude", "--idempotency-key", "00000000-0000-4000-8000-000000000399",
        ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        callDaemon: async (command) => {
          commands.push(command);
          return {
            data: {
              account: { id: accountId, label: "Recovery" },
              authentication: { provider: "claude", signedIn: null },
              providerGeneration: providerGeneration + 1,
              recovery: {
                required: true,
                attemptId,
                idempotencyKey: key,
                providerGeneration,
                statusCommand: `oompa account show ${accountId} --provider claude`,
                sameKeyReplayCommand: `oompa account login ${accountId} --provider claude --idempotency-key ${key}`,
                abandonCommand,
                diagnostic: "Credential presence does not prove that the original child exited.",
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        resolveClaudeRuntime: async () => { throw new Error("recovery must preclude runtime preflight"); },
        runClaudeForegroundLogin: async () => { throw new Error("recovery must preclude child launch"); },
      })).toBe(7);
      expect(commands).toEqual([{ account: accountId, kind: "account.show", provider: "claude" }]);
      expect(captured.read().stderr).toContain(abandonCommand);
      expect(captured.read().stderr).toContain(claudeAccountLoginCommand(accountId, key, browserMode));
      expect(captured.read().stderr).not.toContain("00000000-0000-4000-8000-000000000399");
      expect(captured.read().stderr).not.toContain("Close all prior private");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("rejects widened Claude account status before runtime preflight", async () => {
    const { installation, runRoot } = await upgradeFixture("claude-account-status-widened");
    const accountId = `acct_${"8".repeat(32)}` as const;
    const captured = capture();
    let runtimePreflights = 0;
    try {
      expect(await main([
        "account", "login", accountId, "--provider", "claude",
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        callDaemon: async () => ({
          data: {
            account: { id: accountId, label: "Strict", state: "signed_out" },
            authentication: { provider: "claude", signedIn: false },
            providerGeneration: 0,
          },
          ok: true as const,
          requestId: crypto.randomUUID(),
          version: 1 as const,
        }),
        resolveClaudeRuntime: async () => { runtimePreflights += 1; return cliClaudeRuntime; },
      })).toBe(1);
      expect(runtimePreflights).toBe(0);
      expect(captured.read().stderr).toContain("could not complete the request safely");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test.each([true, false])("reports unverified Claude status as unavailable without requesting or launching login (next command: %s)", async (includeNextCommand) => {
    const { installation, runRoot } = await upgradeFixture("claude-account-status-unknown");
    const accountId = `acct_${"9".repeat(32)}` as const;
    const captured = capture();
    let runtimePreflights = 0;
    let foregroundCalls = 0;
    const commands: LocalCommand[] = [];
    try {
      expect(await main([
        "account", "login", accountId, "--provider", "claude",
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        callDaemon: async (command) => {
          commands.push(command);
          return {
            data: {
              account: { id: accountId, label: "Unknown" },
              authentication: { provider: "claude", signedIn: null },
              ...(includeNextCommand ? { nextCommand: `oompa account login ${accountId} --provider claude` } : {}),
              providerGeneration: 0,
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        resolveClaudeRuntime: async () => { runtimePreflights += 1; return cliClaudeRuntime; },
        runClaudeForegroundLogin: async () => {
          foregroundCalls += 1;
          return { state: "joined", exitCode: 0, interruptedBy: null };
        },
      })).toBe(5);
      expect(commands).toEqual([{ account: accountId, kind: "account.show", provider: "claude" }]);
      expect(runtimePreflights).toBe(0);
      expect(foregroundCalls).toBe(0);
      expect(captured.read().stdout).toBe("");
      expect(captured.read().stderr).toContain("Claude authentication status could not be verified");
      expect(captured.read().stderr).toContain(`oompa account show ${accountId} --provider claude`);
      expect(captured.read().stderr).not.toContain("signed out");
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("fails path and pinned-runtime preflight before requesting a Claude launch grant", async () => {
    for (const failure of ["path", "pin"] as const) {
      const { installation, runRoot } = await upgradeFixture(`claude-preflight-${failure}`);
      const accountId = `acct_${failure === "path" ? "3".repeat(32) : "4".repeat(32)}` as const;
      const commands: LocalCommand[] = [];
      try {
        if (failure === "path") {
          await mkdir(installation.paths.profiles, { recursive: true });
          await writeFile(join(installation.paths.profiles, accountId), "not a directory");
        }
        const captured = capture();
        expect(await main([
          "account", "login", accountId, "--provider", "claude",
        ], captured.output, {
          installation,
          interactive: true,
          isTerminalDescriptor: () => true,
          callDaemon: async (command) => {
            commands.push(command);
            return {
              data: {
                account: { id: accountId, label: "Preflight" },
                authentication: { provider: "claude", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider claude`,
                providerGeneration: 0,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          },
          resolveClaudeRuntime: async () => {
            if (failure === "pin") throw new ClaudeError("RUNTIME_MISMATCH", "wrong pin");
            return cliClaudeRuntime;
          },
        })).not.toBe(0);
        expect(commands).toEqual([{ account: accountId, kind: "account.show", provider: "claude" }]);
      } finally {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  });

  test("settles no-effect when the private Claude directory is swapped after prepare", async () => {
    const { installation, runRoot } = await upgradeFixture("claude-post-prepare-path-swap");
    const accountId = `acct_${"c".repeat(32)}` as const;
    const attemptId = `attempt_${"d".repeat(32)}` as const;
    const key = "00000000-0000-4000-8000-000000000318";
    const configDir = join(installation.paths.profiles, accountId, "claude-config");
    const replacement = join(runRoot, "replacement-claude-config");
    const commands: LocalCommand[] = [];
    let foregroundCalls = 0;
    const captured = capture();
    try {
      expect(await main([
        "account", "login", accountId, "--provider", "claude", "--idempotency-key", key,
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        resolveClaudeRuntime: async () => cliClaudeRuntime,
        runClaudeForegroundLogin: async () => {
          foregroundCalls += 1;
          return { state: "joined", exitCode: 0, interruptedBy: null };
        },
        callDaemon: async (command) => {
          commands.push(command);
          if (command.kind === "account.show") return {
            data: {
              account: { id: accountId, label: "Path swap" },
              authentication: { provider: "claude", signedIn: false },
              nextCommand: `oompa account login ${accountId} --provider claude`,
              providerGeneration: 3,
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
          if (command.kind === "account.claude-login.prepare") {
            await mkdir(replacement, { mode: 0o700 });
            await rm(configDir, { force: true, recursive: true });
            await symlink(replacement, configDir);
            return {
              data: {
                account: { id: accountId, label: "Path swap" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "launch_granted", attemptId, idempotencyKey: key, providerGeneration: 3 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          return {
            data: {
              account: { id: accountId, label: "Path swap" },
              authentication: { provider: "claude", signedIn: false },
              login: { status: "signed_out", attemptId, idempotencyKey: key, providerGeneration: 3 },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
      })).toBe(6);
      expect(foregroundCalls).toBe(0);
      expect(commands.at(-1)).toMatchObject({
        kind: "account.claude-login.complete",
        outcome: { state: "not_started", reason: "preflight_stale" },
      });
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("revalidates the exact Claude executable after the launch grant before spawn", async () => {
    const { installation, runRoot } = await upgradeFixture("claude-post-grant-runtime-swap");
    const accountId = `acct_${"e".repeat(32)}` as const;
    const attemptId = `attempt_${"f".repeat(32)}` as const;
    const key = "00000000-0000-4000-8000-000000000319";
    const commands: LocalCommand[] = [];
    let runtimeChecks = 0;
    let foregroundCalls = 0;
    const captured = capture();
    try {
      expect(await main([
        "account", "login", accountId, "--provider", "claude", "--idempotency-key", key,
      ], captured.output, {
        installation,
        interactive: true,
        isTerminalDescriptor: () => true,
        resolveClaudeRuntime: async () => {
          runtimeChecks += 1;
          if (runtimeChecks === 2) {
            throw new ClaudeError("RUNTIME_MISMATCH", "Claude executable changed");
          }
          return cliClaudeRuntime;
        },
        runClaudeForegroundLogin: async () => {
          foregroundCalls += 1;
          return { state: "joined", exitCode: 0, interruptedBy: null };
        },
        callDaemon: async (command) => {
          commands.push(command);
          if (command.kind === "account.show") return {
            data: {
              account: { id: accountId, label: "Runtime swap" },
              authentication: { provider: "claude", signedIn: false },
              nextCommand: `oompa account login ${accountId} --provider claude`,
              providerGeneration: 4,
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
          if (command.kind === "account.claude-login.prepare") return {
            data: {
              account: { id: accountId, label: "Runtime swap" },
              authentication: { provider: "claude", signedIn: false },
              login: {
                status: "launch_granted",
                attemptId,
                idempotencyKey: key,
                providerGeneration: 4,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
          return {
            data: {
              account: { id: accountId, label: "Runtime swap" },
              authentication: { provider: "claude", signedIn: false },
              login: {
                status: "signed_out",
                attemptId,
                idempotencyKey: key,
                providerGeneration: 4,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
      })).toBe(6);
      expect(runtimeChecks).toBe(2);
      expect(foregroundCalls).toBe(0);
      expect(commands.at(-1)).toMatchObject({
        kind: "account.claude-login.complete",
        outcome: { state: "not_started", reason: "preflight_stale" },
      });
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test.each(["provider_default", "owner_manual"] as const)("completes typed spawn failure or retains exact Claude recovery with %s", async (browserMode) => {
    for (const mode of ["spawn", "timeout", "protocol", "unjoined"] as const) {
      const completionFailure = mode !== "spawn";
      const { installation, runRoot } = await upgradeFixture(`claude-complete-${mode}`);
      const digit = mode === "spawn" ? "6" : mode === "timeout" ? "5" : "9";
      const accountId = `acct_${digit.repeat(32)}` as const;
      const attemptId = `attempt_${digit.repeat(32)}` as const;
      const key = mode === "spawn"
        ? "00000000-0000-4000-8000-000000000312"
        : mode === "timeout"
          ? "00000000-0000-4000-8000-000000000311"
          : "00000000-0000-4000-8000-000000000313";
      const commands: LocalCommand[] = [];
      const captured = capture();
      try {
        const exit = await main([
          "account", "login", accountId, "--provider", "claude", "--idempotency-key", key,
          ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
        ], captured.output, {
          installation,
          interactive: true,
          isTerminalDescriptor: () => true,
          resolveClaudeRuntime: async () => cliClaudeRuntime,
          runClaudeForegroundLogin: async ({ browserMode: launchMode }) => {
            expect(launchMode).toBe(browserMode);
            if (mode === "unjoined") throw new ClaudeError("TIMEOUT", "Native child exit remains unproved.");
            return completionFailure
              ? { state: "joined", exitCode: 0, interruptedBy: null }
              : { state: "not_started", reason: "spawn_failed" };
          },
          callDaemon: async (command) => {
            commands.push(command);
            if (command.kind === "account.show") return {
              data: {
                account: { id: accountId, label: "Complete" },
                authentication: { provider: "claude", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider claude`,
                providerGeneration: 2,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            if (command.kind === "account.claude-login.prepare") return {
              data: {
                account: { id: accountId, label: "Complete" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "launch_granted", attemptId, idempotencyKey: key, providerGeneration: 2 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            if (completionFailure) return {
              error: {
                code: "UNAVAILABLE" as const,
                message: mode === "timeout" ? "status timed out" : "status protocol error",
              },
              ok: false as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            return {
              data: {
                account: { id: accountId, label: "Complete" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "signed_out", attemptId, idempotencyKey: key, providerGeneration: 2 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          },
        });
        if (mode === "unjoined") {
          expect(commands.map((command) => command.kind)).toEqual(["account.show", "account.claude-login.prepare"]);
          expect(captured.read().stdout).not.toContain("is signed in");
        } else {
          expect(commands.at(-1)).toMatchObject({
            kind: "account.claude-login.complete",
            outcome: completionFailure
              ? { state: "joined", exitCode: 0, interruptedBy: null }
              : { state: "not_started", reason: "spawn_failed" },
          });
        }
        expect(captured.read().stderr).toContain(claudeAccountLoginCommand(accountId, completionFailure ? key : undefined, browserMode));
        if (completionFailure) {
          expect(exit).toBe(7);
          expect(JSON.stringify(captured.read())).toContain(attemptId);
          expect(JSON.stringify(captured.read())).toContain(key);
          expect(JSON.stringify(captured.read())).toContain("sameKeyReplayCommand");
          expect(JSON.stringify(captured.read())).toContain("abandonCommand");
        } else {
          expect(exit).toBe(6);
          expect(captured.read().stderr).toContain("finished without an authenticated session");
        }
      } finally {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  });

  test.each(["provider_default", "owner_manual"] as const)("holds Claude terminal-signal custody across prepare and completion with %s", async (browserMode) => {
    for (const phase of ["during_prepare", "during_completion"] as const) {
      const { installation, runRoot } = await upgradeFixture(`claude-grant-signal-${phase}`);
      const digit = phase === "during_prepare" ? "1" : "2";
      const accountId = `acct_${digit.repeat(32)}` as const;
      const attemptId = `attempt_${digit.repeat(32)}` as const;
      const key = phase === "during_prepare"
        ? "00000000-0000-4000-8000-000000000319"
        : "00000000-0000-4000-8000-000000000320";
      const interruptedBy = phase === "during_prepare" ? "SIGINT" : "SIGTERM";
      const signalSource = new CliClaudeLoginSignalSource();
      let foregroundCalls = 0;
      let completed: LocalCommand | undefined;
      const captured = capture();
      try {
        const exit = await main([
          "account", "login", accountId, "--provider", "claude", "--idempotency-key", key,
          ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
        ], captured.output, {
          installation,
          interactive: true,
          isTerminalDescriptor: () => true,
          claudeLoginSignalSource: signalSource,
          resolveClaudeRuntime: async () => cliClaudeRuntime,
          runClaudeForegroundLogin: async ({ browserMode: launchMode }) => {
            expect(launchMode).toBe(browserMode);
            foregroundCalls += 1;
            return { state: "joined", exitCode: 0, interruptedBy: null };
          },
          callDaemon: async (command) => {
            if (command.kind === "account.show") return {
              data: {
                account: { id: accountId, label: "Signal custody" },
                authentication: { provider: "claude", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider claude`,
                providerGeneration: 4,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            if (command.kind === "account.claude-login.prepare") {
              if (phase === "during_prepare") signalSource.emit(interruptedBy);
              return {
                data: {
                  account: { id: accountId, label: "Signal custody" },
                  authentication: { provider: "claude", signedIn: false },
                  login: { status: "launch_granted", attemptId, idempotencyKey: key, providerGeneration: 4 },
                },
                ok: true as const,
                requestId: crypto.randomUUID(),
                version: 1 as const,
              };
            }
            completed = command;
            if (phase === "during_completion") signalSource.emit(interruptedBy);
            return {
              data: {
                account: { id: accountId, label: "Signal custody" },
                authentication: { provider: "claude", signedIn: phase === "during_completion" },
                login: {
                  status: phase === "during_completion" ? "signed_in" : "signed_out",
                  attemptId,
                  idempotencyKey: key,
                  providerGeneration: 4,
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          },
        });
        expect(exit).toBe(interruptedBy === "SIGINT" ? 130 : 143);
        expect(foregroundCalls).toBe(phase === "during_prepare" ? 0 : 1);
        expect(completed).toMatchObject({
          kind: "account.claude-login.complete",
          outcome: phase === "during_prepare"
            ? { state: "not_started", reason: "interrupted_before_spawn", interruptedBy }
            : { state: "joined", exitCode: 0, interruptedBy: null },
        });
        expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
        expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
      } finally {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  });

  test("completes interruption-before-spawn and preserves shell signal exit status", async () => {
    for (const interruptedBy of ["SIGINT", "SIGTERM"] as const) {
      const { installation, runRoot } = await upgradeFixture(`claude-before-spawn-${interruptedBy}`);
      const digit = interruptedBy === "SIGINT" ? "a" : "b";
      const accountId = `acct_${digit.repeat(32)}` as const;
      const attemptId = `attempt_${digit.repeat(32)}` as const;
      const key = interruptedBy === "SIGINT"
        ? "00000000-0000-4000-8000-000000000315"
        : "00000000-0000-4000-8000-000000000316";
      const captured = capture();
      let completed: LocalCommand | undefined;
      try {
        const exit = await main([
          "account", "login", accountId, "--provider", "claude", "--idempotency-key", key,
        ], captured.output, {
          installation,
          interactive: true,
          isTerminalDescriptor: () => true,
          resolveClaudeRuntime: async () => cliClaudeRuntime,
          runClaudeForegroundLogin: async () => ({
            state: "not_started",
            reason: "interrupted_before_spawn",
            interruptedBy,
          }),
          callDaemon: async (command) => {
            if (command.kind === "account.show") return {
              data: {
                account: { id: accountId, label: "Interrupted" },
                authentication: { provider: "claude", signedIn: false },
                nextCommand: `oompa account login ${accountId} --provider claude`,
                providerGeneration: 2,
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            if (command.kind === "account.claude-login.prepare") return {
              data: {
                account: { id: accountId, label: "Interrupted" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "launch_granted", attemptId, idempotencyKey: key, providerGeneration: 2 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
            completed = command;
            return {
              data: {
                account: { id: accountId, label: "Interrupted" },
                authentication: { provider: "claude", signedIn: false },
                login: { status: "signed_out", attemptId, idempotencyKey: key, providerGeneration: 2 },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          },
        });
        expect(exit).toBe(interruptedBy === "SIGINT" ? 130 : 143);
        expect(completed).toMatchObject({
          kind: "account.claude-login.complete",
          outcome: { state: "not_started", reason: "interrupted_before_spawn", interruptedBy },
        });
        expect(captured.read().stderr).toContain("Claude login was canceled");
      } finally {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  });

  test.each(["provider_default", "owner_manual"] as const)("refuses non-terminal Claude login before auth with %s", async (browserMode) => {
    const captured = capture();
    let providerCalls = 0;
    expect(await main([
      "account",
      "login",
      "Personal",
      "--provider",
      "claude",
      ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
      "--json",
    ], captured.output, {
      interactive: false,
      callDaemon: () => { throw new Error("Account authority must not be read."); },
      runClaudeForegroundLogin: async () => {
        providerCalls += 1;
        return { state: "joined", exitCode: 0, interruptedBy: null };
      },
    })).toBe(6);
    expect(providerCalls).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      error: {
        code: "INTERACTION_REQUIRED",
        details: { nextCommand: expect.stringMatching(new RegExp(`^oompa account login Personal --provider claude${browserMode === "owner_manual" ? " --manual-browser" : ""} --idempotency-key [0-9a-f-]{36}$`, "u")) },
      },
      ok: false,
    });
    expect(captured.read().stderr).toBe("");
  });

  test("reports recovery without leaking or claiming success when the held login file is rebound", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "oompa-cli-login-rebound-"));
    const handoff = join(root, "login.json");
    const moved = join(root, "held-login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const accountId = `acct_${"1".repeat(32)}`;
    const idempotencyKey = "00000000-0000-4000-8000-000000000102";
    const secretCode = "ABCD-EFGH";
    const secretUrl = "https://example.test/device?secret=rebound";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "Personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ], captured.output, {
        callDaemon: async (command) => {
          if (command.kind === "account.list") {
            return {
              data: {
                accounts: [{
                  id: accountId,
                  label: "Personal",
                  processGeneration: 0,
                  state: "signed_out",
                  updatedAt: 0,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            };
          }
          if (command.kind !== "account.login") throw new Error("Expected exact login dispatch.");
          await rename(handoff, moved);
          await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
          return {
            data: {
              account: {
                id: accountId,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey,
              login: {
                loginId: "provider-login",
                next: `oompa account login-cancel ${accountId}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          };
        },
        interactive: false,
      })).toBe(7);
      const rendered = captured.read();
      expect(rendered.stderr).toBe("");
      expect(rendered.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(rendered.stdout)).toMatchObject({
        error: {
          code: "RECOVERY_REQUIRED",
          details: {
            cancelCommand: `oompa account login-cancel ${accountId}`,
            idempotencyKey,
          },
        },
        ok: false,
      });
      expect(JSON.stringify(rendered)).not.toContain(secretCode);
      expect(JSON.stringify(rendered)).not.toContain("secret=rebound");
      expect(await readFile(handoff, "utf8")).toBe("");
      expect(await readFile(moved, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("never claims or rewrites a one-time handoff on same-key replay", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "oompa-cli-login-replay-"));
    const handoff = join(root, "login.json");
    await chmod(root, 0o700);
    await writeFile(handoff, "", { flag: "wx", mode: 0o600 });
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    const captured = capture();
    try {
      expect(await main([
        "account",
        "login",
        "personal",
        "--device-code",
        "--handoff-file",
        handoff,
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ], captured.output, {
        callDaemon: (command) => Promise.resolve(command.kind === "account.list"
          ? {
              data: {
                accounts: [{
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 1,
                  state: "login_pending",
                  updatedAt: 1,
                }],
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            }
          : {
              data: {
                account: {
                  id: `acct_${"1".repeat(32)}`,
                  label: "Personal",
                  processGeneration: 1,
                  state: "login_pending",
                  updatedAt: 1,
                },
                idempotencyKey,
                login: {
                  loginId: "provider-login",
                  next: `oompa account login-cancel acct_${"1".repeat(32)}`,
                  status: "pending",
                },
              },
              ok: true as const,
              requestId: crypto.randomUUID(),
              version: 1 as const,
            },
        ),
        interactive: false,
      })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: { login: { handoff: { status: "unavailable_on_replay" } } },
      });
      expect(await readFile(handoff, "utf8")).toBe("");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("limits raw login instructions to the dedicated foreground terminal renderer", async () => {
    const captured = capture();
    const secretCode = "FOREGROUND-ONLY-CODE";
    const secretUrl = "https://example.test/device?secret=foreground-only";
    expect(await main([
      "account",
      "login",
      "personal",
      "--device-code",
    ], captured.output, {
      callDaemon: (command) => Promise.resolve(command.kind === "account.list"
        ? {
            data: {
              accounts: [{
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 0,
                state: "signed_out",
                updatedAt: 0,
              }],
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          }
        : {
            data: {
              account: {
                id: `acct_${"1".repeat(32)}`,
                label: "Personal",
                processGeneration: 1,
                state: "login_pending",
                updatedAt: 1,
              },
              idempotencyKey: "idempotencyKey" in command ? command.idempotencyKey : "",
              login: {
                loginId: "provider-login",
                next: `oompa account login-cancel acct_${"1".repeat(32)}`,
                status: "pending",
                userCode: secretCode,
                verificationUrl: secretUrl,
              },
            },
            ok: true as const,
            requestId: crypto.randomUUID(),
            version: 1 as const,
          },
      ),
      interactive: true,
    })).toBe(0);
    expect(captured.read().stdout).not.toContain(secretCode);
    expect(captured.read().stdout).not.toContain("foreground-only");
    expect(captured.read().stderr).toContain(secretCode);
    expect(captured.read().stderr).toContain(secretUrl);
  });

  test("starts the persistent shell on no-argument interactive use and carries exact selections", async () => {
    const captured = capture();
    const lines = ["/account personal", "/session current", "hello from shell", "/exit"];
    const commands: LocalCommand[] = [];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => Promise.resolve(lines.shift() ?? null),
      callDaemon: (command) => {
        commands.push(command);
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: "acct_11111111111111111111111111111111" } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              session: {
                id: "sess_22222222222222222222222222222222",
                profileId: "acct_11111111111111111111111111111111",
              },
            },
          });
        }
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: crypto.randomUUID(),
          data: { sent: true },
        });
      },
    })).toBe(0);
    expect(commands[0]).toEqual({ kind: "daemon.status" });
    expect(commands[3]).toMatchObject({
      kind: "session.send",
      session: "sess_22222222222222222222222222222222",
      message: "hello from shell",
    });
    expect(captured.read().stderr).toContain("Oompa shell");
  });

  test("rejects malformed daemon selection identities without changing the shell prompt", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const lines = ["/account malformed", "/session malformed", "/exit"];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: `acct_${"x".repeat(4_096)}` } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 99,
              session: {
                id: `sess_${"2".repeat(32)}`,
                profileId: `acct_${"2".repeat(32)}`,
              },
            },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toEqual(["oompa> ", "oompa> ", "oompa> "]);
    expect(captured.read().stderr).toContain("Selected account response is invalid.");
    expect(captured.read().stderr).toContain("Selected session response is invalid.");
    expect(captured.read().stderr).not.toContain("x".repeat(128));
  });

  test("binds exact persistent-shell selectors to the exact returned identity", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const requestedAccount = `acct_${"1".repeat(32)}`;
    const foreignAccount = `acct_${"2".repeat(32)}`;
    const requestedSession = `sess_${"3".repeat(32)}`;
    const foreignSession = `sess_${"4".repeat(32)}`;
    const lines = [
      `/account ${requestedAccount}`,
      `/session ${requestedSession}`,
      "/exit",
    ];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: foreignAccount } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              session: { id: foreignSession, profileId: foreignAccount },
            },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toEqual(["oompa> ", "oompa> ", "oompa> "]);
    expect(captured.read().stderr).toContain(
      "Selected account response does not match the exact requested account.",
    );
    expect(captured.read().stderr).toContain(
      "Selected session response does not match the exact requested session.",
    );
    expect(captured.read().stderr).not.toContain("Selected account acct_");
    expect(captured.read().stderr).not.toContain("Selected session sess_");
  });

  test("rejects a selected session without its authoritative account identity", async () => {
    const captured = capture();
    const prompts: string[] = [];
    const lines = ["/account personal", "/session current", "/exit"];
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "account.show") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { account: { id: "acct_11111111111111111111111111111111" } },
          });
        }
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: { version: 1, session: { id: "sess_22222222222222222222222222222222" } },
          });
        }
        throw new Error(`Unexpected shell selection command: ${command.kind}`);
      },
    })).toBe(0);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toBe(prompts[2]);
    expect(prompts[1]).toContain("acct_111111111111111111111");
    expect(prompts[1]).not.toContain("sess_");
    expect(captured.read().stderr).toContain("Selected session account response is invalid.");
  });

  test("starts the daemon before the first shell prompt and leaves it running on exit", async () => {
    const captured = capture();
    const commands: LocalCommand[] = [];
    let readStarted = false;
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        readStarted = true;
        return Promise.resolve("/exit");
      },
      callDaemon: (command) => {
        expect(readStarted).toBe(false);
        commands.push(command);
        return Promise.resolve(runningDaemonResponse());
      },
    })).toBe(0);
    expect(commands).toEqual([{ kind: "daemon.status" }]);
    expect(captured.read().stderr).toContain("leaves the daemon running");
  });

  test("contains persistent-shell startup failures before opening a prompt", async () => {
    const captured = capture();
    let prompts = 0;
    expect(await main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        prompts += 1;
        return Promise.resolve("/exit");
      },
      callDaemon: () => Promise.reject(new Error("foreign startup detail")),
    })).toBe(1);
    expect(prompts).toBe(0);
    expect(captured.read().stderr).toContain("could not start or continue the shell safely");
    expect(captured.read().stderr).not.toContain("foreign startup detail");
  });

  test("surfaces selected-session updates while the human prompt is waiting and drains on exit", async () => {
    const captured = capture();
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const streamEpoch = "90000000-0000-4000-8000-000000000011";
    const turnId = `opaque_v2_${"1".repeat(64)}`;
    const itemId = `opaque_v2_${"2".repeat(64)}`;
    let releaseExit: (line: string | null) => void = () => undefined;
    const exitLine = new Promise<string | null>((resolve) => { releaseExit = resolve; });
    let readCount = 0;
    let eventReads = 0;
    const commands: LocalCommand[] = [];
    const shell = main([], captured.output, {
      interactive: true,
      readShellLine: () => {
        readCount += 1;
        return readCount === 1 ? Promise.resolve("/session current") : exitLine;
      },
      callDaemon: (command) => {
        commands.push(command);
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "session.status") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 2,
              session: {
                id: sessionId,
                accountId,
                projectId: null,
                title: "Current session",
                execution: "active",
                activeTurnId: turnId,
                revision: 4,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_001,
              },
              advisory: {
                execution: "active",
                attention: "human_action_required",
                queueDepth: 0,
              },
              localObservation: {
                source: "sqlite",
                coverage: "complete",
                freshness: "fresh",
                observedAt: 1_700_000_000_001,
              },
              providerObservation: {
                source: "codex_app_server",
                basis: "provider_read",
                coverage: "complete",
                freshness: "fresh",
                observedAt: 1_700_000_000_001,
                connectionId: "90000000-0000-4000-8000-000000000099",
                mode: "resubscribed",
                profileGeneration: 1,
                state: "live",
              },
              eventStream: {
                streamEpoch,
                floorSequence: 1,
                observedThroughSequence: 0,
                cursor: cursorWire("head-0"),
                retentionFloorCursor: cursorWire("floor"),
              },
              interactions: {
                pendingCount: 1,
                responseInFlightCount: 0,
                pending: [{
                  id: "70000000-0000-4000-8000-000000000011",
                  kind: "command_approval",
                  revision: 2,
                  blocking: true,
                  summary: "Run the release verification",
                  requestedAt: 1_700_000_000_000,
                  deadlineAt: 1_700_000_030_000,
                }],
                truncated: false,
              },
              queue: {
                depth: 0,
                dispatchingCount: 0,
                ambiguousCount: 0,
                failedCount: 0,
              },
            },
          });
        }
        if (command.kind === "session.interactions") {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: [{
                id: "70000000-0000-4000-8000-000000000011",
                sessionId,
                kind: "command_approval",
                state: "pending",
                revision: 2,
                blocking: true,
                display: { summary: "Run the release verification" },
              }],
              nextCursor: null,
            },
          });
        }
        if (command.kind === "session.events") {
          eventReads += 1;
          if (eventReads > 1) return new Promise<CommandResponse>(() => undefined);
          const base = {
            version: 1 as const,
            sessionId,
            streamEpoch,
            recordedAt: 1_700_000_000_000,
            accountId,
            providerGeneration: 1,
            providerConnectionId: null,
          };
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              version: 1,
              sessionId,
              requestedCursor: cursorWire("head-0"),
              retentionFloorCursor: cursorWire("floor"),
              observedThroughCursor: cursorWire("head-4"),
              nextCursor: cursorWire("head-4"),
              gap: null,
              events: [
                { ...base, sequence: 1, body: { type: "item_started" as const, turnId, itemId, itemKind: "assistant" } },
                { ...base, sequence: 2, body: { type: "assistant_delta" as const, turnId, itemId, text: "release " } },
                { ...base, sequence: 3, body: { type: "assistant_delta" as const, turnId, itemId, text: "is ready" } },
                { ...base, sequence: 4, body: { type: "turn_completed" as const, turnId, status: "completed" as const } },
              ],
            },
          });
        }
        throw new Error(`Unexpected shell command: ${command.kind}`);
      },
    });

    const deadline = Date.now() + 1_000;
    while (!captured.read().stderr.includes("release is ready")) {
      if (Date.now() >= deadline) throw new Error("Live update did not arrive while the prompt was blocked.");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(readCount).toBe(2);
    expect(captured.read().stderr).toContain("Interaction required: command approval");
    expect(captured.read().stderr.match(/Codex\n/gu)).toHaveLength(1);
    expect(captured.read().stderr).not.toContain("{\"version\"");

    releaseExit("/exit");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100));
    expect(await Promise.race([shell.then(() => "exited" as const), timeout])).toBe("exited");
    expect(await shell).toBe(0);
    expect(commands.some((command) => command.kind === "daemon.stop")).toBe(false);
  });

  test("gives foreground watch exclusive observer output and resumes from a fresh status cut", async () => {
    const captured = capture();
    const sessionId = `sess_${"2".repeat(32)}`;
    const accountId = `acct_${"1".repeat(32)}`;
    const streamEpoch = "90000000-0000-4000-8000-000000000012";
    const marker = "foreground ownership marker";
    const postWatchInteractionMarker = "post-watch pending ownership marker";
    const turnId = `opaque_v2_${"a".repeat(64)}`;
    const itemId = `opaque_v2_${"b".repeat(64)}`;
    let statusReads = 0;
    let interactionReads = 0;
    let backgroundEventReads = 0;
    let foregroundEventReads = 0;
    let resolveBackgroundBuffered: () => void = () => undefined;
    const backgroundBuffered = new Promise<void>((resolve) => {
      resolveBackgroundBuffered = resolve;
    });
    let resolveExit: (line: string) => void = () => undefined;
    const exitLine = new Promise<string>((resolve) => { resolveExit = resolve; });
    let lineRead = 0;
    const statusData = (
      cursor: string,
      observedThroughSequence: number,
      pendingCount = 0,
    ): unknown => ({
      version: 2,
      session: {
        id: sessionId,
        accountId,
        projectId: null,
        title: "Observer ownership",
        execution: "active",
        activeTurnId: null,
        revision: 1,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      },
      advisory: {
        execution: "active",
        attention: pendingCount > 0 ? "human_action_required" : "none",
        queueDepth: 0,
      },
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: 1_700_000_000_001,
      },
      providerObservation: {
        source: "codex_app_server",
        basis: "provider_read",
        state: "live",
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: 1,
        observedAt: 1_700_000_000_001,
        connectionId: "90000000-0000-4000-8000-000000000099",
        mode: "resubscribed",
      },
      eventStream: {
        streamEpoch,
        floorSequence: 1,
        observedThroughSequence,
        cursor: cursorWire(cursor),
        retentionFloorCursor: cursorWire("floor"),
      },
      interactions: {
        pendingCount,
        responseInFlightCount: 0,
        pending: pendingCount === 0 ? [] : [{
          id: "70000000-0000-4000-8000-000000000019",
          kind: "user_input",
          revision: 1,
          blocking: true,
          summary: "foreground pending ownership marker",
          requestedAt: 1_700_000_000_000,
          deadlineAt: 1_700_000_030_000,
        }],
        truncated: false,
      },
      queue: { depth: 0, dispatchingCount: 0, ambiguousCount: 0, failedCount: 0 },
    });
    const event = (sequence: number, body: Record<string, unknown>) => ({
      version: 1 as const,
      sessionId,
      streamEpoch,
      sequence,
      recordedAt: 1_700_000_000_000 + sequence,
      accountId,
      providerGeneration: 1,
      providerConnectionId: null,
      body,
    });
    const page = (
      requestedCursor: string | null,
      nextCursor: string,
      events: readonly unknown[],
    ): unknown => ({
      version: 1,
      sessionId,
      requestedCursor: requestedCursor === null
        ? null
        : cursorWire(requestedCursor),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire(nextCursor),
      nextCursor: cursorWire(nextCursor),
      gap: null,
      events,
    });
    const waitUntilAbort = (signal: AbortSignal | undefined): Promise<CommandResponse> =>
      new Promise<CommandResponse>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("Expected cancellable event observation."));
          return;
        }
        const abort = () => reject(signal.reason ?? new Error("Observation stopped."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });

    const shell = main([], captured.output, {
      interactive: true,
      sessionObserverSignalMode: "foreground_interrupt",
      readShellLine: async () => {
        lineRead += 1;
        if (lineRead === 1) return "/session current";
        if (lineRead === 2) {
          await backgroundBuffered;
          return "/watch";
        }
        if (lineRead === 3) return await exitLine;
        return null;
      },
      callDaemon: (command, signal) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind === "session.status") {
          statusReads += 1;
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: statusReads === 1
              ? statusData("background-0", 0)
              : statusData("foreground-3", 3, 1),
          });
        }
        if (command.kind === "session.interactions") {
          interactionReads += 1;
          const foregroundInteraction = {
            id: "70000000-0000-4000-8000-000000000019",
            sessionId,
            kind: "user_input" as const,
            state: "pending" as const,
            revision: 1,
            blocking: true,
            display: { summary: "foreground pending ownership marker" },
          };
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: {
              sessionId,
              interactions: interactionReads === 1
                ? []
                : interactionReads === 2
                  ? [foregroundInteraction]
                  : [
                      foregroundInteraction,
                      {
                        ...foregroundInteraction,
                        id: "70000000-0000-4000-8000-000000000020",
                        display: { summary: postWatchInteractionMarker },
                      },
                    ],
              nextCursor: null,
            },
          });
        }
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected observer ownership command: ${command.kind}`);
        }
        if (command.waitMs === 1_000) {
          backgroundEventReads += 1;
          if (backgroundEventReads === 1) {
            return Promise.resolve({
              ok: true,
              version: 1,
              requestId: crypto.randomUUID(),
              data: page("background-0", "background-2", [
                event(1, {
                  type: "item_started",
                  turnId,
                  itemId,
                  itemKind: "assistant",
                }),
                event(2, {
                  type: "assistant_delta",
                  turnId,
                  itemId,
                  text: marker,
                }),
              ]),
            });
          }
          if (backgroundEventReads === 2) resolveBackgroundBuffered();
          else resolveExit("/exit");
          return waitUntilAbort(signal);
        }
        foregroundEventReads += 1;
        if (foregroundEventReads === 1) {
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: page(null, "foreground-3", [
              event(1, {
                type: "item_started",
                turnId,
                itemId,
                itemKind: "assistant",
              }),
              event(2, {
                type: "assistant_delta",
                turnId,
                itemId,
                text: marker,
              }),
              event(3, {
                type: "turn_completed",
                turnId,
                status: "completed",
              }),
            ]),
          });
        }
        queueMicrotask(() => { process.emit("SIGINT"); });
        return waitUntilAbort(signal);
      },
    });

    expect(await shell).toBe(0);
    expect(statusReads).toBe(2);
    expect(interactionReads).toBe(3);
    expect(backgroundEventReads).toBe(3);
    expect(foregroundEventReads).toBe(2);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      new RegExp(marker, "gu"),
    )).toHaveLength(1);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      /foreground pending ownership marker/gu,
    )).toHaveLength(1);
    expect(`${captured.read().stdout}${captured.read().stderr}`.match(
      new RegExp(postWatchInteractionMarker, "gu"),
    )).toHaveLength(1);
  });

  test("cancels a persistent-shell event long poll with Ctrl-C and returns to the prompt", async () => {
    const captured = capture();
    const sessionId = `sess_${"3".repeat(32)}`;
    const lines = [`/session events ${sessionId} --wait-ms 30000`, "/exit"];
    const originalSigintListeners = process.listenerCount("SIGINT");
    let observedSignal: AbortSignal | undefined;
    let reads = 0;
    expect(await main([], captured.output, {
      interactive: true,
      sessionObserverSignalMode: "foreground_interrupt",
      readShellLine: () => {
        reads += 1;
        return Promise.resolve(lines.shift() ?? null);
      },
      callDaemon: (command, signal) => {
        if (command.kind === "daemon.status") return Promise.resolve(runningDaemonResponse());
        if (command.kind !== "session.events") {
          throw new Error(`Unexpected event cancellation command: ${command.kind}`);
        }
        observedSignal = signal;
        queueMicrotask(() => { process.emit("SIGINT"); });
        return new Promise<CommandResponse>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error("Event long poll did not receive cancellation authority."));
            return;
          }
          const abort = () => reject(signal.reason ?? new Error("Event read canceled."));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    })).toBe(0);
    expect(reads).toBe(2);
    expect(observedSignal?.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(originalSigintListeners);
    expect(captured.read().stderr).toContain("Oompa shell");
    expect(captured.read().stderr).not.toContain("could not start or continue");
  });

  test("keeps event and interaction cursor signatures stable across daemon restarts", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-cursor-custody-")));
    try {
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
      await initializeStatePaths(paths);
      const custody = new GenerationalSecretCustody(
        paths,
        new FileSecretBackend(join(paths.root, "test-secret-values")),
      );
      const first = await resolveSessionEventCursorCodec(custody);
      const cursor = first.encode({
        version: 1,
        sessionId: "sess_33333333333333333333333333333333",
        streamEpoch: crypto.randomUUID(),
        sequence: 17,
      });
      const reopened = await resolveSessionEventCursorCodec(custody);
      expect(reopened.decode(cursor)).toMatchObject({ sequence: 17 });
      const interactionCursor = first.encodeInteraction({
        version: 1,
        type: "interaction",
        scope: { type: "session", sessionId: "sess_33333333333333333333333333333333" },
        pending: true,
        requestedAt: 1_700_000_000_000,
        publicId: "76000000-0000-4000-8000-000000000001",
      });
      expect(reopened.decodeInteraction(interactionCursor, {
        scope: { type: "session", sessionId: "sess_33333333333333333333333333333333" },
        pending: true,
      })).toMatchObject({ publicId: "76000000-0000-4000-8000-000000000001" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("refuses to replace a lost cursor key after durable event authority exists", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-lost-cursor-key-")));
    try {
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
      await initializeStatePaths(paths);
      const custody = new GenerationalSecretCustody(
        paths,
        new FileSecretBackend(join(paths.root, "test-secret-values")),
      );
      const store = new StateStore(paths, { now: () => 1_000 });
      try {
        expect(store.canInitializeDaemonCursorAuthority()).toBe(true);
        const codec = await resolveSessionEventCursorCodec(custody);
        store.configurePublicProviderIdentifierProjector(
          (value) => codec.projectPublicProviderIdentifier(value),
        );
        const profile = store.createProfile("Lost cursor key");
        const session = store.createSession({
          profileId: profile.id,
          title: "Lost cursor key",
          preset: "high",
          fastEnabled: false,
        });
        store.appendSessionEvent({
          sessionId: session.id,
          accountId: profile.id,
          providerGeneration: profile.processGeneration,
          providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
          providerConnectionId: null,
          body: { type: "turn_started", turnId: "low-entropy-turn" },
        });
        expect(store.canInitializeDaemonCursorAuthority()).toBe(false);
        const authority = await custody.read("session-cursor-key");
        if (authority === null) throw new Error("Expected cursor authority.");
        expect(await custody.clearIfGeneration(
          "session-cursor-key",
          authority.generation,
        )).toBe(true);
        await expect(resolveSessionEventCursorCodec(custody, {
          allowInitialization: store.canInitializeDaemonCursorAuthority(),
        })).rejects.toThrow("Restore the original local secret");
        expect(await custody.read("session-cursor-key")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("remote commands remain explicit and offline when cloud is explicitly disabled", async () => {
    const previous = process.env.HRA_CONVEX_URL;
    process.env.HRA_CONVEX_URL = "";
    try {
      const captured = capture();
      expect(await main(["remote", "list", "--json"], captured.output)).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("disabled") },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      if (previous === undefined) delete process.env.HRA_CONVEX_URL;
      else process.env.HRA_CONVEX_URL = previous;
    }
  });

  test("remote deployment configuration failures stay static and actionable", async () => {
    const previous = process.env.HRA_CONVEX_URL;
    process.env.HRA_CONVEX_URL = "not a deployment URL";
    try {
      const captured = capture();
      expect(await main(["remote", "list", "--json"], captured.output)).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Cloud sync is unavailable because OOMPA_CONVEX_URL or its legacy alias HRA_CONVEX_URL is invalid.",
        },
      });
      expect(captured.read().stderr).toBe("");
    } finally {
      if (previous === undefined) delete process.env.HRA_CONVEX_URL;
      else process.env.HRA_CONVEX_URL = previous;
    }
  });

  test("daemon cloud selection keeps durable projection recovery admission while transport is absent", async () => {
    const affectedSession = `sess_${"1".repeat(32)}`;
    const unrelatedSession = `sess_${"2".repeat(32)}`;
    const recovery: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_cli_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId: "018bcfe5-6800-7000-8000-000000000891",
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000892",
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        provider: "codex",
        providerAccountId: `acct_${"1".repeat(32)}`,
        bindingGeneration: 1,
        processGeneration: 1,
        profileId: `acct_${"1".repeat(32)}`,
        providerUpdatedAt: 10,
        providerThreadId: "thread_cli_restart_12345678",
        sessionRevision: 1,
      },
      phase: "prepared",
      replacementCacheId: "cache_cli_replacement_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: affectedSession,
      sourceDevicePublicId: "device_cli_restart_12345678",
      sourceCacheId: "cache_cli_source_12345678",
      userPublicId: "user_cli_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [recovery],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();

    const control = selectDaemonCloudControl(
      null,
      new CloudDaemonJournalRecoveryBlocker(journal),
    );
    expect(await control.isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
    expect(await control.isCompactProjectionRecoveryUnsettled(unrelatedSession)).toBe(false);
    expect(() => control.recoverCompactProjection({
      acknowledgeGap: true,
      idempotencyKey: recovery.idempotencyKey,
      sessionPublicId: affectedSession,
      signal: new AbortController().signal,
    })).toThrow("not configured");
    expect(await control.isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
  });

  test("daemon startup reads a mismatched target's scoped journal without enabling transport", async () => {
    const raw = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(raw, {
      HRA_CONVEX_URL: "https://bound.convex.cloud",
    });
    if (authority === null) throw new Error("fixture authority is disabled");
    expect(authority.custodyMode).toBe("scoped");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(raw, authority);
    const unselected = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    await unselected.activateIdentity("user_cli_recovery_12345678");
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    const journal = new CustodyCloudDaemonJournal(identityCustody);
    const affectedSession = `sess_${"4".repeat(32)}`;
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [{
        authority: { bootGeneration: 1, bootId: "boot_cli_scoped_12345678", fence: 1 },
        baselineCompletedTurns: [],
        epochPublicId: "018bcfe5-6800-7000-8000-000000000893",
        expectedCompactStreamEpoch: 0,
        expectedHeadSequence: 400,
        expectedTailDigest: "d".repeat(64),
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000894",
        lineageCommitment: "e".repeat(64),
        localAuthority: {
          provider: "codex",
          providerAccountId: `acct_${"2".repeat(32)}`,
          bindingGeneration: 1,
          processGeneration: 1,
          profileId: `acct_${"2".repeat(32)}`,
          providerUpdatedAt: 10,
          providerThreadId: "thread_cli_scoped_12345678",
          sessionRevision: 1,
        },
        phase: "prepared",
        replacementCacheId: "cache_cli_scoped_replacement_12345678",
        requestDigest: "f".repeat(64),
        requestedAt: 1_700_000_000_000,
        sessionPublicId: affectedSession,
        sourceDevicePublicId: "device_cli_scoped_12345678",
        sourceCacheId: "cache_cli_scoped_source_12345678",
        userPublicId: "user_cli_recovery_12345678",
      }],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    expect(await raw.read("cloud-daemon-journal")).toBeNull();

    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "https://requested.convex.cloud" },
      secretCustody: raw,
    });
    expect(startup.deploymentAuthority).toBeNull();
    expect(startup.diagnostic)
      .toBe("Cloud sync is unavailable because this state root is bound to another deployment.");
    expect(startup.journal).not.toBeNull();
    expect(startup.identityNamespace).toBe(identityCustody.cacheNamespace);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(affectedSession)).toBe(true);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"5".repeat(32)}`)).toBe(false);
  });

  test("daemon startup fails projection recovery admission closed for corrupt authority", async () => {
    const raw = new MemoryCloudCustody();
    expect(await raw.compareAndSwap("cloud-deployment-authority", null, "corrupt"))
      .not.toBeNull();
    const startup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "https://requested.convex.cloud" },
      secretCustody: raw,
    });
    expect(startup.deploymentAuthority).toBeNull();
    expect(startup.journal).toBeNull();
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"6".repeat(32)}`)).toBe(true);
    expect(await startup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettledForProfile("profile_cli_corrupt_12345678"))
      .toBe(true);
    expect(await startup.projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries())
      .toEqual({ superseded: 0 });
    await expect(startup.projectionRecoveryBlocker
      .supersedeCompactProjectionRecoveryForProviderDeletion(`sess_${"6".repeat(32)}`))
      .rejects.toThrow("Cloud projection recovery custody requires recovery.");
  });

  test("daemon cloud degradation preserves recovery reads and one bounded binding diagnostic", async () => {
    const blocker = {
      isCompactProjectionRecoveryUnsettled: async () => true,
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    };
    const diagnostic = "Cloud sync is unavailable until OOMPA_CONVEX_URL (or legacy HRA_CONVEX_URL) explicitly selects the legacy deployment.";
    const control = selectDaemonCloudControl(null, blocker, diagnostic);
    expect(await control.status(new AbortController().signal)).toEqual({
      configured: false,
      diagnostic,
      signedIn: false,
      unavailability: "recovery_required",
    });
    expect(await control.isCompactProjectionRecoveryUnsettled("sess_33333333"))
      .toBe(true);
    expect(() => control.auth({ email: "reader@example.com", signal: new AbortController().signal }))
      .toThrow(diagnostic);
    expect(() => control.sync(new AbortController().signal)).toThrow(diagnostic);
    expect(() => control.listDevices(new AbortController().signal)).toThrow(diagnostic);
  });

  test.each(["legacy", "forward", "both"] as const)("marks an explicitly disabled cloud deployment as optional machine state with %s aliases", async (alias) => {
    const startup = await resolveDaemonCloudStartup({
      environment: {
        ...(alias === "forward" ? {} : { HRA_CONVEX_URL: "" }),
        ...(alias === "legacy" ? {} : { OOMPA_CONVEX_URL: "" }),
      },
      secretCustody: new MemoryCloudCustody(),
    });
    expect(startup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is disabled for this daemon. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      reenable: { kind: "use_hosted_default" },
      unavailability: "disabled",
    });
    const control = selectDaemonCloudControl(
      null,
      startup.projectionRecoveryBlocker,
      startup.diagnostic,
      startup.unavailability,
      () => Promise.resolve({
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000895",
          phase: "effect_started",
          sessionPublicId: `sess_${"7".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      }),
      startup.reenable,
    );
    expect(await control.status(new AbortController().signal)).toEqual({
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000895",
          phase: "effect_started",
          sessionPublicId: `sess_${"7".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    });
  });

  test.each(["legacy", "forward", "both"] as const)("preserves a self-managed binding when cloud transport is explicitly disabled with %s aliases", async (alias) => {
    const raw = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(raw, {
      HRA_CONVEX_URL: "https://self-managed.convex.cloud",
    });
    if (authority === null) throw new Error("Expected a deployment authority fixture.");

    const startup = await resolveDaemonCloudStartup({
      environment: {
        ...(alias === "forward" ? {} : { HRA_CONVEX_URL: "" }),
        ...(alias === "legacy" ? {} : { OOMPA_CONVEX_URL: "" }),
      },
      secretCustody: raw,
    });
    expect(startup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is disabled for this daemon. Restore this state root's bound deployment with OOMPA_CONVEX_URL, unset HRA_CONVEX_URL, and restart the daemon.",
      reenable: {
        deploymentUrl: "https://self-managed.convex.cloud",
        kind: "restore_bound_deployment",
      },
      unavailability: "disabled",
    });
  });

  test("overrides disabled mode when deployment or journal custody requires recovery", async () => {
    const corruptAuthority = new MemoryCloudCustody();
    expect(await corruptAuthority.compareAndSwap("cloud-deployment-authority", null, "corrupt"))
      .not.toBeNull();
    const authorityStartup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: corruptAuthority,
    });
    expect(authorityStartup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is unavailable because deployment custody requires recovery.",
      journal: null,
      unavailability: "recovery_required",
    });
    expect(authorityStartup).not.toHaveProperty("reenable");
    expect(await authorityStartup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"8".repeat(32)}`)).toBe(true);

    const corruptJournal = new MemoryCloudCustody();
    const authority = await cloudDeploymentAuthorityFromEnvironment(corruptJournal, {
      HRA_CONVEX_URL: "https://self-managed.convex.cloud",
    });
    if (authority === null) throw new Error("Expected a deployment authority fixture.");
    const deploymentCustody = new DeploymentScopedCloudSecretCustody(corruptJournal, authority);
    const unselected = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    await unselected.activateIdentity("user_cli_corrupt_journal_12345678");
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    expect(await identityCustody.compareAndSwap(
      "cloud-daemon-journal",
      null,
      "corrupt",
    )).not.toBeNull();
    const journalStartup = await resolveDaemonCloudStartup({
      environment: { HRA_CONVEX_URL: "" },
      secretCustody: corruptJournal,
    });
    expect(journalStartup).toMatchObject({
      deploymentAuthority: null,
      diagnostic: "Cloud sync is unavailable because local cloud custody requires recovery.",
      journal: null,
      unavailability: "recovery_required",
    });
    expect(journalStartup).not.toHaveProperty("reenable");
    expect(await journalStartup.projectionRecoveryBlocker
      .isCompactProjectionRecoveryUnsettled(`sess_${"9".repeat(32)}`)).toBe(true);
  });

  test("remote sessions render stable human and JSON output", () => {
    const human = capture();
    renderRemoteSuccess({ kind: "remote.list", limit: 50 }, {
      sessions: [{
        compactHeadSequence: 3,
        createdAt: 1,
        executionDevicePublicId: "device_12345678",
        metadata: { name: "Release", note: null },
        publicId: "session_12345678",
        state: "idle",
        updatedAt: 2,
      }],
      truncated: false,
    }, false, human.output);
    expect(human.read()).toEqual({
      stdout: "Release  idle\n  session_12345678  device device_12345678\n",
      stderr: "",
    });

    const json = capture();
    renderRemoteSuccess({ kind: "remote.stop", session: "session_12345678" }, {
      commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000001",
      kind: "stop",
      replay: false,
      sessionPublicId: "session_12345678",
      state: "pending",
      targetDevicePublicId: "device_12345678",
    }, true, json.output);
    expect(JSON.parse(json.read().stdout)).toMatchObject({
      ok: true,
      version: 1,
      command: "remote.stop",
      data: {
        commandPublicId: "018bcfe5-6800-7000-8000-000000000001",
        targetDevicePublicId: "device_12345678",
      },
    });
    expect(json.read().stderr).toBe("");
  });

  test("remote human output escapes paired-origin terminal controls", () => {
    const attack = "\u001b]52;c;owned\u0007\u202etxt";
    const human = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, {
      complete: true,
      createdAt: 1,
      events: [
        { kind: "assistant_message", sequence: 1, text: attack, turnId: "turn_12345678" },
        {
          blocking: true,
          interactionId: "70000000-0000-4000-8000-000000000001",
          interactionKind: "permission_approval",
          kind: "interaction_state",
          detailVersion: 2,
          remotePolicy: {
            actions: ["decline"],
            deadlineAt: Number.MAX_SAFE_INTEGER,
            questions: [],
            reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
            version: 1,
          },
          revision: 3,
          sequence: 2,
          state: "pending",
          summary: `Review ${attack}`,
        },
        {
          filesTouched: [`src/${attack}.ts`],
          gitActions: [{ kind: "status", label: attack }],
          kind: "turn_summary",
          runtimeMs: 1,
          sequence: 3,
          turnId: "turn_12345678",
        },
      ],
      executionDevicePublicId: "device_12345678",
      metadata: { name: attack, note: null },
      publicId: "session_12345678",
      state: "idle",
      updatedAt: 2,
    }, false, human.output);
    const rendered = human.read().stdout;
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).toContain("\\u{001b}");
    expect(rendered).toContain("\\u{0007}");
    expect(rendered).toContain("\\u{202e}");
    expect(rendered).toContain("Interaction 70000000-0000-4000-8000-000000000001  permission approval");
    expect(rendered).toContain("pending  revision 3  blocking");
    expect(rendered).toContain("Decline remotely with `oompa remote resolve");
    expect(rendered).toContain("--interaction 70000000-0000-4000-8000-000000000001 --revision 3 --decision decline");
    expect(rendered).not.toContain("--decision once");
    expect(rendered).not.toContain("cancel");
  });

  test("remote pending guidance fails closed to parsed policy and its deadline", () => {
    const human = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, {
      complete: true,
      createdAt: 1,
      events: [
        {
          blocking: true,
          interactionId: "70000000-0000-4000-8000-000000000002",
          interactionKind: "command_approval",
          kind: "interaction_state",
          revision: 1,
          sequence: 1,
          state: "pending",
          summary: "Legacy projection without remote authority",
        },
        {
          blocking: true,
          detailVersion: 2,
          interactionId: "70000000-0000-4000-8000-000000000003",
          interactionKind: "user_input",
          kind: "interaction_state",
          remotePolicy: {
            actions: ["answer"],
            deadlineAt: Number.MAX_SAFE_INTEGER,
            questions: [{
              allowsOther: false,
              header: "Region",
              id: "region",
              kind: "user_input",
              options: [{ description: "Primary", label: "East" }],
              question: "Which region?",
            }],
            reasonCodes: [],
            version: 2,
          },
          revision: 1,
          sequence: 2,
          state: "pending",
          summary: "Choose a region",
        },
        {
          blocking: true,
          detailVersion: 2,
          interactionId: "70000000-0000-4000-8000-000000000004",
          interactionKind: "permission_approval",
          kind: "interaction_state",
          remotePolicy: {
            actions: ["decline"],
            deadlineAt: 0,
            questions: [],
            reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
            version: 2,
          },
          revision: 1,
          sequence: 3,
          state: "pending",
          summary: "Expired permission request",
        },
      ],
      executionDevicePublicId: "device_12345678",
      metadata: { name: "Policy guidance", note: null },
      publicId: "session_12345678",
      state: "idle",
      updatedAt: 2,
    }, false, human.output);

    const rendered = human.read().stdout;
    expect(rendered).toContain("No remote action is available. Resolve this interaction on the execution device.");
    expect(rendered).toContain("Answer remotely in the Oompa app, or resolve this interaction on the execution device.");
    expect(rendered).toContain("The remote-action deadline has passed. Resolve this interaction on the execution device.");
    expect(rendered).not.toContain("oompa remote resolve");
    expect(rendered).not.toContain("cancel");
  });

  test("remote human output reduces recovered interactions to the safest latest revision", () => {
    const interactionId = "70000000-0000-4000-8000-000000000099";
    const data = {
      compactHasRecoveryGap: true,
      compactHeadSequence: 4,
      compactStreamEpoch: 4,
      complete: true,
      createdAt: 1,
      events: [
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 1,
          sequence: 1,
          state: "pending" as const,
          summary: "Interaction state updated",
        },
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 2,
          sequence: 2,
          state: "expired" as const,
          summary: "Interaction state updated",
        },
        {
          blocking: true,
          interactionId,
          interactionKind: "command_approval" as const,
          kind: "interaction_state" as const,
          revision: 2,
          sequence: 3,
          state: "pending" as const,
          summary: "Conflicting stale recovery row",
        },
        {
          blocking: true,
          interactionId: "70000000-0000-4000-8000-000000000100",
          interactionKind: "user_input" as const,
          kind: "interaction_state" as const,
          revision: 1,
          sequence: 4,
          state: "pending" as const,
          summary: "Pre-baseline pending state",
        },
      ],
      executionDevicePublicId: "device_12345678",
      metadata: { name: "Recovered", note: null },
      publicId: "session_12345678",
      recoveryGap: { kind: "projection_cache_recovery" as const, streamEpoch: 4 },
      state: "idle" as const,
      updatedAt: 2,
    };
    const human = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, data, false, human.output);
    const rendered = human.read().stdout;
    expect(rendered).toContain("Recovery gap: compact projection cache recovery at stream epoch 4.");
    expect(rendered.match(new RegExp(interactionId, "gu"))).toHaveLength(1);
    expect(rendered).toContain("expired  revision 2");
    expect(rendered).not.toContain("Resolve on the execution device");
    expect(rendered).toContain("Interaction action guidance is suppressed while remote recovery settles.");

    const json = capture();
    renderRemoteSuccess({ kind: "remote.show", session: "session_12345678" }, data, true, json.output);
    const payload = JSON.parse(json.read().stdout) as { data: { events: unknown[] } };
    expect(payload.data.events).toHaveLength(4);
  });

  test("stopping an absent daemon does not initialize or autostart it", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oompa-stop-"));
    const stateRoot = join(temporary, "Library", "Application Support", "Oompa");
    const previousHome = process.env.HOME;
    process.env.HOME = temporary;
    try {
      const captured = capture();
      expect(await main(["daemon", "stop", "--json"], captured.output)).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: { stopping: false, running: false },
      });
      await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("builds the exact detached daemon spawn descriptor inside the private state root", () => {
    expect(daemonRunProcessArguments("/opt/oompa/bun", "/opt/oompa/src/cli.ts")).toEqual([
      "/opt/oompa/bun",
      "--no-env-file",
      "/opt/oompa/src/cli.ts",
      "daemon",
      "run",
    ]);
    const environment = {
      AWS_SECRET_ACCESS_KEY: "parent-secret",
      HOME: "/Users/example",
      HRA_CONVEX_URL: "https://example.convex.cloud",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "parent-secret",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
      UNDEFINED_VALUE: undefined,
    };
    expect(daemonRunProcessOptions("/var/lib/hra-control-plane-v1", environment)).toEqual({
      cwd: "/var/lib/hra-control-plane-v1",
      detached: true,
      env: {
        HOME: "/Users/example",
        HRA_CONVEX_URL: "https://example.convex.cloud",
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/private/tmp",
      },
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
    const defaulted = daemonRunProcessOptions("/var/lib/hra-control-plane-v1");
    expect(Object.keys(defaulted.env).every((key) =>
      DAEMON_ENVIRONMENT_KEYS.has(key) || SAFE_ENVIRONMENT_KEYS.has(key))).toBe(true);
    expect(EDITOR_ENVIRONMENT_KEYS.has("TERM")).toBe(true);
    expect(allowlistedEnvironment(environment, EDITOR_ENVIRONMENT_KEYS)).toEqual({
      HOME: "/Users/example",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/tmp",
    });
  });

  test("detached daemon options preserve forward and identical aliases and reject raw disagreement", () => {
    for (const value of ["", " ", "https://forward.convex.cloud/"]) {
      for (const selected of [
        { OOMPA_CONVEX_URL: value }, { OOMPA_CONVEX_URL: value, HRA_CONVEX_URL: value },
      ]) {
        const environment = { HOME: "/example-home", ...selected, UNRELATED_VALUE: "not forwarded" };
        expect(daemonRunProcessOptions("/example-state", environment).env)
          .toEqual({ HOME: "/example-home", ...selected });
      }
    }
    let reads = 0;
    const options = daemonRunProcessOptions("/example-state", {
      get OOMPA_CONVEX_URL() { reads++; return reads === 1 ? "" : "changed"; },
      HRA_CONVEX_URL: "",
    });
    expect(reads).toBe(1);
    expect(options.env).toEqual({ OOMPA_CONVEX_URL: "", HRA_CONVEX_URL: "" });
    expect(() => daemonRunProcessOptions("/example-state", { OOMPA_CONVEX_URL: "", HRA_CONVEX_URL: " " }))
      .toThrow("must be byte-identical");
  });

  test("alias conflicts refuse cloud startup before its recovery-custody fallback", async () => {
    let calls = 0;
    const unexpected = async (): Promise<never> => { calls++; throw new Error("Unexpected recovery custody."); };
    await expect(resolveDaemonCloudStartup({
      environment: { OOMPA_CONVEX_URL: "https://first.convex.cloud", HRA_CONVEX_URL: "https://second.convex.cloud" },
      secretCustody: { read: unexpected, compareAndSwap: unexpected, clearIfGeneration: unexpected },
    })).rejects.toThrow("must be byte-identical");
    expect(calls).toBe(0);
  });

  test("alias conflicts refuse remote selection before constructing custody without exposing values", async () => {
    const original = createProductionInstallation();
    let calls = 0;
    const output = capture();
    expect(await main(["remote", "list", "--json"], output.output, {
      installation: {
        ...original,
        cloudEnvironment: { OOMPA_CONVEX_URL: "https://first.convex.cloud", HRA_CONVEX_URL: "https://second.convex.cloud" },
        createSecretCustody: () => { calls++; throw new Error("Unexpected cloud custody."); },
      },
    })).toBe(5);
    expect(JSON.parse(output.read().stdout)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "OOMPA_CONVEX_URL and HRA_CONVEX_URL must be byte-identical when both are set." },
    });
    expect(output.read().stdout).not.toContain("first.convex");
    expect(output.read().stdout).not.toContain("second.convex");
    expect(output.read().stderr).toBe("");
    expect(calls).toBe(0);
  });

  test.each(["explicit", "autostart", "direct"] as const)("alias conflicts refuse %s daemon startup before migration or spawn", async (path) => {
    const { installation: original, runRoot } = await upgradeFixture(`cloud-alias-${path}`);
    let starts = 0;
    let custody = 0;
    const installation = {
      ...original,
      cloudEnvironment: { OOMPA_CONVEX_URL: "https://first.convex.cloud", HRA_CONVEX_URL: "https://second.convex.cloud" },
      createSecretCustody: () => { custody++; throw new Error("Unexpected secret custody."); },
    };
    try {
      expect(await main(["init", "--yes", "--json"], capture().output, { installation })).toBe(0);
      installPrivateTask48State(installation.paths.database);
      const before = stateSchemaSnapshot(installation.paths.database);
      const bytes = await readFile(installation.paths.database);
      if (path === "direct") {
        await expect(runDaemon(installation)).rejects.toThrow("must be byte-identical");
      } else {
        const output = capture();
        const argv = path === "explicit" ? ["daemon", "start", "--json"] : ["session", "list", "--json"];
        expect(await main(argv, output.output, {
          installation,
          startDaemon: async () => { starts++; return readyDaemonStatus(); },
        })).toBe(5);
        expect(JSON.parse(output.read().stdout)).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: "OOMPA_CONVEX_URL and HRA_CONVEX_URL must be byte-identical when both are set." },
        });
        expect(output.read().stdout).not.toContain("first.convex");
        expect(output.read().stdout).not.toContain("second.convex");
        expect(output.read().stderr).toBe("");
      }
      expect(starts).toBe(0);
      expect(custody).toBe(0);
      expect(stateSchemaVersion(installation.paths.database)).toBe(48);
      expect(stateSchemaSnapshot(installation.paths.database)).toBe(before);
      expect(await readFile(installation.paths.database)).toEqual(bytes);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("alias conflicts leave help, version, local diagnosis, stop, and existing-daemon dispatch available", async () => {
    const { installation: original, runRoot } = await upgradeFixture("cloud-alias-local-controls");
    const installation = {
      ...original,
      cloudEnvironment: { OOMPA_CONVEX_URL: "https://first.convex.cloud", HRA_CONVEX_URL: "https://second.convex.cloud" },
    };
    try {
      for (const argv of [["--help"], ["--version"], ["daemon", "stop", "--json"]]) {
        expect(await main(argv, capture().output, { installation })).toBe(0);
      }
      await expect(lstat(installation.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await main(["init", "--yes", "--json"], capture().output, { installation })).toBe(0);
      const before = stateSchemaSnapshot(installation.paths.database);
      expect(await main(["status", "--json"], capture().output, { installation })).toBe(0);
      const doctor = capture();
      await main(["doctor", "--offline", "--json"], doctor.output, { installation });
      expect(doctor.read().stdout).not.toContain("must be byte-identical");
      let dispatched = 0;
      expect(await main(["session", "list", "--json"], capture().output, {
        installation,
        callDaemon: async () => { dispatched++; return { ok: false, error: { code: "UNAVAILABLE", message: "Existing daemon fixture." }, requestId: crypto.randomUUID(), version: 1 }; },
      })).toBe(5);
      expect(dispatched).toBe(1);
      expect(stateSchemaSnapshot(installation.paths.database)).toBe(before);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("latches an already-aborted daemon stop until lifecycle delivery is installed", async () => {
    const { installation, runRoot } = await upgradeFixture("daemon-stop-latched-before-lifecycle");
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, { installation })).toBe(0);
      await mkdir(installation.paths.socket, { mode: 0o700 });
      const before = await readDaemonAuthorityReceipt(installation.paths);
      expect(before?.state).toBe("stopped");

      const controller = new AbortController();
      controller.abort(new Error("Stop before daemon lifecycle delivery exists."));

      expect(await runDaemon(installation, { stopSignal: controller.signal })).toBe(0);
      const after = await readDaemonAuthorityReceipt(installation.paths);
      expect(after).toMatchObject({ state: "stopped" });
      expect(after?.nonce).not.toBe(before?.nonce);
      expect(after?.generation).toBeUndefined();
      expect((await lstat(installation.paths.socket)).isDirectory()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("rejects the canonical-memory fault decorator outside live acceptance before effects", async () => {
    const installation = createProductionInstallation();
    let decorated = false;
    await expect(runDaemon(installation, {
      liveAcceptanceCanonicalMemoryTransportDecorator: (transport) => {
        decorated = true;
        return transport;
      },
    })).rejects.toThrow("restricted to live acceptance");
    expect(decorated).toBeFalse();
  });

  test("rejects the Claude proof collector outside live acceptance before effects", async () => {
    const installation = createProductionInstallation();
    let invoked = false;
    await expect(runDaemon(installation, {
      liveAcceptanceClaudeProof: {
        beginDaemonGeneration: () => { invoked = true; },
        closeDaemonGeneration: () => { invoked = true; },
        handleManagedHostToolCall: async () => {
          invoked = true;
          return {};
        },
        handleManagedHostToolResponseWritten: () => { invoked = true; },
      },
    })).rejects.toThrow("Daemon acceptance hooks are restricted to live acceptance.");
    expect(invoked).toBeFalse();
  });

  test("rejects the personal Claude restart proof outside live acceptance before effects", async () => {
    const installation = createProductionInstallation();
    let invoked = false;
    const touched = () => { invoked = true; };
    await expect(runDaemon(installation, {
      liveAcceptancePersonalClaudeProof: {
        executablePath: "/fixture/never-executed-claude",
        environment: {},
        beginDaemonGeneration: touched,
        assertRuntimeRequest: touched,
        runtimeAdmitted: touched,
        runtimeFailed: touched,
        prepareLaunch: () => { touched(); throw new Error("No process launch is admitted."); },
        observeWrites: () => { touched(); return { userWriteAttempts: 0, acceptedUserWrites: 0, acknowledgmentWithheld: false }; },
        closeAdmission: touched,
        closeDaemonGeneration: async () => { touched(); },
      },
    })).rejects.toThrow("Daemon acceptance hooks are restricted to live acceptance.");
    expect(invoked).toBeFalse();
  });

  test("delivers an abort during early daemon boot before transport exists", async () => {
    const { installation: baseInstallation, runRoot } = await upgradeFixture("daemon-stop-during-early-boot");
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, {
        installation: baseInstallation,
      })).toBe(0);
      await mkdir(baseInstallation.paths.socket, { mode: 0o700 });

      const controller = new AbortController();
      let secretCustodyCreations = 0;
      const installation = {
        ...baseInstallation,
        createSecretCustody: () => {
          secretCustodyCreations += 1;
          controller.abort(new Error("Stop during early daemon boot."));
          return baseInstallation.createSecretCustody();
        },
      };

      expect(await runDaemon(installation, { stopSignal: controller.signal })).toBe(0);
      expect(secretCustodyCreations).toBe(1);
      expect(await readDaemonAuthorityReceipt(installation.paths)).toMatchObject({ state: "stopped" });
      expect((await lstat(installation.paths.socket)).isDirectory()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("daemon start renders the starter's verified identity without a second status request", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4d";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-daemon-start"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-daemon-start"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);

      const started = capture();
      expect(await main(["daemon", "start", "--json"], started.output, input)).toBe(0);
      expect(JSON.parse(started.read().stdout)).toEqual({
        command: "daemon.status",
        data: readyDaemonStatus(),
        ok: true,
        version: 1,
      });
      expect(started.read().stderr).toBe("");
      expect(daemonStarts).toBe(1);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("daemon start migrates local state left at an older schema version", async () => {
    const { installation, runRoot } = await upgradeFixture("daemon-start-migrate");
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);
      installPrivateTask48State(installation.paths.database);
      expect(stateSchemaVersion(installation.paths.database)).toBe(48);

      const started = capture();
      const code = await main(["daemon", "start", "--json"], started.output, input);
      expect({ code, output: started.read() }).toMatchObject({ code: 0 });
      expect(JSON.parse(started.read().stdout)).toEqual({
        command: "daemon.status",
        data: readyDaemonStatus(),
        ok: true,
        version: 1,
      });
      expect(started.read().stderr).toBe("");
      expect(daemonStarts).toBe(1);
      expect(stateSchemaVersion(installation.paths.database)).toBe(expectedStateSchemaVersion);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("local status refuses a pending schema migration and names the daemon", async () => {
    const { installation, runRoot } = await upgradeFixture("status-pending-migration");
    const input = {
      installation,
      startDaemon: () => { throw new Error("Local status must not start the daemon."); },
      callDaemon: () => { throw new Error("Local status must not call the daemon."); },
    };
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);
      installPrivateTask48State(installation.paths.database);
      const before = stateSchemaSnapshot(installation.paths.database);

      const captured = capture();
      expect(await main(["status", "--json"], captured.output, input)).toBe(7);
      expect(JSON.parse(captured.read().stdout)).toEqual({
        error: {
          code: "RECOVERY_REQUIRED",
          details: { nextCommand: "oompa daemon start" },
          message: `The local state schema needs a migration (48 to ${expectedStateSchemaVersion}); start the daemon to migrate it.`,
        },
        ok: false,
        version: 1,
      });
      expect(captured.read().stderr).toBe("");
      expect(stateSchemaVersion(installation.paths.database)).toBe(48);
      expect(stateSchemaSnapshot(installation.paths.database)).toBe(before);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("daemon start refuses local state written by a newer Oompa build", async () => {
    const { installation, runRoot } = await upgradeFixture("daemon-start-newer");
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);
      advanceStateSchema(installation.paths.database);
      const before = stateSchemaSnapshot(installation.paths.database);

      const captured = capture();
      expect(await main(["daemon", "start", "--json"], captured.output, input)).toBe(7);
      expect(JSON.parse(captured.read().stdout)).toEqual({
        error: {
          code: "RECOVERY_REQUIRED",
          message: `This Oompa build is older than the local state schema (${expectedStateSchemaVersion + 1} vs ${expectedStateSchemaVersion}); install the newer Oompa.`,
        },
        ok: false,
        version: 1,
      });
      expect(captured.read().stderr).toBe("");
      expect(daemonStarts).toBe(0);
      expect(stateSchemaVersion(installation.paths.database)).toBe(expectedStateSchemaVersion + 1);
      expect(stateSchemaSnapshot(installation.paths.database)).toBe(before);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("offline doctor names a pending schema migration instead of an opaque diagnostic", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-schema-pending-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await initializeStatePaths(statePaths);
      const store = new StateStore(statePaths);
      store.close();
      installPrivateTask48State(statePaths.database);
      const before = stateSchemaSnapshot(statePaths.database);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
      const rendered = JSON.parse(captured.read().stdout) as unknown;
      expect(rendered).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: [`The local state schema needs a migration (48 to ${expectedStateSchemaVersion}). Run \`oompa daemon start\` to migrate it.`],
          state: { database: "invalid", initialized: false },
        },
      });
      expect(JSON.stringify(rendered)).not.toContain(temporary);
      expect(captured.read().stderr).toBe("");
      expect(stateSchemaSnapshot(statePaths.database)).toBe(before);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor names local state written by a newer Oompa build", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-schema-newer-")));
    try {
      const statePaths = resolveStatePaths({ rootDirectory: join(temporary, "state") });
      await initializeStatePaths(statePaths);
      const store = new StateStore(statePaths);
      store.close();
      advanceStateSchema(statePaths.database);
      const before = stateSchemaSnapshot(statePaths.database);
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths })).toBe(1);
      const rendered = JSON.parse(captured.read().stdout) as unknown;
      expect(rendered).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: [`This Oompa build is older than the local state schema (${expectedStateSchemaVersion + 1} vs ${expectedStateSchemaVersion}). Install the newer Oompa.`],
          state: { database: "invalid", initialized: false },
        },
      });
      expect(JSON.stringify(rendered)).not.toContain(temporary);
      expect(captured.read().stderr).toBe("");
      expect(stateSchemaSnapshot(statePaths.database)).toBe(before);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("pre-initialization commands require init without creating daemon state", async () => {
    const runId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd4c";
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), `hra-live-acceptance-${runId}-`)),
    );
    const installation = createAcceptanceInstallation({
      device: "a",
      documentsDirectory: join(runRoot, "project-a-first-run"),
      expectedHomeDirectory: process.env.HOME ?? "/missing-home",
      rootDirectory: join(runRoot, "device-a-first-run"),
      runId,
      type: "hra-live-acceptance-device",
      version: 1,
    });
    let daemonStarts = 0;
    const input = {
      installation,
      startDaemon: async () => {
        daemonStarts += 1;
        return readyDaemonStatus();
      },
    };
    try {
      for (const argv of [
        ["account", "add", "Personal", "--json"],
        ["doctor", "--json"],
        ["project", "list", "--json"],
        ["daemon", "start", "--json"],
      ] as const) {
        const captured = capture();
        expect(await main(argv, captured.output, input)).toBe(6);
        expect(JSON.parse(captured.read().stdout)).toEqual({
          error: {
            code: "INTERACTION_REQUIRED",
            details: { nextCommand: "oompa init --yes" },
            message: "Initialize Oompa before starting its daemon.",
          },
          ok: false,
          version: 1,
        });
        expect(captured.read().stderr).toBe("");
        expect(daemonStarts).toBe(0);
        await expect(lstat(installation.paths.database)).rejects.toMatchObject({ code: "ENOENT" });
      }

      const status = capture();
      expect(await main(["status", "--json"], status.output, input)).toBe(6);
      expect(JSON.parse(status.read().stdout)).toEqual({
        error: {
          code: "INTERACTION_REQUIRED",
          details: { nextCommand: "oompa init --yes" },
          message: "Initialize Oompa before reading local status.",
        },
        ok: false,
        version: 1,
      });
      expect(status.read().stderr).toBe("");
      expect(daemonStarts).toBe(0);
      await expect(lstat(installation.paths.database)).rejects.toMatchObject({ code: "ENOENT" });

      const initialized = capture();
      expect(await main(["init", "--yes", "--json"], initialized.output, input)).toBe(0);
      expect(JSON.parse(initialized.read().stdout)).toMatchObject({
        data: { defaultProjectCreated: true, initialized: true },
        ok: true,
        version: 1,
      });
      expect((await lstat(installation.paths.database)).isFile()).toBe(true);
    } finally {
      await rm(runRoot, { force: true, recursive: true });
    }
  });

  test("stops only after the acknowledged authority is exactly released and gives the request a bounded five-second response window", async () => {
    const captured = capture();
    let deadlineMs = 0;
    let requestedAuthority: unknown;
    const dependencies = exactStopDependencies({
      requestStop: (input) => {
        deadlineMs = input.deadlineMs;
        requestedAuthority = input.command.expected;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    });

    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: dependencies,
    })).toBe(0);
    expect(deadlineMs).toBe(5_000);
    expect(requestedAuthority).toEqual(stopDaemonIdentity);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        stopping: false,
        running: false,
        daemon: stopDaemonIdentity,
        released: true,
      },
    });
    expect(captured.read().stdout).not.toContain('"reconciled"');
    expect(captured.read().stderr).toBe("");
  });

  test("reconciles an indeterminate stop response only against its captured pre-stop authority", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.reject(new LocalDaemonIndeterminateError("response lost")),
      }),
    })).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        stopping: false,
        running: false,
        daemon: stopDaemonIdentity,
        released: true,
        reconciled: true,
      },
    });
    expect(captured.read().stderr).toBe("");
  });

  test("treats a malformed successful stop response as indeterminate and reconciles exact authority", async () => {
    const malformed: CommandResponse = {
      data: { daemon: { pid: "invalid" }, running: true, stopping: true },
      ok: true,
      requestId: crypto.randomUUID(),
      version: 1,
    };
    const released = capture();
    expect(await main(["daemon", "stop", "--json"], released.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve(malformed),
      }),
    })).toBe(0);
    expect(JSON.parse(released.read().stdout)).toMatchObject({
      data: {
        daemon: stopDaemonIdentity,
        reconciled: true,
        released: true,
        running: false,
        stopping: false,
      },
      ok: true,
    });

    const held = capture();
    expect(await main(["daemon", "stop", "--json"], held.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve(malformed),
        waitForRelease: () => Promise.resolve({
          finalReceipt: daemonAuthorityReceipt("ready"),
          replacement: null,
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(held.read().stdout)).toMatchObject({
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa daemon status --json" },
      },
      ok: false,
    });
    expect(held.read().stdout).not.toContain('"released":true');
  });

  test("reconciles one generic release-observation error through the exact terminal publication window", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("stopped"),
      daemonAuthorityReceipt("stopped"),
    ];
    const sleeps: number[] = [];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient release observation")),
        authorityHeld: () => Promise.resolve(false),
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    })).toBe(0);
    expect(sleeps).toEqual([25]);
    expect(receipts).toHaveLength(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        running: false,
        released: true,
        reconciled: true,
      },
    });
  });

  test("does not reconcile a generic observation error while the exact stopped authority remains held", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("stopped"),
      daemonAuthorityReceipt("stopped"),
    ];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient release observation")),
        authorityHeld: () => Promise.resolve(true),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa daemon status --json" },
      },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test.each([
    ["receipt", "preflight_receipt", "not_attempted", 0],
    ["inspection", "preflight_inspection", "not_attempted", 0],
    ["indeterminate inspection", "preflight_inspection", "not_attempted", 0],
    ["request", "stop_request", "attempted", 1],
    ["synchronous request", "stop_request", "attempted", 1],
    ["acknowledged release", "release_confirmation", "acknowledged", 1],
    ["indeterminate response", "release_confirmation", "attempted", 1],
    ["unavailable response", "release_confirmation", "attempted", 1],
    ["malformed response", "release_confirmation", "attempted", 1],
    ["reconciliation receipt", "release_confirmation", "acknowledged", 1],
    ["reconciliation authority", "release_confirmation", "acknowledged", 1],
  ] as const)("reports closed daemon-stop authority observations after %s", async (
    boundary, authorityPhase, stopRequestState, expectedRequests,
  ) => {
    const captured = capture();
    const safety = new DaemonAuthoritySafetyError("private authority diagnostic must not escape");
    let observations = 0;
    let requests = 0;
    let releaseWaits = 0;
    const sleeps: number[] = [];
    const reconciles = boundary === "reconciliation receipt" || boundary === "reconciliation authority";
    const dependencies = exactStopDependencies({
      observeReceipt: () => {
        observations += 1;
        if (boundary === "receipt" || (boundary === "reconciliation receipt" && observations > 1)) {
          return Promise.reject(safety);
        }
        return Promise.resolve(daemonAuthorityReceipt(observations === 1 ? "ready" : "stopped"));
      },
      inspectAuthority: () => {
        if (boundary === "inspection") return Promise.reject(safety);
        return Promise.resolve(boundary === "indeterminate inspection" ? {
          state: "indeterminate" as const,
          database: { custody: "indeterminate" as const },
          receipt: { custody: "indeterminate" as const },
        } : {
          state: "held" as const,
          database: { custody: "safe" as const, authority: "held" as const },
          receipt: { custody: "safe" as const, state: "ready" as const },
        });
      },
      requestStop: () => {
        requests += 1;
        if (boundary === "synchronous request") throw safety;
        if (boundary === "request") return Promise.reject(safety);
        if (boundary === "indeterminate response") return Promise.reject(new LocalDaemonIndeterminateError("lost"));
        if (boundary === "unavailable response") return Promise.reject(new LocalDaemonUnavailableError("unavailable"));
        if (boundary === "malformed response") {
          return Promise.resolve({ ok: true, version: 1, requestId: crypto.randomUUID(), data: {} });
        }
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
      waitForRelease: () => {
        releaseWaits += 1;
        return Promise.reject(reconciles ? new Error("transient observation") : safety);
      },
      authorityHeld: () => Promise.reject(safety),
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: dependencies,
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout) as unknown).toEqual({
      ok: false,
      version: 1,
      error: {
        code: "RECOVERY_REQUIRED",
        message: "The local daemon authority could not be safely verified. Run `oompa doctor --offline` before taking further action.",
        details: { nextCommand: "oompa doctor --offline", authorityPhase, stopRequestState },
      },
    });
    expect(requests).toBe(expectedRequests);
    expect(releaseWaits).toBe(authorityPhase === "release_confirmation" ? 1 : 0);
    expect(sleeps).toEqual(boundary === "reconciliation authority" ? [25] : []);
    expect(captured.read().stdout).not.toContain(safety.message);
    expect(captured.read().stdout).not.toContain('"released":true');
    expect(captured.read().stderr).toBe("");
  });

  test("turns daemon-authority safety errors into an actionable closed recovery", async () => {
    const safety = new DaemonAuthoritySafetyError("unsafe authority fixture");
    let observations = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "oompa-unused-stop-safety") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => {
        observations += 1;
        return Promise.reject(safety);
      },
    }))).resolves.toMatchObject({
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa doctor --offline" },
      },
    });
    expect(observations).toBe(1);
  });

  test("turns an invalid daemon-authority database into an actionable closed recovery", async () => {
    const invalid = new Error("The daemon authority database is invalid and requires manual recovery.");
    let observations = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "oompa-unused-stop-invalid") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => {
        observations += 1;
        return Promise.reject(invalid);
      },
    }))).resolves.toMatchObject({
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa doctor --offline" },
      },
    });
    expect(observations).toBe(1);
  });

  test("rejects a replacement before registering any daemon stop callback", () => {
    let callbacks = 0;
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000799",
      generation: 2,
      bootId: `boot_${"f".repeat(32)}`,
    };
    expect(() => admitExactDaemonStop({
      command: { kind: "daemon.stop", expected: stopDaemonIdentity },
      receipt: daemonAuthorityReceipt("ready", replacement),
      afterResponse: () => { callbacks += 1; },
      requestStop: () => { callbacks += 100; },
    })).toThrow("No daemon was stopped");
    expect(callbacks).toBe(0);
  });

  test("treats a released maintenance receipt with no runtime generation as already stopped", async () => {
    const maintenanceReceipt: DaemonAuthorityReceipt = {
      version: 2,
      protocol: DAEMON_PROTOCOL,
      pid: 123,
      nonce: "018bcfe5-6800-7000-8000-000000000798",
      state: "stopped",
      acquiredAt: 1,
      updatedAt: 2,
    };
    let requests = 0;
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "oompa-unused-maintenance-stop") });
    await expect(stopDaemonWithExactAuthority(paths, exactStopDependencies({
      observeReceipt: () => Promise.resolve(maintenanceReceipt),
      inspectAuthority: () => Promise.resolve({
        state: "released",
        database: { authority: "released", custody: "safe" },
        receipt: { custody: "safe", state: "stopped" },
      }),
      authorityHeld: () => Promise.resolve(false),
      requestStop: () => {
        requests += 1;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    }))).resolves.toEqual({
      kind: "success",
      data: { stopping: false, running: false, released: false },
    });
    expect(requests).toBe(0);
  });

  test("requires database-backed release proof before calling a terminal or malformed receipt stopped", async () => {
    const paths = resolveStatePaths({ rootDirectory: join(tmpdir(), "oompa-unused-terminal-stop-proof") });
    const absentDatabaseWithStoppedReceipt = exactStopDependencies({
      observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("stopped")),
      inspectAuthority: () => Promise.resolve({
        state: "indeterminate",
        database: { custody: "absent" },
        receipt: { custody: "safe", state: "stopped" },
      }),
    });
    await expect(stopDaemonWithExactAuthority(
      paths,
      absentDatabaseWithStoppedReceipt,
    )).resolves.toMatchObject({
      error: { code: "RECOVERY_REQUIRED" },
      kind: "failure",
    });

    const absentDatabaseWithMalformedReceipt = exactStopDependencies({
      observeReceipt: () => Promise.resolve(null),
      inspectAuthority: () => Promise.resolve({
        state: "indeterminate",
        database: { custody: "absent" },
        receipt: { custody: "invalid" },
      }),
    });
    await expect(stopDaemonWithExactAuthority(
      paths,
      absentDatabaseWithMalformedReceipt,
    )).resolves.toMatchObject({
      error: { code: "RECOVERY_REQUIRED" },
      kind: "failure",
    });

    let requests = 0;
    const safeReleasedTerminal = exactStopDependencies({
      observeReceipt: () => Promise.resolve(daemonAuthorityReceipt("stopped")),
      inspectAuthority: () => Promise.resolve({
        state: "released",
        database: { authority: "released", custody: "safe" },
        receipt: { custody: "safe", state: "stopped" },
      }),
      requestStop: () => {
        requests += 1;
        return Promise.resolve(acknowledgedDaemonStopResponse());
      },
    });
    await expect(stopDaemonWithExactAuthority(paths, safeReleasedTerminal)).resolves.toEqual({
      data: { released: false, running: false, stopping: false },
      kind: "success",
    });
    expect(requests).toBe(0);
  });

  test("treats safely released stale receipt evidence as already stopped without hiding it from doctor", async () => {
    for (const receiptKind of ["live", "malformed"] as const) {
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `oompa-stop-stale-${receiptKind}-`)));
      const statePaths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      try {
        await initializeStatePaths(statePaths);
        const authority = await DaemonLock.acquire(statePaths, { state: "maintenance" });
        await authority.publish({
          bootId: `boot_${"7".repeat(32)}`,
          generation: 1,
          state: "ready",
        });
        await authority.release();
        const terminal = await readDaemonAuthorityReceipt(statePaths);
        if (terminal === null) throw new Error("Expected a terminal daemon receipt fixture.");
        await writeFile(
          statePaths.daemonLock,
          receiptKind === "live"
            ? `${JSON.stringify({ ...terminal, failure: undefined, state: "ready" })}\n`
            : "malformed receipt\n",
          { encoding: "utf8", mode: 0o600 },
        );

        const stopped = capture();
        expect(await main(["daemon", "stop", "--json"], stopped.output, { statePaths })).toBe(0);
        expect(JSON.parse(stopped.read().stdout)).toMatchObject({
          data: { released: false, running: false, stopping: false },
          ok: true,
        });
        expect(stopped.read().stdout).not.toContain("reconciled");

        const doctor = capture();
        expect(await main(["doctor", "--offline", "--json"], doctor.output, { statePaths })).toBe(0);
        expect(JSON.parse(doctor.read().stdout)).toMatchObject({
          data: {
            healthy: true,
            state: { daemonAuthority: { state: "stale_recoverable" } },
          },
          ok: true,
        });
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    }
  });

  test("fails closed when the stop response acknowledges a replacement of the pre-observed live authority", async () => {
    const captured = capture();
    let releaseWaits = 0;
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000701",
      generation: 2,
      bootId: `boot_${"b".repeat(32)}`,
    };
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.resolve({
          ...acknowledgedDaemonStopResponse(),
          data: { stopping: true, running: true, daemon: replacement },
        }),
        waitForRelease: () => {
          releaseWaits += 1;
          return Promise.resolve({ replacement: null, finalReceipt: daemonAuthorityReceipt("stopped") });
        },
      }),
    })).toBe(7);
    expect(releaseWaits).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED" },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("fails closed when a replacement authority appears during release observation", async () => {
    const captured = capture();
    const replacement = {
      ...stopDaemonIdentity,
      pid: 456,
      nonce: "018bcfe5-6800-7000-8000-000000000702",
      generation: 2,
      bootId: `boot_${"c".repeat(32)}`,
    };
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        waitForRelease: () => Promise.resolve({
          replacement,
          finalReceipt: daemonAuthorityReceipt("ready", replacement),
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_REQUIRED" },
    });
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("fails closed when the exact daemon releases a failed receipt", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        waitForRelease: () => Promise.resolve({
          replacement: null,
          finalReceipt: daemonAuthorityReceipt("failed"),
        }),
      }),
    })).toBe(7);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa doctor --offline" },
      },
    });
    expect(captured.read().stdout).not.toContain("bounded shutdown failure");
    expect(captured.read().stdout).not.toContain('"released":true');
  });

  test("reports a failed terminal publication only after its exact authority is released", async () => {
    const captured = capture();
    const receipts = [
      daemonAuthorityReceipt("ready"),
      daemonAuthorityReceipt("failed"),
      daemonAuthorityReceipt("failed"),
    ];
    const sleeps: number[] = [];
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        observeReceipt: () => Promise.resolve(receipts.shift() ?? null),
        waitForRelease: () => Promise.reject(new Error("transient failed-release observation")),
        authorityHeld: () => Promise.resolve(false),
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      }),
    })).toBe(7);
    expect(sleeps).toEqual([25]);
    expect(receipts).toHaveLength(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: false,
      error: {
        code: "RECOVERY_REQUIRED",
        details: { nextCommand: "oompa doctor --offline" },
      },
    });
  });

  test("accepts pre-dispatch unavailability only after the captured authority is exactly released", async () => {
    const captured = capture();
    expect(await main(["daemon", "stop", "--json"], captured.output, {
      daemonStopDependencies: exactStopDependencies({
        requestStop: () => Promise.reject(new LocalDaemonUnavailableError("endpoint disappeared")),
      }),
    })).toBe(0);
    expect(JSON.parse(captured.read().stdout)).toMatchObject({
      ok: true,
      data: {
        daemon: stopDaemonIdentity,
        running: false,
        released: true,
        reconciled: true,
      },
    });
  });

  test("init without explicit acceptance reports the next command without creating state", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-confirm-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const previousHome = process.env.HOME;
    process.env.HOME = temporary;
    try {
      const captured = capture();
      expect(await main(["init", "--json"], captured.output)).toBe(6);
      expect(captured.read().stderr).toBe("");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "INTERACTION_REQUIRED",
          message: "Confirm the default Documents project with `oompa init --yes`.",
        },
      });
      await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init creates a missing default Documents directory before committing local state", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-empty-home-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(0);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: true,
        data: {
          defaultProjectCreated: true,
          initialized: true,
        },
      });
      const documentsMetadata = await lstat(documents);
      expect(documentsMetadata.isDirectory()).toBe(true);
      expect(documentsMetadata.isSymbolicLink()).toBe(false);
      const store = new StateStore(paths, { readonly: true });
      try {
        expect(store.listProjects()).toHaveLength(1);
        expect(store.listProjects()[0]?.rootPath).toBe(documents);
      } finally {
        store.close();
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init escapes terminal-format scalars in its JSON state-root value", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-json-control-")));
    const paths = resolveStatePaths({ rootDirectory: join(temporary, "state-\u202e-private") });
    const documents = join(temporary, "Documents");
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(0);
      expect(captured.read().stdout).toContain("\\u202e");
      expect(captured.read().stdout).not.toContain("\u202e");
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        data: { stateRoot: paths.root },
        ok: true,
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("project add rejects missing or unusable paths locally with actionable output", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-project-add-path-")));
    const missing = join(temporary, "missing-private-project");
    const regularFile = join(temporary, "not-a-directory-private-project");
    await writeFile(regularFile, "not a project directory", { mode: 0o600 });
    let daemonCalls = 0;
    const callDaemon = (): Promise<never> => {
      daemonCalls += 1;
      return Promise.reject(new Error("Project validation must not call the daemon."));
    };
    try {
      const json = capture();
      expect(await main([
        "project",
        "add",
        missing,
        "--name",
        "Missing",
        "--json",
      ], json.output, { callDaemon })).toBe(2);
      expect(JSON.parse(json.read().stdout)).toMatchObject({
        error: {
          code: "INVALID_INPUT",
          message: "The project directory does not exist or is not readable, writable, traversable, and canonical. Restore access or choose another directory, then retry.",
        },
        ok: false,
      });
      expect(json.read().stderr).toBe("");

      const human = capture();
      expect(await main([
        "project",
        "add",
        regularFile,
        "--name",
        "Invalid",
      ], human.output, { callDaemon })).toBe(2);
      expect(human.read().stdout).toBe("");
      expect(human.read().stderr).toContain("Restore access or choose another directory, then retry.");
      expect(daemonCalls).toBe(0);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init rejects an unsafe default Documents path before creating the database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-unsafe-documents-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    await writeFile(documents, "not a directory", { encoding: "utf8", mode: 0o600 });
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `oompa init --yes` again.",
        },
      });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("init rejects a non-traversable default directory before creating the database", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-nontraversable-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    await mkdir(documents, { mode: 0o600 });
    try {
      const captured = capture();
      expect(await initialize(true, true, captured.output, { paths, documentsDirectory: documents })).toBe(5);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `oompa init --yes` again.",
        },
      });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(documents, 0o700);
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("repeated init leaves unrelated default paths untouched after initialization", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-idempotent-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    const documents = join(temporary, "Documents");
    const absent = join(temporary, "Absent Documents");
    const unsafe = join(temporary, "Unsafe Documents");
    try {
      expect(await initialize(true, true, capture().output, { paths, documentsDirectory: documents })).toBe(0);

      const absentCapture = capture();
      expect(await initialize(true, true, absentCapture.output, { paths, documentsDirectory: absent })).toBe(0);
      expect(JSON.parse(absentCapture.read().stdout)).toMatchObject({
        ok: true,
        data: { defaultProjectCreated: false, initialized: true },
      });
      await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(unsafe, "not a directory", { encoding: "utf8", mode: 0o600 });
      const unsafeCapture = capture();
      expect(await initialize(true, true, unsafeCapture.output, { paths, documentsDirectory: unsafe })).toBe(0);
      expect(JSON.parse(unsafeCapture.read().stdout)).toMatchObject({
        ok: true,
        data: { defaultProjectCreated: false, initialized: true },
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("offline doctor reports a projectless database as incomplete initialization", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-doctor-projectless-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    try {
      await initializeStatePaths(paths);
      const store = new StateStore(paths);
      store.close();
      const captured = capture();
      expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths: paths })).toBe(1);
      expect(JSON.parse(captured.read().stdout)).toMatchObject({
        ok: false,
        error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
        data: {
          healthy: false,
          problems: ["No project directory is configured. Run `oompa init --yes`."],
          state: {
            database: "ready",
            initialized: false,
            projectCount: 0,
          },
        },
      });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  for (const scenario of ["missing", "symlink", "non_traversable"] as const) {
    test(`offline doctor separates unusable project roots from a healthy database: ${scenario}`, async () => {
      const problem = "A configured project directory is missing or unsafe. Run `oompa project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.";
      const temporary = await realpath(await mkdtemp(join(tmpdir(), `oompa-doctor-project-${scenario}-`)));
      const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
      const documents = join(temporary, "Documents");
      try {
        expect(await initialize(true, true, capture().output, { paths, documentsDirectory: documents })).toBe(0);
        if (scenario === "missing") {
          await rename(documents, join(temporary, "Documents moved"));
        } else if (scenario === "symlink") {
          const target = join(temporary, "Documents target");
          await rename(documents, target);
          await symlink(target, documents);
        } else {
          await chmod(documents, 0o600);
        }

        const captured = capture();
        expect(await main(["doctor", "--offline", "--json"], captured.output, { statePaths: paths })).toBe(1);
        expect(JSON.parse(captured.read().stdout)).toMatchObject({
          ok: false,
          error: { code: "UNHEALTHY", message: "Oompa checks found 1 problem." },
          data: {
            healthy: false,
            problems: [problem],
            state: {
              database: "ready",
              initialized: true,
              projectCount: 1,
            },
          },
        });
      } finally {
        if (scenario === "non_traversable") await chmod(documents, 0o700).catch(() => undefined);
        await rm(temporary, { force: true, recursive: true });
      }
    });
  }

  test("online doctor keeps its envelope and exit code in agreement over validated health", async () => {
    const invalid = "Oompa checks returned an invalid local result.";
    for (const entry of [
      { data: { healthy: true, problems: [] }, exitCode: 0 },
      { data: { healthy: false, problems: ["Cloud projection recovery is unsettled."] }, exitCode: 1, message: "Oompa checks found 1 problem." },
      { data: { healthy: false, problems: [] }, exitCode: 1, message: "Oompa checks did not pass, but no safe diagnostic was available." },
      { data: { healthy: "yes", problems: [] }, exitCode: 1, message: invalid },
      { data: { healthy: true, problems: ["Cloud status is inconsistent.", "Cloud device is stale."] }, exitCode: 1, message: "Oompa checks found 2 problems." },
      { data: { healthy: true, problems: "none" }, exitCode: 1, message: invalid },
      { data: { healthy: true, problems: [1] }, exitCode: 1, message: invalid },
    ] as const) {
      const captured = capture();
      expect(await main(["doctor", "--json"], captured.output, {
        callDaemon: (command) => {
          expect(command).toEqual({ kind: "doctor", offline: false });
          return Promise.resolve({
            ok: true,
            version: 1,
            requestId: crypto.randomUUID(),
            data: entry.data,
          });
        },
      })).toBe(entry.exitCode);
      expect(JSON.parse(captured.read().stdout)).toEqual(entry.exitCode === 0
        ? { ok: true, version: 1, command: "doctor", data: entry.data }
        : {
            ok: false,
            version: 1,
            command: "doctor",
            data: entry.data,
            error: { code: "UNHEALTHY", message: "message" in entry ? entry.message : "" },
          });
      expect(captured.read().stderr).toBe("");
    }
    const human = capture();
    expect(await main(["doctor"], human.output, {
      callDaemon: () => Promise.resolve({
        ok: true,
        version: 1,
        requestId: crypto.randomUUID(),
        data: { healthy: false, problems: ["Cloud status is inconsistent."] },
      }),
    })).toBe(1);
    expect(human.read()).toEqual({ stdout: "Oompa checks found 1 problem:\n- Cloud status is inconsistent.\n", stderr: "" });
  });

  test("init never opens or migrates the state database outside exclusive authority", async () => {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-init-lock-")));
    const paths = resolveStatePaths({ homeDirectory: temporary, platform: process.platform });
    await initializeStatePaths(paths);
    const documents = join(temporary, "Documents");
    await mkdir(documents, { mode: 0o700 });
    const owner = await DaemonLock.acquire(paths);
    try {
      const captured = capture();
      await expect(initialize(true, true, captured.output, { paths, documentsDirectory: documents })).rejects.toThrow("already owns");
      expect(captured.read()).toEqual({ stdout: "", stderr: "" });
      await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await owner.release();
      await rm(temporary, { force: true, recursive: true });
    }
  });
});
