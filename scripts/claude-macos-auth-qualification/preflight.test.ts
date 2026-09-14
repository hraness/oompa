import { createHash } from "node:crypto";

import { expect, test } from "bun:test";
import fc from "fast-check";

import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import type { DetachedAuthOperation, DetachedAuthProcess, DetachedAuthSettlement } from "../claude-macos-auth-process/process";
import { QualificationCustody } from "./custody";
import { collectCredentialFreeClaudeMacosCapabilities, collectCredentialFreeClaudeMacosPreflight, collectNativeClaudeMacosCapabilities, collectNativeClaudeMacosPreflight, type ClaudeMacosPreflightScope, type NativeClaudeMacosPreflightInput } from "./preflight";
import { createQualification, observeQualification, type QualificationState } from "./state";

type FixtureInput = Parameters<typeof collectCredentialFreeClaudeMacosPreflight>[0];
type FixturePorts = Parameters<typeof collectCredentialFreeClaudeMacosPreflight>[1];
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/preflight";
const directory = (name: string, inode: number) => ({ path: `${root}/${name}`, device: 1, inode, mode: 0o700 });
const binding = {
  version: 1, runId: id(1), sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), pin: CLAUDE_PIN,
  executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  executable: { path: "/private/synthetic/immutable-claude", device: 1, inode: 100 }, ownerUid: 501,
  realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"], runRoot: { path: root, device: 1, inode: 2, mode: 0o700 },
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: `${root}/proof-key`, device: 1, inode: 7, mode: 0o600 },
};
const state = (): QualificationState => {
  let value = createQualification(binding, new Uint8Array(32).fill(23), id(10));
  value = observeQualification(value, { type: "intent", attemptId: id(20), step: 0 });
  value = observeQualification(value, { type: "persisted", attemptId: id(20) });
  return observeQualification(value, { type: "dispatch", attemptId: id(20), bindingTag: value.bindingTag,
    sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true });
};
const text = (operation: DetachedAuthOperation): string => operation === "version" ? `${CLAUDE_PIN} (Claude Code)\n`
  : operation === "login_help" ? "Usage: claude auth login [options]\n\nOptions:\n  --claudeai\n  -h, --help\n"
    : "Usage: claude auth logout [options]\n\nLog out\n\nOptions:\n  -h, --help  Display help\n";
const deferred = () => {
  const value = Promise.withResolvers<undefined>();
  return { promise: value.promise, resolve: () => value.resolve(undefined) };
};
type Owned = { stdout: Uint8Array; stderr: Uint8Array; terminal: DetachedAuthSettlement; child: DetachedAuthProcess;
  terminated: number; stdoutReads: number; stderrReads: number };

function fixture(options: Readonly<{
  controller?: AbortController;
  patch?: Partial<DetachedAuthSettlement>;
  output?: (operation: DetachedAuthOperation) => Uint8Array;
  stderr?: Uint8Array;
  gate?: Promise<undefined>;
  started?: () => void;
  streamFailure?: boolean;
}> = {}) {
  const controller = options.controller ?? new AbortController();
  const calls: string[] = []; const owned: Owned[] = []; const scopes: ClaudeMacosPreflightScope[] = [];
  const request: FixtureInput = { state: state(), signal: controller.signal, environment: { HOME: binding.realHome, PATH: "/usr/bin:/bin" },
    authority: { async revalidate(scope) {
      calls.push(`authority:${scope.profile}:${scope.operation}`); scopes.push(scope); await Promise.resolve();
      return { assertCurrent(actual) { expect(actual).toBe(scope); calls.push("source-current"); } };
    } } };
  const ports: FixturePorts = {
    async prepareDispatchAuthority(scope) {
      calls.push("ticket"); await Promise.resolve();
      let used = false;
      return { assertCurrent(actual) { expect(used).toBeFalse(); used = true; expect(actual).toEqual(scope); calls.push("custody-current"); } };
    },
    bindProcess(input) {
      calls.push("bind");
      expect(input).toMatchObject({ executablePath: binding.executable.path, executableSha256: binding.executableDigest, deadlineMs: 5000 });
      const profile = input.configDir === binding.profileA.path ? "A" : "B";
      expect(input.temporaryDirectory).toBe(profile === "A" ? binding.temporaryA.path : binding.temporaryB.path);
      const environment = Object.freeze({ HOME: binding.realHome, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: input.configDir, TMPDIR: input.temporaryDirectory, NO_COLOR: "1" });
      let child: DetachedAuthProcess | null = null;
      const start = (operation: DetachedAuthOperation): DetachedAuthProcess => {
        expect(["version", "login_help", "logout_help"]).toContain(operation);
        expect(child).toBeNull(); calls.push(`start:${profile}:${operation}`);
        const stdout = options.output?.(operation) ?? new TextEncoder().encode(text(operation)); const stderr = Uint8Array.from(options.stderr ?? []);
        const terminal: DetachedAuthSettlement = { operation, cleanup: "joined", admitted: true, exitCode: 0, childJoined: true, stdoutEof: true, stderrEof: true,
          stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength,
          detachment: { identity: { pid: 123 + owned.length, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
            setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true },
          deadlineMs: 5000, elapsedMs: 50, inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2, ...options.patch };
        const item: Owned = { stdout, stderr, terminal, terminated: 0, stdoutReads: 0, stderrReads: 0,
          child: { stdout: { async *[Symbol.asyncIterator]() { item.stdoutReads += 1; yield stdout; if (options.streamFailure) throw new Error("private stream failure"); } },
            stderr: { async *[Symbol.asyncIterator]() { item.stderrReads += 1; yield stderr; } },
            exited: Promise.resolve(0), settlement: (async () => { await options.gate; return terminal; })(),
            terminate() { item.terminated += 1; }, forceTerminate() { item.terminated += 1; } } };
        owned.push(item); child = item.child; options.started?.(); return child;
      };
      return { environment, start,
        versionFactory(actual) { expect(actual.argv).toEqual([binding.executable.path, "--version"]); expect(actual.environment).toBe(environment); return start("version"); },
        statusFactory() { throw new Error("status is outside preflight"); },
        async settled() { return child === null ? null : await child.settlement; } };
    },
    // This fixture resolver is not runtime provenance. Native code uses the existing real resolver and its exact parser.
    async resolveRuntime(input) {
      calls.push("resolve"); expect(input.executablePath).toBe(binding.executable.path); expect(input.configHome).toBe("isolated");
      if (input.probeVersion === undefined || input.environment === undefined || input.signal === undefined || input.executablePath === undefined) throw new Error("fixture resolver input");
      const reported = await input.probeVersion({ executablePath: input.executablePath, configDir: input.configDir, configHome: "isolated", environment: input.environment,
        signal: input.signal, deadlineMs: 5000 });
      if (reported !== `${CLAUDE_PIN} (Claude Code)\n`) throw new Error("fixture reported version mismatch");
      return { executablePath: input.executablePath, version: CLAUDE_PIN, effort: CLAUDE_PIN_EFFORT, model: CLAUDE_PIN_MODEL,
        nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: [input.executablePath] };
    },
  };
  return { request, ports, owned, calls, scopes, controller };
}
const cleared = (value: ReturnType<typeof fixture>): void => {
  for (const owned of value.owned) { expect(owned.stdout.every((byte) => byte === 0)).toBeTrue(); expect(owned.stderr.every((byte) => byte === 0)).toBeTrue();
    expect(owned.stdoutReads).toBe(1); expect(owned.stderrReads).toBe(1); }
};

const strictHelp = ["Usage: claude auth login [options]", "", "Synthetic login", "", "Options:",
  "  --claudeai".padEnd(19) + "Synthetic browser", "  --console".padEnd(19) + "Synthetic console", " ".repeat(19) + "Continuation",
  "  --email <value>  Synthetic email", "  -h, --help  Synthetic help", "  --sso  Synthetic SSO", ""].join("\n");

test("strict capabilities retain the actual A/B resolver objects and clear every captured byte", async () => {
  const value = fixture({ output: (operation) => new TextEncoder().encode(operation === "login_help" ? strictHelp : text(operation)) });
  const runtimes: Awaited<ReturnType<FixturePorts["resolveRuntime"]>>[] = [];
  const result = await collectCredentialFreeClaudeMacosCapabilities(value.request, { ...value.ports, async resolveRuntime(input) {
    const runtime = await value.ports.resolveRuntime(input); runtimes.push(runtime); return runtime;
  } });
  expect(result).toMatchObject({ source: "credential_free_fixture", kind: "capabilities_only", exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true });
  expect(runtimes[0]).toBe(result.runtimes.A); expect(runtimes[1]).toBe(result.runtimes.B);
  expect(result.probes).toHaveLength(6); expect(result.probes.every((probe) => probe.loginHelp === null)).toBeTrue();
  expect(result.probes.filter((probe) => probe.operation === "login_help").map((probe) => probe.stdoutSha256))
    .toEqual(Array.from({ length: 2 }, () => createHash("sha256").update(strictHelp).digest("hex")));
  expect(JSON.stringify(result)).not.toContain("Synthetic console"); cleared(value);
});

test("strict help refusal on either profile cannot return runtimes or admit later probes", async () => {
  for (const failAt of [1, 2]) {
    let helps = 0;
    const value = fixture({ output: (operation) => new TextEncoder().encode(operation === "login_help"
      ? ++helps === failAt ? strictHelp.replace("--sso", "--unknown") : strictHelp : text(operation)) });
    await expect(collectCredentialFreeClaudeMacosCapabilities(value.request, value.ports)).rejects.toMatchObject({ code: "capability_refused", cleanup: "joined" });
    expect(value.owned).toHaveLength(failAt === 1 ? 2 : 5); cleared(value);
  }
  const invalid = fixture();
  await expect(collectNativeClaudeMacosCapabilities({ ...invalid.request, custody: {} } as unknown as NativeClaudeMacosPreflightInput))
    .rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
  expect(invalid.owned).toHaveLength(0);
});

test("six fixed probes preserve fresh authority ordering and exact version factories, with unadmitted private diagnostics", async () => {
  const value = fixture(); const result = await collectCredentialFreeClaudeMacosPreflight(value.request, value.ports);
  expect(result).toMatchObject({ source: "credential_free_fixture", admitted: false, reason: "login_help_unverified", runId: id(1), attemptId: id(20),
    exactVersionBoth: true, logoutHelpBoth: true, loginHelpBoth: false });
  expect(result.probes.map((probe) => `${probe.profile}:${probe.operation}`)).toEqual(["A:version", "A:login_help", "A:logout_help", "B:version", "B:login_help", "B:logout_help"]);
  expect(new Set(result.probes.map((probe) => probe.probeId)).size).toBe(6);
  for (const scope of value.scopes) expect(scope).toMatchObject({ sourceSha: binding.sourceSha, sourceTree: binding.sourceTree,
    executableDevice: binding.executable.device, executableInode: binding.executable.inode, executableSha256: binding.executableDigest });
  expect(value.calls).toEqual(["A", "B"].flatMap((profile) => ["version", "login_help", "logout_help"].flatMap((operation) => [
    ...(operation === "version" ? ["resolve"] : []), `authority:${profile}:${operation}`, "ticket", "bind", "source-current", "custody-current", `start:${profile}:${operation}`])));
  for (const probe of result.probes) {
    expect(probe.loginHelp).toEqual(probe.operation === "login_help" ? { projectionComplete: true,
      optionRows: [{ flags: ["--claudeai"], argument: "none" }, { flags: ["-h", "--help"], argument: "none" }],
      diagnostics: { version: 1, usage: "exact", scan: "scanned", lineCount: 6, optionsHeadingCount: 1, candidateCount: 2,
        acceptedCount: 2, candidateLimitExceeded: false, rejectionsTruncated: false, rejections: [] } } : null);
  }
  expect(result).not.toHaveProperty("freshEmptyRoots"); expect(result).not.toHaveProperty("signatureRevalidated");
  expect(JSON.stringify(result)).not.toContain("Usage:"); expect(JSON.stringify(result)).not.toContain(root); expect(value.owned).toHaveLength(6); cleared(value);
});

test("both unverified login-help projections remain diagnostic even when extraction is incomplete", async () => {
  const value = fixture({ output(operation) {
    return new TextEncoder().encode(operation === "login_help" ? "Usage: claude auth login [options]\nOptions:\n  --claudeai  private description\n  unexpected continuation\n" : text(operation));
  } });
  const result = await collectCredentialFreeClaudeMacosPreflight(value.request, value.ports);
  expect(result).toMatchObject({ admitted: false, reason: "login_help_unverified", loginHelpBoth: false });
  for (const probe of result.probes.filter((entry) => entry.operation === "login_help")) expect(probe.loginHelp).toEqual({
    projectionComplete: false, optionRows: [{ flags: ["--claudeai"], argument: "none" }],
    diagnostics: { version: 1, usage: "exact", scan: "scanned", lineCount: 5, optionsHeadingCount: 1, candidateCount: 2,
      acceptedCount: 1, candidateLimitExceeded: false, rejectionsTruncated: false,
      rejections: [{ line: 4, reason: "non_option_line", indentCodeUnits: 2, indentClamped: false,
        lineBytes: 25, declarationBytes: 23, beginsWithFlag: false, precedingOptionOrdinal: 1, precedingDescriptionRelation: "before" }] },
  });
  expect(JSON.stringify(result)).not.toContain("private description"); expect(JSON.stringify(result)).not.toContain("unexpected continuation");
  cleared(value);
});

test("maximum row and rejection counts fit the unchanged private caller outcome bound", async () => {
  const declarations = Array.from({ length: 32 }, (_, index) => `  --a${"x".repeat(60)}${index.toString().padStart(2, "0")} <${"P".repeat(64)}>  PRIVATE_DESCRIPTION\n`).join("");
  const rejected = Array.from({ length: 32 }, () => " ".repeat(257) + "PRIVATE_CONTINUATION\n").join("");
  const help = "Usage: claude auth login [options]\nOptions:\n" + declarations + rejected;
  expect(new TextEncoder().encode(help).byteLength).toBeLessThanOrEqual(16_384);
  const value = fixture({ output: (operation) => new TextEncoder().encode(operation === "login_help" ? help : text(operation)) });
  const result = await collectCredentialFreeClaudeMacosPreflight(value.request, value.ports);
  for (const probe of result.probes.filter((entry) => entry.operation === "login_help")) {
    expect(probe.loginHelp?.optionRows).toHaveLength(32); expect(probe.loginHelp?.diagnostics.rejections).toHaveLength(32);
    expect(probe.loginHelp?.diagnostics.candidateLimitExceeded).toBeTrue();
  }
  // The reviewed native caller restricts its capsule to ASCII. Reserve the full
  // 4096-character path bound for each retained recovery path, plus its envelope.
  const envelope = { kind: "native_login_help_diagnostic_outcome", version: 1, sourceCommit: "a".repeat(40), completedAt: "2026-09-11T23:59:59.999Z",
    outcome: { admitted: false, step: 0, status: "blocked", reason: "login_help_unverified", cleanup: "joined", ownerRelease: "released",
      recovery: { runId: id(1), runRoot: "/" + "x".repeat(4095), receiptPath: "/" + "x".repeat(4095) },
      diagnostic: result, freshRootsObserved: true, checkpoint: "dispatched" } };
  expect(new TextEncoder().encode(JSON.stringify(envelope) + "\n").byteLength).toBeLessThanOrEqual(65_536);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_"); expect(JSON.stringify(result)).not.toContain("P".repeat(64));
  expect(result.admitted).toBeFalse(); expect(result.loginHelpBoth).toBeFalse(); expect(value.owned).toHaveLength(6); cleared(value);
});

test("missing dispatch, fixture/native mixing and open input overrides refuse before launch", async () => {
  for (const patch of [{ step: 1 }, { pending: null }, { pending: { attemptId: id(20), stage: "persisted" } }, { needsRecovery: true }, { failure: "owner_lost" },
    { binding: { ...binding, version: 2, mode: "native_qualification" } }]) {
    const value = fixture(); await expect(collectCredentialFreeClaudeMacosPreflight({ ...value.request, state: { ...state(), ...patch } }, value.ports)).rejects.toMatchObject({ cleanup: "not_started" });
    expect(value.calls).toEqual([]);
  }
  for (const extra of [{ bindProcess() {} }, { grammar: "trusted" }, { source: "credential_free_fixture" }, { operations: ["logout"] }]) {
    const value = fixture(); const fake = Object.create(QualificationCustody.prototype) as QualificationCustody;
    const input = { environment: value.request.environment, signal: value.request.signal, authority: value.request.authority, custody: fake, ...extra } as NativeClaudeMacosPreflightInput;
    await expect(collectNativeClaudeMacosPreflight(input)).rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
    expect(value.calls).toEqual([]);
  }
  const value = fixture(); const fake = Object.create(QualificationCustody.prototype) as QualificationCustody;
  Object.defineProperty(fake, "state", { value: { ...state(), binding: { ...binding, version: 2, mode: "native_qualification" } } });
  await expect(collectNativeClaudeMacosPreflight({ environment: value.request.environment, signal: value.request.signal, authority: value.request.authority, custody: fake })).rejects.toMatchObject({ code: "scope_refused", cleanup: "not_started" });
});

test("abort and stale source or custody authority never pass the final launch point", async () => {
  for (const phase of ["preabort", "source-await", "ticket-await", "source-current", "custody-current"]) {
    const value = fixture();
    if (phase === "preabort") value.controller.abort();
    const request: FixtureInput = { ...value.request, authority: { async revalidate() {
      await Promise.resolve(); if (phase === "source-await") value.controller.abort();
      return { assertCurrent() { if (phase === "source-current") throw new Error("private source changed"); } };
    } } };
    await expect(collectCredentialFreeClaudeMacosPreflight(request, { ...value.ports, async prepareDispatchAuthority() {
      await Promise.resolve(); if (phase === "ticket-await") value.controller.abort();
      return { assertCurrent() { if (phase === "custody-current") throw new Error("private owner changed"); } };
    } })).rejects.toMatchObject({ cleanup: "not_started" });
    expect(value.owned).toHaveLength(0);
  }
});

test("every child requires actual admission, EOF, exact inspection joins, bounded timing and coherent output", async () => {
  const patches: Partial<DetachedAuthSettlement>[] = [{ admitted: false }, { childJoined: false }, { cleanup: "uncertain" }, { stdoutEof: false }, { stderrEof: false },
    { inspectionComplete: false }, { inspectorsJoined: 1 }, { inspectorsStarted: 1, inspectorsJoined: 1 }, { detachment: null }, { operation: "login_help" },
    { deadlineMs: 3000 }, { elapsedMs: 5000 }, { elapsedMs: -1 }, { exitCode: 1 }, { stdoutBytes: 1 }, { stderrBytes: 1 }];
  for (const patch of patches) {
    const value = fixture({ patch }); await expect(collectCredentialFreeClaudeMacosPreflight(value.request, value.ports)).rejects.toMatchObject({ code: "native_unproved" });
    expect(value.owned).toHaveLength(1); cleared(value);
  }
  for (const patch of [{ inspectionComplete: false }, { inspectorsJoined: 1 }, { childJoined: false }]) {
    const value = fixture({ patch }); await expect(collectCredentialFreeClaudeMacosPreflight(value.request, value.ports)).rejects.toMatchObject({ cleanup: "uncertain" });
  }
});

test("partial preflight refusal preserves earlier collection and an uncertain later start never becomes joined", async () => {
  for (const mode of ["ticket", "start"] as const) {
    const value = fixture();
    const ports: FixturePorts = { ...value.ports,
      async prepareDispatchAuthority(scope) { if (mode === "ticket" && scope.profile === "B") throw new Error("private owner expired"); return await value.ports.prepareDispatchAuthority(scope); },
      bindProcess(scope) {
        const bound = value.ports.bindProcess(scope);
        if (mode !== "start" || scope.configDir !== binding.profileB.path) return bound;
        return { ...bound, versionFactory() { throw new Error("uncertain native start"); } };
      } };
    await expect(collectCredentialFreeClaudeMacosPreflight(value.request, ports)).rejects.toMatchObject({
      code: mode === "ticket" ? "authority_refused" : "native_unproved", cleanup: mode === "ticket" ? "joined" : "uncertain" });
    expect(value.owned).toHaveLength(3); cleared(value);
  }
});

test("oversized, invalid UTF-8, nonempty stderr and changed logout flags stop collection without raw output leakage", async () => {
  for (const mode of ["version_limit", "help_limit", "utf8", "stderr", "logout_flag"] as const) {
    const value = fixture({ output(operation) {
      if (mode === "version_limit") return new Uint8Array(513).fill(120);
      if (mode === "utf8") return new Uint8Array([255]);
      if (mode === "help_limit" && operation === "login_help") return new Uint8Array(16_385).fill(120);
      return new TextEncoder().encode(text(operation) + (mode === "logout_flag" && operation === "logout_help" ? "  --token <value>  Secret\n" : ""));
    }, ...(mode === "stderr" ? { stderr: new Uint8Array([120]) } : {}) });
    await expect(collectCredentialFreeClaudeMacosPreflight(value.request, value.ports)).rejects.toMatchObject({ cleanup: "joined" });
    expect(value.owned.length).toBeLessThan(4); cleared(value);
  }
});

test("version resolution cannot omit its probe, cross profiles, add factory overrides or silently accept another pin", async () => {
  for (const mode of ["omitted", "path", "factory", "version", "result_version"] as const) {
    const value = fixture({ ...(mode === "version" ? { output: () => new TextEncoder().encode("2.1.259 (Claude Code)\n") } : {}) });
    const ports: FixturePorts = { ...value.ports, async resolveRuntime(options) {
      if (mode === "version") return await value.ports.resolveRuntime(options);
      if (mode === "result_version") {
        const runtime = await value.ports.resolveRuntime(options);
        return { ...runtime, version: "2.1.259" } as unknown as Awaited<ReturnType<FixturePorts["resolveRuntime"]>>;
      }
      if (mode !== "omitted" && options.probeVersion !== undefined) await options.probeVersion({ executablePath: mode === "path" ? "/private/other" : binding.executable.path,
        configDir: binding.profileA.path, configHome: "isolated", environment: value.request.environment, signal: value.request.signal, deadlineMs: 5000,
        ...(mode === "factory" ? { processFactory: () => { throw new Error("must not run"); } } : {}) });
      return { executablePath: binding.executable.path, version: CLAUDE_PIN, effort: CLAUDE_PIN_EFFORT, model: CLAUDE_PIN_MODEL, nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: [binding.executable.path] };
    } };
    await expect(collectCredentialFreeClaudeMacosPreflight(value.request, ports)).rejects.toMatchObject({ code: mode === "path" || mode === "factory" ? "scope_refused" : "runtime_refused" });
    expect(value.owned).toHaveLength(mode === "version" || mode === "result_version" ? 1 : 0); cleared(value);
  }
});

test("help digests preserve collected UTF-8 BOM bytes while the version parser still receives and refuses a BOM", async () => {
  const value = fixture({ output(operation) { return new TextEncoder().encode(`${operation === "version" ? "" : "\ufeff"}${text(operation)}`); } });
  const result = await collectCredentialFreeClaudeMacosPreflight(value.request, value.ports);
  for (const probe of result.probes) {
    const original = new TextEncoder().encode(`${probe.operation === "version" ? "" : "\ufeff"}${text(probe.operation)}`);
    expect(probe.stdoutBytes).toBe(original.byteLength);
    expect(probe.stdoutSha256).toBe(createHash("sha256").update(original).digest("hex"));
  }
  cleared(value);
  const badVersion = fixture({ output: (operation) => new TextEncoder().encode(`\ufeff${text(operation)}`) });
  await expect(collectCredentialFreeClaudeMacosPreflight(badVersion.request, badVersion.ports)).rejects.toMatchObject({ code: "runtime_refused", cleanup: "joined" });
  expect(badVersion.owned).toHaveLength(1); cleared(badVersion);
});

test("cancellation and stream refusal retain the started child until its settlement joins", async () => {
  for (const mode of ["abort", "stream"] as const) {
    const gate = deferred(); const started = deferred(); const value = fixture({ gate: gate.promise, started: started.resolve, streamFailure: mode === "stream" });
    let returned = false;
    const result = collectCredentialFreeClaudeMacosPreflight(value.request, value.ports).then(() => { returned = true; return null; }, (error: unknown) => { returned = true; return error; });
    try {
      await started.promise; if (mode === "abort") value.controller.abort();
      await Promise.resolve(); await Promise.resolve();
      expect(returned).toBeFalse(); gate.resolve();
      expect(await result).toMatchObject({ code: mode === "abort" ? "aborted" : "native_unproved", cleanup: "joined" });
      expect(value.owned).toHaveLength(1); expect(value.owned[0]?.terminated).toBeGreaterThan(0); cleared(value);
    } finally { gate.resolve(); await result; }
  }
});

test("out-of-window elapsed times always refuse despite otherwise successful fixture output", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5000, max: 1_000_000 }), async (elapsedMs) => {
    const value = fixture({ patch: { elapsedMs } });
    await expect(collectCredentialFreeClaudeMacosPreflight(value.request, value.ports)).rejects.toMatchObject({ code: "native_unproved", cleanup: "joined" });
    cleared(value);
  }), { numRuns: 25 });
});
