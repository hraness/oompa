import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalSha256,
  createKnowledgeGraphRecordV1,
} from "@hraness/oh";
import {
  OhSqliteStore,
  applyOhSqliteMigrations,
  createOhSqliteStoreAuthorityV1,
} from "@hraness/oh/sqlite";
import { OH_CANONICAL_STORE_PROFILE_V1, type OhHeadV1 } from "@hraness/oh/store";

import type {
  OompaMemoryRememberInput,
} from "../domain/host-tools";
import {
  createPortableProjectMemoryCanonicalIdentity,
  deriveProjectMemoryCanonicalIdentity,
  OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES,
  legacyProjectMemorySpaceId,
  PROJECT_MEMORY_EMPTY_HEAD,
} from "../domain/project-memory";
import { FactsMemoryControlStore } from "../storage/facts-memory-control";
import { LocalFactsMemoryBroker } from "../storage/local-facts-memory-broker";
import {
  digestOhHead,
  OhSqliteFactsMemoryEngine,
} from "../storage/oh-facts-memory-engine";
import {
  initializeStatePaths,
  resolveStatePaths,
  type StatePaths,
} from "../storage/paths";
import { StateStore, type ProjectRecord, type SessionRecord } from "../storage/state-store";
import {
  OompaFactsMemoryLifecycle,
  type OompaFactsMemoryLifecyclePort,
} from "./facts-memory-lifecycle";
import {
  OompaMemoryRefusalError,
  OompaOhMemoryCoordinator,
} from "./memory-coordinator";
import type { OompaCanonicalMemorySyncPort } from "./canonical-memory-sync";

type Clock = {
  monotonic: number;
  wall: number;
};

type Runtime = Readonly<{
  control: FactsMemoryControlStore;
  coordinator: OompaOhMemoryCoordinator;
  engine: OhSqliteFactsMemoryEngine;
  lifecycle: OompaFactsMemoryLifecycle;
  store: StateStore;
}>;

const roots: string[] = [];
const runtimes: Runtime[] = [];
const ownedCaseJoins: Promise<void>[] = [];

afterEach(async () => {
  for (const joined of ownedCaseJoins.splice(0)) await joined;
  for (const runtime of runtimes.splice(0).reverse()) {
    await runtime.coordinator.close().catch(() => undefined);
    try {
      runtime.control.close();
    } catch {
      // A restart test may already have closed this exact handle.
    }
    try {
      runtime.store.close();
    } catch {
      // A restart test may already have closed this exact handle.
    }
  }
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

class FailPostCommitSettlementOnce implements OompaFactsMemoryLifecyclePort {
  #failEnsureAfterResume = false;
  #failResume = true;

  constructor(readonly delegate: OompaFactsMemoryLifecyclePort) {}

  transferSessionOwner(input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0]) {
    return this.delegate.transferSessionOwner(input);
  }

  cleanupSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  ensureSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#failEnsureAfterResume) {
      this.#failEnsureAfterResume = false;
      return Promise.reject(new Error("CONTROLLED_RESTART_BOUNDARY"));
    }
    return this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<OompaFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    if (this.#failResume) {
      this.#failResume = false;
      this.#failEnsureAfterResume = true;
      return Promise.reject(new Error("CONTROLLED_POST_COMMIT_SETTLEMENT_FAILURE"));
    }
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<OompaFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

class GateFirstEnsure implements OompaFactsMemoryLifecyclePort {
  readonly entered: Promise<void>;
  #enter!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;
  #remaining: number;
  #waiting = true;

  constructor(
    readonly delegate: OompaFactsMemoryLifecyclePort,
    blockOnCall = 1,
    readonly afterEnsure = false,
  ) {
    this.#remaining = blockOnCall;
    this.entered = new Promise((resolve) => { this.#enter = resolve; });
    this.#released = new Promise((resolve) => { this.#release = resolve; });
  }

  release(): void {
    this.#release();
  }

  transferSessionOwner(input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0]) {
    return this.delegate.transferSessionOwner(input);
  }

  cleanupSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  async ensureSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#remaining > 1) {
      this.#remaining -= 1;
      return await this.delegate.ensureSession(input);
    }
    if (this.#waiting) {
      this.#waiting = false;
      this.#remaining = 0;
      const receipt = this.afterEnsure
        ? await this.delegate.ensureSession(input)
        : undefined;
      this.#enter();
      await this.#released;
      if (receipt !== undefined) return receipt;
    }
    return await this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<OompaFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<OompaFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

class FailArmedEnsureOnce implements OompaFactsMemoryLifecyclePort {
  #armed = false;

  constructor(readonly delegate: OompaFactsMemoryLifecyclePort) {}

  transferSessionOwner(input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0]) {
    return this.delegate.transferSessionOwner(input);
  }

  arm(): void {
    this.#armed = true;
  }

  cleanupSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0],
  ) {
    return this.delegate.cleanupSession(input);
  }

  ensureSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0],
  ) {
    if (this.#armed) {
      this.#armed = false;
      return Promise.reject(new Error("CONTROLLED_SHARE_RECOVERY_BOUNDARY"));
    }
    return this.delegate.ensureSession(input);
  }

  forkSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["forkSession"]>[0],
  ) {
    return this.delegate.forkSession(input);
  }

  readSession(
    sessionId: Parameters<OompaFactsMemoryLifecyclePort["readSession"]>[0],
  ) {
    return this.delegate.readSession(sessionId);
  }

  resumeSession(
    input: Parameters<OompaFactsMemoryLifecyclePort["resumeSession"]>[0],
  ) {
    return this.delegate.resumeSession(input);
  }

  sweepExpired(
    ...input: Parameters<OompaFactsMemoryLifecyclePort["sweepExpired"]>
  ) {
    return this.delegate.sweepExpired(...input);
  }
}

const makeRuntime = (
  paths: StatePaths,
  clock: Clock,
  wrapLifecycle?: (
    lifecycle: OompaFactsMemoryLifecycle,
  ) => OompaFactsMemoryLifecyclePort,
  sync?: OompaCanonicalMemorySyncPort,
): Runtime => {
  const now = () => clock.wall++;
  const store = new StateStore(paths, { now });
  const control = new FactsMemoryControlStore(paths.factsMemoryControl, { now });
  const engine = new OhSqliteFactsMemoryEngine({ forkAttestations: store, now });
  const broker = new LocalFactsMemoryBroker({
    engine,
    now,
    root: paths.factsMemorySessions,
  });
  const lifecycle = new OompaFactsMemoryLifecycle({
    attestations: store,
    broker,
    control,
  });
  const coordinator = new OompaOhMemoryCoordinator({
    continuationKey: new Uint8Array(32).fill(17),
    engine,
    factsMemory: wrapLifecycle?.(lifecycle) ?? lifecycle,
    monotonicNow: () => clock.monotonic,
    now,
    paths,
    store,
    ...(sync === undefined ? {} : { sync }),
  });
  const runtime = { control, coordinator, engine, lifecycle, store };
  runtimes.push(runtime);
  return runtime;
};

const failNextAdoptedShareSettlement = (
  runtime: Runtime,
  recoveryBoundary: FailArmedEnsureOnce,
): void => {
  const originalSettle = runtime.store.settleMemorySubmission.bind(runtime.store);
  let failShareSettlement = true;
  Object.defineProperty(runtime.store, "settleMemorySubmission", {
    configurable: true,
    value: (settlement: Parameters<StateStore["settleMemorySubmission"]>[0]) => {
      if (
        failShareSettlement
        && settlement.state === "applied"
        && settlement.outcomeCode === "share_adopted"
      ) {
        failShareSettlement = false;
        recoveryBoundary.arm();
        throw new Error("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");
      }
      return originalSettle(settlement);
    },
  });
};

const createFixture = async (wrapLifecycle?: (
  lifecycle: OompaFactsMemoryLifecycle,
) => OompaFactsMemoryLifecyclePort, sync?: OompaCanonicalMemorySyncPort) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-memory-coordinator-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock: Clock = {
    monotonic: 25_000,
    wall: Date.parse("2026-09-04T12:00:00.000Z"),
  };
  const runtime = makeRuntime(paths, clock, wrapLifecycle, sync);
  const profile = runtime.store.createProfile("Memory owner");
  const generation = runtime.store.nextProfileGeneration(profile.id);
  expect(runtime.store.setProfileState(
    generation.id,
    generation.processGeneration,
    "signed_in",
    { email: "memory-owner@example.com", plan: "Plus" },
  )).toBe(true);
  const firstRoot = join(home, "first-project");
  const secondRoot = join(home, "second-project");
  await Promise.all([
    mkdir(firstRoot, { recursive: true }),
    mkdir(secondRoot, { recursive: true }),
  ]);
  const firstProject = await runtime.store.createProject("First project", firstRoot, true);
  const secondProject = await runtime.store.createProject("Second project", secondRoot);
  const session = (project: ProjectRecord, title: string): SessionRecord =>
    runtime.store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      projectId: project.id,
      title,
    });
  return {
    clock,
    firstProject,
    paths,
    profile,
    runtime,
    secondProject,
    session,
  };
};

function ownedMemoryCoordinatorTask<T>(run: () => Promise<T>): Promise<T> {
  // Register ownership before setup or proof starts. Every request in these
  // cases is awaited, so teardown joins the raw task before closing storage,
  // including work that settles after a hook or test deadline.
  const task = Promise.resolve().then(run);
  ownedCaseJoins.push(Promise.allSettled([task]).then(() => undefined));
  // Return the observed task itself so a timed-out hook cannot leave an
  // additional async wrapper with an unhandled late rejection.
  return task;
}

function ownedMemoryCoordinatorCase(
  runCase: (value: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
): Promise<void> {
  return ownedMemoryCoordinatorTask(async () => await runCase(await createFixture()));
}

const operationInput = (index: number, label: string) => ({
  idempotencyKey: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  requestDigest: canonicalSha256({ index, label, v: 1 }),
});

const page = (overrides: Partial<OompaMemoryRememberInput> = {}): OompaMemoryRememberInput => ({
  body: "The project owner serializes canonical memory updates and fails closed on conflicts.",
  key: "architecture/canonical-owner",
  language: "en",
  summary: "Alpha durable canonical ownership",
  title: "Alpha memory authority",
  ...overrides,
});

const expectRefusal = async (
  operation: Promise<unknown>,
  code: OompaMemoryRefusalError["code"],
) => {
  try {
    await operation;
    throw new Error("Expected memory operation to be refused.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OompaMemoryRefusalError);
    expect((error as OompaMemoryRefusalError).code).toBe(code);
  }
};

describe("Oompa Oh memory coordinator integration", () => {
  test("keeps working memory usable when hosted recovery cannot reach cloud at boot", async () => {
    let foregroundRecoverCalls = 0;
    let backgroundStarts = 0;
    const sync: OompaCanonicalMemorySyncPort = {
      attachHostedSpace: async () => { throw new Error("UNUSED_ATTACH"); },
      close: async () => undefined,
      createHostedSpace: async () => { throw new Error("UNUSED_CREATE"); },
      detachHostedSpace: async () => { throw new Error("UNUSED_DETACH"); },
      listHostedSpaces: async () => [],
      recover: async () => {
        foregroundRecoverCalls += 1;
        throw new Error("TEST_CLOUD_OFFLINE");
      },
      scheduleProject: () => undefined,
      startBackgroundRecovery: () => { backgroundStarts += 1; },
      synchronizeProject: async () => { throw new Error("UNUSED_SYNC"); },
    };
    const value = await createFixture(undefined, sync);

    await expect(value.runtime.coordinator.recover()).resolves.toBeUndefined();
    expect(backgroundStarts).toBe(1);
    expect(foregroundRecoverCalls).toBe(0);
    const actor = value.session(value.firstProject, "Offline hosted recovery working memory");
    const remembered = page({ key: "offline/working-memory" });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(220, "offline-hosted-recovery-remember"),
      value: remembered,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { key: remembered.key, mode: "get", scope: "working" },
    })).resolves.toMatchObject({
      canonical: { included: false },
      rows: [expect.objectContaining({ key: remembered.key, lane: "working" })],
    });
  });

  test("keeps terminal sessions metadata-only instead of resurrecting working memory", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Terminal memory refusal");
    value.runtime.store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "terminal",
    });

    await expect(value.runtime.coordinator.status({ actorSessionId: actor.id }))
      .resolves.toMatchObject({
        canonical: { initialized: false },
        projectId: value.firstProject.id,
        sessionId: actor.id,
        working: { state: "missing" },
      });
    await expectRefusal(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(200, "terminal-remember-refusal"),
      value: page({ key: "terminal/refused" }),
    }), "MEMORY_SESSION_REFUSED");
    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_SESSION_REFUSED");
    await expectRefusal(value.runtime.coordinator.explain({
      actorSessionId: actor.id,
      value: { queryId: `memq_${"1".repeat(32)}`, row: 0 },
    }), "MEMORY_SESSION_REFUSED");
    await expectRefusal(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...operationInput(201, "terminal-share-refusal"),
      value: { key: "terminal/refused", reason: "must remain retired" },
    }), "MEMORY_SESSION_REFUSED");

    expect(value.runtime.lifecycle.readSession(actor.id)).toBeNull();
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
    expect(value.runtime.store.readUnsettledMemorySubmissionForProject(value.firstProject.id))
      .toBeNull();
  });

  describe("coupled project memory proof", () => {
    let fixture: ReturnType<typeof createFixture> | undefined;
    beforeEach(() => {
      // Real database preparation has its own bounded phase; the complete
      // remember/query/share/conflict proof retains one five-second deadline.
      fixture = ownedMemoryCoordinatorTask(() => createFixture());
      return fixture;
    }, 5_000);

    test("remembers, queries, explains, shares by project, and never overwrites a conflict", () => {
      const setup = fixture;
      if (setup === undefined) throw new Error("Owned memory fixture is not ready.");
      return ownedMemoryCoordinatorTask(async () => {
        const value = await setup;
        const author = value.session(value.firstProject, "Author");
        const peer = value.session(value.firstProject, "Project peer");
        const outsider = value.session(value.secondProject, "Other project");
        const memory = page();

        const remembered = await value.runtime.coordinator.remember({
          actorSessionId: author.id,
          ...operationInput(1, "remember-alpha"),
          value: memory,
        });
        expect(remembered).toMatchObject({
          ok: true,
          replay: false,
          submission: { kind: "remember", state: "applied" },
          page: { key: memory.key },
        });

        const listed = await value.runtime.coordinator.query({
          actorSessionId: author.id,
          value: { mode: "list" },
        }) as { queryId: string; rows: readonly Record<string, unknown>[] };
        expect(listed.rows).toEqual([
          expect.objectContaining({
            key: memory.key,
            lane: "working",
            provenance: expect.objectContaining({ verification: "local-ledger-verified" }),
          }),
        ]);
        await expect(value.runtime.coordinator.explain({
          actorSessionId: author.id,
          value: { queryId: listed.queryId, row: 0 },
        })).resolves.toMatchObject({
          ok: true,
          queryId: listed.queryId,
          row: 0,
          explanation: expect.objectContaining({ resultSha256: expect.any(String) }),
        });

        await expect(value.runtime.coordinator.query({
          actorSessionId: author.id,
          value: { key: memory.key, mode: "get" },
        })).resolves.toMatchObject({
          ok: true,
          mode: "get",
          rows: [expect.objectContaining({
            bodyChunk: memory.body,
            key: memory.key,
            lane: "working",
          })],
        });
        await expect(value.runtime.coordinator.query({
          actorSessionId: author.id,
          value: { mode: "search", text: "alpha durable" },
        })).resolves.toMatchObject({
          ok: true,
          matchedTokens: ["alpha", "durable"],
          rows: [expect.objectContaining({ key: memory.key, lane: "working" })],
        });

        const shared = await value.runtime.coordinator.share({
          actorSessionId: author.id,
          ...operationInput(2, "share-alpha"),
          value: { key: memory.key, reason: "Project-level architectural invariant" },
        }) as { share: { recordSha256: string } };
        expect(shared).toMatchObject({
          ok: true,
          replay: false,
          share: { key: memory.key, status: "adopted" },
          submission: { kind: "share", state: "applied" },
        });

        await expect(value.runtime.coordinator.query({
          actorSessionId: peer.id,
          value: { key: memory.key, mode: "get" },
        })).resolves.toMatchObject({
          ok: true,
          rows: [expect.objectContaining({
            bodyChunk: memory.body,
            key: memory.key,
            lane: "canonical",
          })],
        });
        await expect(value.runtime.coordinator.query({
          actorSessionId: outsider.id,
          value: { key: memory.key, mode: "get" },
        })).resolves.toMatchObject({ ok: true, rows: [] });

        const conflicting = page({
          body: "A peer proposed a different owner, which must not replace canonical memory implicitly.",
          summary: "Conflicting beta ownership",
          title: "Beta memory authority",
        });
        const peerRemembered = await value.runtime.coordinator.remember({
          actorSessionId: peer.id,
          ...operationInput(3, "remember-conflict"),
          value: conflicting,
        }) as { page: { recordSha256: string } };
        const conflict = await value.runtime.coordinator.share({
          actorSessionId: peer.id,
          ...operationInput(4, "share-conflict"),
          value: { key: conflicting.key, reason: "Attempted implicit replacement" },
        });
        expect(conflict).toMatchObject({
          code: "MEMORY_SHARE_CONFLICT",
          ok: false,
          conflict: {
            canonicalRecordSha256: shared.share.recordSha256,
            key: memory.key,
            nominatedRecordSha256: peerRemembered.page.recordSha256,
          },
          submission: { kind: "share", state: "failed" },
        });

        const freshPeer = value.session(value.firstProject, "Fresh project peer");
        await expect(value.runtime.coordinator.query({
          actorSessionId: freshPeer.id,
          value: { key: memory.key, mode: "get" },
        })).resolves.toMatchObject({
          rows: [expect.objectContaining({
            bodyChunk: memory.body,
            lane: "canonical",
            recordSha256: shared.share.recordSha256,
          })],
        });
      });
    }, 5_000);
  });

  test("durably refuses an oversized canonical share before changing its head", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Bounded canonical share");
    const memory = page({
      body: "x".repeat(OOMPA_CANONICAL_MEMORY_OPERATION_MAX_BYTES + 1),
      key: "architecture/oversized-canonical-share",
      summary: "This working page cannot fit one hosted canonical operation.",
      title: "Oversized canonical share",
    });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(5, "remember-oversized-share"),
      value: memory,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });
    const before = await value.runtime.coordinator.status({ actorSessionId: actor.id });
    const shareInput = {
      actorSessionId: actor.id,
      ...operationInput(6, "share-oversized-share"),
      value: { key: memory.key, reason: "Exercise the hosted operation ceiling." },
    } as const;

    await expect(value.runtime.coordinator.share(shareInput)).resolves.toMatchObject({
      code: "MEMORY_SHARE_TOO_LARGE",
      ok: false,
      replay: false,
      submission: { kind: "share", state: "failed" },
    });
    await expect(value.runtime.coordinator.share(shareInput)).resolves.toMatchObject({
      code: "MEMORY_SHARE_TOO_LARGE",
      ok: false,
      replay: true,
      submission: { kind: "share", state: "failed" },
    });
    await expect(value.runtime.coordinator.status({ actorSessionId: actor.id }))
      .resolves.toMatchObject({
        canonical: {
          expectedHead: (before as { canonical: { expectedHead: unknown } })
            .canonical.expectedHead,
        },
      });
  });

  test("recognizes an exact portable canonical proof without source-device attestations", async () => {
    const value = await createFixture();
    const author = value.session(value.firstProject, "Portable proof author");
    const receiver = value.session(value.firstProject, "Portable proof receiver");
    const memory = page({ key: "architecture/portable-proof" });
    await value.runtime.coordinator.remember({
      actorSessionId: author.id,
      ...operationInput(108, "remember-portable-proof"),
      value: memory,
    });
    const shared = await value.runtime.coordinator.share({
      actorSessionId: author.id,
      ...operationInput(109, "share-portable-proof"),
      value: { key: memory.key, reason: "Portable cross-device provenance" },
    }) as { share: { recordSha256: string } };
    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null || authority.head.operationSha256 === null) {
      throw new Error("Expected a nonempty canonical authority.");
    }
    expect(value.runtime.store.readCanonicalMemoryPortableAdoptionProof({
      operationSha256: authority.head.operationSha256,
      projectId: value.firstProject.id,
      sequence: authority.head.sequence,
    })).toMatchObject({ recordSha256: shared.share.recordSha256 });

    // Model the receiving device: portable proof remains, while the source
    // device's session-bound attestation rows do not cross the sync boundary.
    const writer = new Database(value.paths.database, { create: false, strict: true });
    try {
      writer.exec("PRAGMA foreign_keys=ON");
      writer.query("DELETE FROM memory_page_attestation_refs WHERE project_id=?")
        .run(value.firstProject.id);
      writer.query("DELETE FROM memory_page_attestations WHERE project_id=?")
        .run(value.firstProject.id);
    } finally {
      writer.close(false);
    }

    await expect(value.runtime.coordinator.query({
      actorSessionId: receiver.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: [expect.objectContaining({
        key: memory.key,
        lane: "canonical",
        provenance: expect.objectContaining({ verification: "local-ledger-verified" }),
        recordSha256: shared.share.recordSha256,
      })],
    });
  });

  test("fences canonical shares during hosted sync without blocking working memory", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Hosted sync fence");
    const memory = page({ key: "architecture/hosted-sync-fence" });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(101, "remember-before-hosted-sync"),
      value: memory,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });

    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null) throw new Error("Expected initialized canonical memory authority.");
    expect(authority).toMatchObject({
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: 2,
      physicalState: "initialized",
    });
    const genesisToken = canonicalSha256({
      projectId: value.firstProject.id,
      purpose: "hosted-sync-fence-genesis",
      v: 1,
    });
    value.runtime.store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: canonicalSha256({ account: "memory-owner@example.com", v: 1 }),
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: value.firstProject.id,
      remote: {
        genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: canonicalSha256({ genesisToken, purpose: "remote-head-proof", v: 1 }),
        headToken: genesisToken,
        keyVersion: 1,
        revision: 1,
      },
      remoteSpaceId: `memory_${"f".repeat(32)}`,
    });
    value.runtime.store.prepareCanonicalMemorySync({
      direction: "pull",
      ...operationInput(102, "prepare-hosted-pull"),
      localHeadToken: genesisToken,
      projectId: value.firstProject.id,
    });
    expect(value.runtime.store.isCanonicalMemoryMutationFenced(value.firstProject.id)).toBe(true);

    const shareOperation = operationInput(103, "share-during-hosted-sync");
    await expectRefusal(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...shareOperation,
      value: { key: memory.key, reason: "Must wait for the hosted exchange to settle." },
    }), "MEMORY_RECOVERY_REQUIRED");
    expect(value.runtime.store.readMemorySubmissionByIdempotencyKey(
      shareOperation.idempotencyKey,
    )).toBeNull();
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      head: PROJECT_MEMORY_EMPTY_HEAD,
      syncState: "local_only",
    });

    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ key: memory.key, lane: "working" })],
    });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(104, "remember-during-hosted-sync"),
      value: page({ key: "architecture/working-during-hosted-sync" }),
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.status({ actorSessionId: actor.id }))
      .resolves.toMatchObject({
        canonical: {
          expectedHead: {
            digest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
            operationSha256: null,
            sequence: 0,
          },
        },
      });
  });

  test("rechecks the hosted-sync fence before dispatching a crash-left prepared share", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Prepared share sync race");
    const memory = page({ key: "architecture/prepared-share-sync-race" });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(202, "remember-before-prepared-share-sync-race"),
      value: memory,
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });
    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    const lifecycle = value.runtime.lifecycle.readSession(actor.id);
    if (
      authority === null
      || lifecycle === null
      || lifecycle.head === null
      || lifecycle.handleHash === null
    ) {
      throw new Error("Expected initialized memory authorities.");
    }
    const shareInput = {
      actorSessionId: actor.id,
      ...operationInput(203, "prepared-share-before-hosted-sync"),
      value: { key: memory.key, reason: "Must remain prepared behind the sync fence." },
    } as const;
    const prepared = value.runtime.store.prepareMemorySubmission({
      actorSessionId: actor.id,
      contentDigest: canonicalSha256({ reason: shareInput.value.reason, v: 1 }),
      expectedHead: authority.head,
      idempotencyKey: shareInput.idempotencyKey,
      keyDigest: canonicalSha256({ key: memory.key, v: 1 }),
      kind: "share",
      projectId: value.firstProject.id,
      requestDigest: shareInput.requestDigest,
      workingBindingDigest: lifecycle.bindingDigest,
      workingEpoch: lifecycle.epoch,
    }).record;
    const originalFence = value.runtime.store.isCanonicalMemoryMutationFenced.bind(
      value.runtime.store,
    );
    let lateFenceChecks = 0;
    Object.defineProperty(value.runtime.store, "isCanonicalMemoryMutationFenced", {
      configurable: true,
      value: (projectId: Parameters<StateStore["isCanonicalMemoryMutationFenced"]>[0]) => {
        lateFenceChecks += 1;
        expect(projectId).toBe(value.firstProject.id);
        return true;
      },
    });

    try {
      await expectRefusal(
        value.runtime.coordinator.share(shareInput),
        "MEMORY_RECOVERY_REQUIRED",
      );
    } finally {
      Object.defineProperty(value.runtime.store, "isCanonicalMemoryMutationFenced", {
        configurable: true,
        value: originalFence,
      });
    }
    expect(lateFenceChecks).toBe(1);
    const refusedSubmission = value.runtime.store.requireMemorySubmission(prepared.id);
    expect(refusedSubmission).toMatchObject({ state: "prepared" });
    expect(refusedSubmission).not.toHaveProperty("effectRecordSha256");
    expect(refusedSubmission).not.toHaveProperty("nominationSha256");
    expect(refusedSubmission).not.toHaveProperty("operationId");

    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: authority.canonicalSpaceId,
      identityContract: authority.identityContract,
      projectId: authority.projectId,
    });
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    try {
      expect(await canonical.store.head()).toMatchObject({
        operationSha256: null,
        sequence: 0,
      });
    } finally {
      await canonical.store.close();
    }
  });

  test("requires a fresh converged hosted head for each canonical share", async () => {
    const sync: OompaCanonicalMemorySyncPort = {
      attachHostedSpace: async () => { throw new Error("UNUSED_ATTACH"); },
      close: async () => undefined,
      createHostedSpace: async () => { throw new Error("UNUSED_CREATE"); },
      detachHostedSpace: async () => { throw new Error("UNUSED_DETACH"); },
      listHostedSpaces: async () => [],
      recover: async () => undefined,
      scheduleProject: () => undefined,
      startBackgroundRecovery: () => undefined,
      synchronizeProject: async (input) => ({
        attached: true,
        complete: true,
        localHead: null,
        operations: 0,
        projectId: input.projectId,
        remoteHead: null,
        state: "converged",
      }),
    };
    const value = await createFixture(undefined, sync);
    const actor = value.session(value.firstProject, "Hosted share convergence race");
    const first = page({ key: "architecture/first-hosted-share" });
    const second = page({ key: "architecture/second-hosted-share" });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(204, "remember-first-hosted-share"),
      value: first,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(205, "remember-second-hosted-share"),
      value: second,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });

    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null) throw new Error("Expected initialized canonical memory authority.");
    const genesisToken = canonicalSha256({
      projectId: value.firstProject.id,
      purpose: "hosted-share-convergence-race-genesis",
      v: 1,
    });
    value.runtime.store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: canonicalSha256({ account: "memory-owner@example.com", v: 1 }),
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: value.firstProject.id,
      remote: {
        genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: canonicalSha256({ genesisToken, purpose: "remote-head-proof", v: 1 }),
        headToken: genesisToken,
        keyVersion: 1,
        revision: 1,
      },
      remoteSpaceId: `memory_${"d".repeat(32)}`,
    });
    value.runtime.store.recordProjectMemorySyncObservation({
      exchangeHead: authority.head,
      expectedHead: authority.head,
      expectedRevision: authority.revision,
      projectId: value.firstProject.id,
      state: "settled",
    });

    await expect(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...operationInput(206, "first-share-after-hosted-sync"),
      value: { key: first.key, reason: "The first share owns the fresh hosted head." },
    })).resolves.toMatchObject({ ok: true, share: { status: "adopted" } });
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      syncState: "local_only",
    });

    const secondShare = operationInput(207, "second-share-after-stale-hosted-sync");
    await expectRefusal(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...secondShare,
      value: { key: second.key, reason: "This share needs another hosted pre-sync." },
    }), "MEMORY_RECOVERY_REQUIRED");
    expect(value.runtime.store.readMemorySubmissionByIdempotencyKey(
      secondShare.idempotencyKey,
    )).toBeNull();
  });

  test("refuses an attached canonical mutation when hosted sync is unavailable", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Hosted sync unavailable");
    const memory = page({ key: "architecture/hosted-sync-required" });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(208, "remember-before-hosted-sync-unavailable"),
      value: memory,
    });
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });
    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null) throw new Error("Expected initialized canonical memory authority.");
    const genesisToken = canonicalSha256({
      projectId: value.firstProject.id,
      purpose: "hosted-sync-unavailable-genesis",
      v: 1,
    });
    value.runtime.store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: canonicalSha256({ account: "memory-owner@example.com", v: 2 }),
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: value.firstProject.id,
      remote: {
        genesisToken,
        head: authority.head,
        headProofDigest: canonicalSha256({ genesisToken, purpose: "remote-head-proof", v: 2 }),
        headToken: genesisToken,
        keyVersion: 1,
        revision: 1,
      },
      remoteSpaceId: `memory_${"c".repeat(32)}`,
    });
    value.runtime.store.recordProjectMemorySyncObservation({
      exchangeHead: authority.head,
      expectedHead: authority.head,
      expectedRevision: authority.revision,
      projectId: value.firstProject.id,
      state: "settled",
    });

    const share = operationInput(209, "share-without-hosted-sync-capability");
    await expectRefusal(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...share,
      value: { key: memory.key, reason: "An attachment requires live sync authority." },
    }), "MEMORY_RECOVERY_REQUIRED");
    expect(value.runtime.store.readMemorySubmissionByIdempotencyKey(share.idempotencyKey))
      .toBeNull();
  });

  test("preserves sticky hosted conflict diagnostics when sync is unavailable", async () => {
    for (const [index, state] of (["conflict", "error"] as const).entries()) {
      const value = await createFixture();
      const actor = value.session(value.firstProject, `Hosted ${state} without sync`);
      const memory = page({ key: `architecture/hosted-${state}-without-sync` });
      await value.runtime.coordinator.remember({
        actorSessionId: actor.id,
        ...operationInput(210 + index * 3, `remember-before-hosted-${state}`),
        value: memory,
      });
      await value.runtime.coordinator.query({
        actorSessionId: actor.id,
        value: { mode: "list" },
      });
      const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
      if (authority === null) throw new Error("Expected initialized canonical memory authority.");
      const genesisToken = canonicalSha256({
        projectId: value.firstProject.id,
        purpose: `hosted-${state}-without-sync-genesis`,
        v: 1,
      });
      const attached = value.runtime.store.attachCanonicalMemoryHostedSpace({
        accountBindingDigest: canonicalSha256({ account: "memory-owner@example.com", state, v: 1 }),
        canonicalSpaceId: authority.canonicalSpaceId,
        projectId: value.firstProject.id,
        remote: {
          genesisToken,
          head: authority.head,
          headProofDigest: canonicalSha256({ genesisToken, purpose: "remote-head-proof", v: 3 }),
          headToken: genesisToken,
          keyVersion: 1,
          revision: 1,
        },
        remoteSpaceId: `memory_${state === "conflict" ? "a".repeat(32) : "b".repeat(32)}`,
      });
      value.runtime.store.failCanonicalMemoryHostedAttachment({
        diagnosticCode: state === "conflict"
          ? "REMOTE_MEMORY_ERASED"
          : "REMOTE_MEMORY_CONFIGURATION_INVALID",
        expectedGeneration: attached.generation,
        expectedRevision: attached.revision,
        projectId: value.firstProject.id,
        state,
      });

      const share = operationInput(211 + index * 3, `share-after-hosted-${state}`);
      await expectRefusal(value.runtime.coordinator.share({
        actorSessionId: actor.id,
        ...share,
        value: { key: memory.key, reason: "Sticky hosted failure remains canonical freeze." },
      }), "MEMORY_CANONICAL_FROZEN");
      expect(value.runtime.store.readMemorySubmissionByIdempotencyKey(share.idempotencyKey))
        .toBeNull();
    }
  });

  test("replays a terminal share without sync or Oh access while hosted custody is frozen", async () => {
    let syncCalls = 0;
    let syncUnavailable = false;
    const sync: OompaCanonicalMemorySyncPort = {
      attachHostedSpace: async () => { throw new Error("UNUSED_ATTACH"); },
      close: async () => undefined,
      createHostedSpace: async () => { throw new Error("UNUSED_CREATE"); },
      detachHostedSpace: async () => { throw new Error("UNUSED_DETACH"); },
      listHostedSpaces: async () => [],
      recover: async () => undefined,
      scheduleProject: () => undefined,
      startBackgroundRecovery: () => undefined,
      synchronizeProject: async (input) => {
        syncCalls += 1;
        if (syncUnavailable) throw new Error("HOSTED_SYNC_UNAVAILABLE");
        return {
          attached: false,
          complete: true,
          localHead: null,
          operations: 0,
          projectId: input.projectId,
          remoteHead: null,
          state: "detached",
        };
      },
    };
    const value = await createFixture(undefined, sync);
    const actor = value.session(value.firstProject, "Terminal share replay");
    const memory = page({ key: "architecture/terminal-hosted-share-replay" });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(216, "remember-before-terminal-hosted-replay"),
      value: memory,
    });
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });
    const shareInput = {
      actorSessionId: actor.id,
      ...operationInput(217, "terminal-hosted-share-replay"),
      value: { key: memory.key, reason: "Return the retained receipt without a new effect." },
    } as const;
    const original = await value.runtime.coordinator.share(shareInput);
    expect(original).toMatchObject({ ok: true, replay: false });

    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null) throw new Error("Expected initialized canonical memory authority.");
    const headToken = canonicalSha256({ head: authority.head, purpose: "terminal-replay", v: 1 });
    const attached = value.runtime.store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: canonicalSha256({ account: "terminal-replay@example.com", v: 1 }),
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: value.firstProject.id,
      remote: {
        genesisToken: canonicalSha256({ purpose: "terminal-replay-genesis", v: 1 }),
        head: authority.head,
        headProofDigest: canonicalSha256({ headToken, purpose: "terminal-replay-proof", v: 1 }),
        headToken,
        keyVersion: 1,
        revision: 1,
      },
      remoteSpaceId: `memory_${"9".repeat(32)}`,
    });
    value.runtime.store.failCanonicalMemoryHostedAttachment({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: value.firstProject.id,
      state: "conflict",
    });
    syncCalls = 0;
    syncUnavailable = true;
    let ohCalls = 0;
    const originalWithMemoryStores = value.runtime.engine.withMemoryStores
      .bind(value.runtime.engine);
    Object.defineProperty(value.runtime.engine, "withMemoryStores", {
      configurable: true,
      value: () => {
        ohCalls += 1;
        throw new Error("TERMINAL_REPLAY_MUST_NOT_OPEN_OH");
      },
    });

    try {
      await expect(value.runtime.coordinator.share(shareInput)).resolves.toEqual({
        ...original,
        replay: true,
      });
      await expect(value.runtime.coordinator.share({
        ...shareInput,
        value: { ...shareInput.value, reason: "Changed same-key request" },
      })).rejects.toThrow("MEMORY_SUBMISSION_IDEMPOTENCY_CONFLICT");
    } finally {
      Object.defineProperty(value.runtime.engine, "withMemoryStores", {
        configurable: true,
        value: originalWithMemoryStores,
      });
    }
    expect(syncCalls).toBe(0);
    expect(ohCalls).toBe(0);
  });

  test("refuses a share when its session changes projects during hosted pre-sync", async () => {
    let markSyncEntered!: () => void;
    const syncEntered = new Promise<void>((resolve) => { markSyncEntered = resolve; });
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    const synchronizedProjects: string[] = [];
    const sync: OompaCanonicalMemorySyncPort = {
      attachHostedSpace: async () => { throw new Error("UNUSED_ATTACH"); },
      close: async () => undefined,
      createHostedSpace: async () => { throw new Error("UNUSED_CREATE"); },
      detachHostedSpace: async () => { throw new Error("UNUSED_DETACH"); },
      listHostedSpaces: async () => [],
      recover: async () => undefined,
      scheduleProject: () => undefined,
      startBackgroundRecovery: () => undefined,
      synchronizeProject: async (input) => {
        synchronizedProjects.push(input.projectId);
        markSyncEntered();
        await syncGate;
        return {
          attached: false,
          complete: true,
          localHead: null,
          operations: 0,
          projectId: input.projectId,
          remoteHead: null,
          state: "detached",
        };
      },
    };
    const value = await createFixture(undefined, sync);
    const actor = value.session(value.firstProject, "Hosted pre-sync project race");
    value.runtime.store.setSessionTurnState({
      expectedRevision: actor.revision,
      sessionId: actor.id,
      state: "idle",
    });
    const memory = page({ key: "architecture/hosted-presync-project-race" });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(218, "remember-before-hosted-presync-project-race"),
      value: memory,
    });
    const shareInput = operationInput(219, "share-during-hosted-presync-project-race");
    const refused = expectRefusal(value.runtime.coordinator.share({
      actorSessionId: actor.id,
      ...shareInput,
      value: { key: memory.key, reason: "The request remains bound to its pre-sync project." },
    }), "MEMORY_RECOVERY_REQUIRED");
    await syncEntered;
    const current = value.runtime.store.requireSession(actor.id);
    value.runtime.store.updateSessionMetadata({
      expectedRevision: current.revision,
      projectId: value.secondProject.id,
      sessionId: current.id,
    });
    releaseSync();

    await refused;
    expect(synchronizedProjects).toEqual([value.firstProject.id]);
    expect(value.runtime.store.readMemorySubmissionByIdempotencyKey(shareInput.idempotencyKey))
      .toBeNull();
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
    expect(value.runtime.store.readProjectMemoryAuthority(value.secondProject.id)).toBeNull();
  });

  test("keeps working memory available after an authorized pull import until settlement", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Authorized pull crash window");
    const existing = page({ key: "recovery/working-through-authorized-pull" });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(105, "remember-before-authorized-pull"),
      value: existing,
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });

    const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (authority === null) throw new Error("Expected initialized canonical memory authority.");
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: authority.canonicalSpaceId,
      identityContract: authority.identityContract,
      projectId: authority.projectId,
    });
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    const importedHead: OhHeadV1 = await (async () => {
      try {
        await canonical.store.commit({
          actorId: "hra.memory.host",
          changes: [{
            kind: "put",
            record: createKnowledgeGraphRecordV1({
              dependencies: [],
              key: "entity:authorized-pull-crash-window",
              kind: "entity",
              v: 1,
              value: { label: "Physically imported before control settlement" },
            }),
            v: 1,
          }],
          expectedHead: await canonical.store.head(),
          operationId: "test.authorized-pull-crash-window",
        });
        return await canonical.store.head();
      } finally {
        await canonical.store.close();
      }
    })();
    const resultHead = {
      headDigest: digestOhHead(importedHead),
      operationSha256: importedHead.operationSha256,
      sequence: importedHead.sequence,
    };
    const genesisToken = canonicalSha256({
      projectId: value.firstProject.id,
      purpose: "authorized-pull-genesis",
      v: 1,
    });
    const headToken = canonicalSha256({ resultHead, purpose: "authorized-pull-head", v: 1 });
    const remote = {
      genesisToken,
      head: resultHead,
      headProofDigest: canonicalSha256({ headToken, purpose: "authorized-pull-proof", v: 1 }),
      headToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    value.runtime.store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: canonicalSha256({ account: "authorized-pull-owner", v: 1 }),
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: value.firstProject.id,
      remote,
      remoteSpaceId: `memory_${"e".repeat(32)}`,
    });
    const prepared = value.runtime.store.prepareCanonicalMemorySync({
      direction: "pull",
      ...operationInput(106, "prepare-authorized-pull"),
      localHeadToken: genesisToken,
      projectId: value.firstProject.id,
    }).record;
    value.runtime.store.markCanonicalMemorySyncEffectStarted(prepared.id);
    const envelope = (ciphertext: string) => ({
      algorithm: "A256GCM" as const,
      ciphertext,
      keyVersion: 1,
      nonce: "N".repeat(16),
    });
    value.runtime.store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation: {
        adoptionProof: null,
        genesisToken,
        headToken,
        operation: envelope("o".repeat(22)),
        priorToken: genesisToken,
        sequence: resultHead.sequence,
        terminalHeadProof: envelope("p".repeat(22)),
      },
      remote,
    });
    value.runtime.store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead,
    });

    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { key: existing.key, mode: "get" },
    })).resolves.toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ key: existing.key, lane: "working" })],
    });
    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(107, "remember-during-authorized-pull-window"),
      value: page({ key: "recovery/working-after-authorized-import" }),
    })).resolves.toMatchObject({ ok: true });
    await expect(value.runtime.coordinator.status({ actorSessionId: actor.id }))
      .resolves.toMatchObject({
        canonical: {
          expectedHead: {
            digest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
            operationSha256: null,
            sequence: 0,
          },
          frozen: false,
        },
      });

    value.runtime.store.settleCanonicalMemorySync({
      intentId: prepared.id,
      resultHead,
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true });
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      head: resultHead,
      syncState: "settled",
    });
  });

  test("recovers exactly after Oh committed remember but Oompa settlement lost its response", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Crash recovery");

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    const failing = makeRuntime(
      value.paths,
      value.clock,
      (lifecycle) => new FailPostCommitSettlementOnce(lifecycle),
    );
    const input = {
      actorSessionId: actor.id,
      ...operationInput(10, "remember-crash-window"),
      value: page({ key: "recovery/exact-window", title: "Exact recovery window" }),
    } as const;

    await expect(failing.coordinator.remember(input))
      .rejects.toThrow("CONTROLLED_POST_COMMIT_SETTLEMENT_FAILURE");
    expect(failing.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ kind: "remember", state: "ambiguous" });

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "remember_committed", state: "applied" });
    await expect(restarted.coordinator.remember(input)).resolves.toMatchObject({
      ok: true,
      replay: true,
      submission: { kind: "remember", state: "applied" },
    });
    await expect(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { key: input.value.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: [expect.objectContaining({
        bodyChunk: input.value.body,
        key: input.value.key,
        provenance: expect.objectContaining({ verification: "local-ledger-verified" }),
      })],
    });
  });

  test("recovers an exact canonical adoption without quarantining it as out-of-band", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Share crash recovery");
    const memory = page({
      key: "recovery/exact-share-window",
      title: "Exact share recovery window",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(11, "remember-before-share-crash"),
      value: memory,
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let recoveryBoundary: FailArmedEnsureOnce | undefined;
    const failing = makeRuntime(value.paths, value.clock, (lifecycle) => {
      recoveryBoundary = new FailArmedEnsureOnce(lifecycle);
      return recoveryBoundary;
    });
    if (recoveryBoundary === undefined) throw new Error("Expected a share recovery boundary.");
    failNextAdoptedShareSettlement(failing, recoveryBoundary);
    const input = {
      actorSessionId: actor.id,
      ...operationInput(12, "share-crash-window"),
      value: { key: memory.key, reason: "Exact post-adoption recovery proof" },
    } as const;

    await expect(failing.coordinator.share(input))
      .rejects.toThrow("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");
    expect(failing.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ kind: "share", state: "ambiguous" });

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "share_adopted", state: "applied" });
    const recoveredAuthority = restarted.store.readProjectMemoryAuthority(value.firstProject.id);
    expect(recoveredAuthority).toMatchObject({ syncState: "local_only" });
    expect(recoveredAuthority?.diagnosticCode).toBeUndefined();
    await expect(restarted.coordinator.share(input)).resolves.toMatchObject({
      ok: true,
      replay: true,
      share: { key: memory.key, status: "adopted" },
      submission: { kind: "share", state: "applied" },
    });
    await expect(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { key: memory.key, mode: "get" },
    })).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({
        bodyChunk: memory.body,
        key: memory.key,
        lane: "canonical",
      })]),
    });
  });

  test("keeps a recovered adoption frozen when a later canonical operation is unexplained", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Share divergence recovery");
    const memory = page({
      key: "recovery/share-followed-by-divergence",
      title: "Share followed by divergence",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(13, "remember-before-share-divergence"),
      value: memory,
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let recoveryBoundary: FailArmedEnsureOnce | undefined;
    const failing = makeRuntime(value.paths, value.clock, (lifecycle) => {
      recoveryBoundary = new FailArmedEnsureOnce(lifecycle);
      return recoveryBoundary;
    });
    if (recoveryBoundary === undefined) throw new Error("Expected a share recovery boundary.");
    failNextAdoptedShareSettlement(failing, recoveryBoundary);
    const input = {
      actorSessionId: actor.id,
      ...operationInput(14, "share-before-divergence"),
      value: { key: memory.key, reason: "Prove recovery stays closed past the exact effect" },
    } as const;
    await expect(failing.coordinator.share(input))
      .rejects.toThrow("CONTROLLED_POST_ADOPTION_SETTLEMENT_FAILURE");

    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const control = failing.store.readProjectMemoryAuthority(value.firstProject.id);
    if (control === null) throw new Error("Expected a reserved canonical authority.");
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: control.canonicalSpaceId,
      identityContract: control.identityContract,
      projectId: control.projectId,
    });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    try {
      await canonical.store.commit({
        actorId: "test.out-of-band-after-adoption",
        changes: [{
          kind: "put",
          record: createKnowledgeGraphRecordV1({
            dependencies: [],
            key: "entity:post-adoption-divergence",
            kind: "entity",
            v: 1,
            value: { label: "Unexplained operation after the recoverable adoption" },
          }),
          v: 1,
        }],
        expectedHead: await canonical.store.head(),
        operationId: "test.post-adoption-canonical-divergence",
      });
    } finally {
      await canonical.store.close();
    }

    await failing.coordinator.close();
    failing.control.close();
    failing.store.close();
    const restarted = makeRuntime(value.paths, value.clock);
    await restarted.coordinator.recover();
    expect(restarted.store.readMemorySubmissionByIdempotencyKey(input.idempotencyKey))
      .toMatchObject({ outcomeCode: "share_adopted", state: "applied" });
    expect(restarted.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      syncState: "error",
    });
    await expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
  });

  test("refuses a materialized get continuation after its working head changes", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Continuation owner");
    const large = page({
      body: "a".repeat(13 * 1_024),
      key: "continuations/large-page",
      title: "Large continuation page",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(20, "remember-large"),
      value: large,
    });
    const first = await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { key: large.key, mode: "get" },
    }) as { continuation: string | null; rows: readonly unknown[] };
    expect(first.rows).toHaveLength(2);
    if (first.continuation === null) throw new Error("Expected a get continuation.");

    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(21, "remember-head-change"),
      value: page({ key: "continuations/head-change", title: "Head change" }),
    });
    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: {
        continuation: first.continuation,
        key: large.key,
        mode: "get",
      },
    }), "MEMORY_CONTINUATION_REFUSED");
  });

  test("durably freezes a project when its canonical Oh head advances out of band", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Canonical custody");
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });

    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const control = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
    if (control === null) throw new Error("Expected a reserved canonical authority.");
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: control.canonicalSpaceId,
      identityContract: control.identityContract,
      projectId: control.projectId,
    });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    try {
      await canonical.store.commit({
        actorId: "test.out-of-band-writer",
        changes: [{
          kind: "put",
          record: createKnowledgeGraphRecordV1({
            dependencies: [],
            key: "entity:out-of-band",
            kind: "entity",
            v: 1,
            value: { label: "Uncoordinated canonical mutation" },
          }),
          v: 1,
        }],
        expectedHead: await canonical.store.head(),
        operationId: "test.out-of-band-canonical-mutation",
      });
    } finally {
      await canonical.store.close();
    }

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      syncState: "error",
    });
    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
  });

  test("durably freezes a canonical database containing a second Oh space", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Canonical space custody");
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });

    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const alien = createOhSqliteStoreAuthorityV1({
      path: join(value.paths.projectMemory, projectDigest, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: "hra:project-memory:space-alien",
      spaceId: "hra:project:space-alien",
    });
    await alien.store.close();

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      syncState: "error",
    });
  });

  test.each(["zero-byte", "migrated", "space-created", "bound"] as const)(
    "adopts every exact empty crash-left legacy stage before creating a portable identity: %s",
    (stage) => ownedMemoryCoordinatorCase(async (value) => {
      const actor = value.session(value.firstProject, `Legacy ${stage} recovery`);
      const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
      const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
      const databasePath = join(canonicalDirectory, "oh.sqlite");
      await mkdir(canonicalDirectory, { mode: 0o700 });
      const identity = deriveProjectMemoryCanonicalIdentity({
        canonicalSpaceId: legacyProjectMemorySpaceId(value.firstProject.id),
        identityContract: 1,
        projectId: value.firstProject.id,
      });
      if (stage === "zero-byte") {
        await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });
      } else if (stage === "migrated") {
        const database = new Database(databasePath);
        try {
          applyOhSqliteMigrations(database);
        } finally {
          database.close(false);
        }
      } else if (stage === "space-created") {
        const interrupted = new OhSqliteStore({
          path: databasePath,
          spaceId: identity.canonicalSpaceId,
        });
        interrupted.close();
      } else {
        const bound = createOhSqliteStoreAuthorityV1({
          path: databasePath,
          profile: OH_CANONICAL_STORE_PROFILE_V1,
          realmId: identity.canonicalRealmId,
          spaceId: identity.canonicalSpaceId,
        });
        await bound.store.close();
      }

      await expect(value.runtime.coordinator.query({
        actorSessionId: actor.id,
        value: { mode: "list" },
      })).resolves.toMatchObject({ ok: true, rows: [] });

      const authority = value.runtime.store.readProjectMemoryAuthority(value.firstProject.id);
      expect(authority).toMatchObject({
        canonicalSpaceId: identity.canonicalSpaceId,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        identityContract: 1,
        physicalState: "initialized",
        revision: 2,
      });
      const status = await value.runtime.coordinator.status({ actorSessionId: actor.id });
      expect(status).toMatchObject({
        canonical: {
          identityContract: 1,
          initialized: true,
        },
      });
      expect((status.canonical as Record<string, unknown>).spaceId).toBeUndefined();
    }),
  );

  test.each(["absent", "zero-byte", "migrated", "space-created", "bound"] as const)(
    "resumes every exact empty stage after a portable authority reservation: %s",
    (stage) => ownedMemoryCoordinatorCase(async (value) => {
      const actor = value.session(value.firstProject, `Portable ${stage} recovery`);
      const identity = createPortableProjectMemoryCanonicalIdentity(value.firstProject.id);
      const reserved = value.runtime.store.reserveProjectMemoryAuthority({
        canonicalSpaceId: identity.canonicalSpaceId,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        identityContract: identity.identityContract,
        projectId: value.firstProject.id,
      });
      const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
      const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
      const databasePath = join(canonicalDirectory, "oh.sqlite");
      if (stage !== "absent") {
        await mkdir(canonicalDirectory, { mode: 0o700 });
        if (stage === "zero-byte") {
          await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });
        } else if (stage === "migrated") {
          const database = new Database(databasePath);
          try {
            applyOhSqliteMigrations(database);
          } finally {
            database.close(false);
          }
        } else if (stage === "space-created") {
          const interrupted = new OhSqliteStore({
            path: databasePath,
            spaceId: identity.canonicalSpaceId,
          });
          interrupted.close();
        } else {
          const bound = createOhSqliteStoreAuthorityV1({
            path: databasePath,
            profile: OH_CANONICAL_STORE_PROFILE_V1,
            realmId: identity.canonicalRealmId,
            spaceId: identity.canonicalSpaceId,
          });
          await bound.store.close();
        }
      }

      await expect(value.runtime.coordinator.query({
        actorSessionId: actor.id,
        value: { mode: "list" },
      })).resolves.toMatchObject({ ok: true, rows: [] });
      expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
        canonicalSpaceId: reserved.canonicalSpaceId,
        identityContract: 2,
        physicalState: "initialized",
        revision: 2,
      });
    }),
  );

  test("durably rejects a nonempty store left behind after portable reservation", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Portable nonempty refusal");
    const identity = createPortableProjectMemoryCanonicalIdentity(value.firstProject.id);
    value.runtime.store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: identity.identityContract,
      projectId: value.firstProject.id,
    });
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
    await mkdir(canonicalDirectory, { mode: 0o700 });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(canonicalDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    await canonical.store.commit({
      actorId: "test.portable-crash",
      changes: [{
        kind: "put",
        record: createKnowledgeGraphRecordV1({
          dependencies: [],
          key: "entity:portable-nonempty",
          kind: "entity",
          v: 1,
          value: { label: "Must not be adopted by an empty reservation" },
        }),
        v: 1,
      }],
      expectedHead: await canonical.store.head(),
      operationId: "test.portable-crash-nonempty",
    });
    await canonical.store.close();

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      canonicalSpaceId: identity.canonicalSpaceId,
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: 2,
      physicalState: "rejected",
      syncState: "error",
    });
  });

  test("keeps working memory usable while a nonempty crash-left legacy database freezes canonical", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Legacy nonempty refusal");
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
    await mkdir(canonicalDirectory, { mode: 0o700 });
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(value.firstProject.id),
      identityContract: 1,
      projectId: value.firstProject.id,
    });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(canonicalDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    await canonical.store.commit({
      actorId: "test.legacy-crash",
      changes: [{
        kind: "put",
        record: createKnowledgeGraphRecordV1({
          dependencies: [],
          key: "entity:legacy-nonempty",
          kind: "entity",
          v: 1,
          value: { label: "Must not be adopted without control evidence" },
        }),
        v: 1,
      }],
      expectedHead: await canonical.store.head(),
      operationId: "test.legacy-crash-nonempty",
    });
    await canonical.store.close();

    await expect(value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(91, "legacy-nonempty-refusal"),
      value: page({ key: "legacy/refused-working-effect" }),
    })).resolves.toMatchObject({
      ok: true,
      workingHead: expect.objectContaining({ sequence: 1 }),
    });
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
    expect(value.runtime.lifecycle.readSession(actor.id)).toMatchObject({
      head: expect.objectContaining({ sequence: 1 }),
    });

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: 1,
      physicalState: "rejected",
      syncState: "error",
    });
    const working = await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list", scope: "working" },
    }) as {
      canonical: { frozen: boolean; included: boolean };
      canonicalHead: unknown;
      queryId: string;
      rows: readonly Readonly<Record<string, unknown>>[];
      scope: string;
    };
    expect(working).toMatchObject({
      canonical: { frozen: true, included: false },
      canonicalHead: null,
      rows: [expect.objectContaining({
        key: "legacy/refused-working-effect",
        lane: "working",
      })],
      scope: "working",
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: {
        key: "legacy/refused-working-effect",
        mode: "get",
        scope: "working",
      },
    })).resolves.toMatchObject({
      canonical: { frozen: true, included: false },
      rows: [expect.objectContaining({
        bodyChunk: expect.any(String),
        key: "legacy/refused-working-effect",
        lane: "working",
      })],
      scope: "working",
    });
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "search", scope: "working", text: "durable canonical" },
    })).resolves.toMatchObject({
      canonical: { frozen: true, included: false },
      matchedTokens: ["canonical", "durable"],
      rows: [expect.objectContaining({
        key: "legacy/refused-working-effect",
        lane: "working",
      })],
      scope: "working",
    });
    await expect(value.runtime.coordinator.explain({
      actorSessionId: actor.id,
      value: { queryId: working.queryId, row: 0 },
    })).resolves.toMatchObject({
      canonical: { frozen: true, included: false },
      scope: "working",
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    const databasePath = join(canonicalDirectory, "oh.sqlite");
    await rm(databasePath);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });
    const restarted = makeRuntime(value.paths, value.clock);
    await expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    await expect(restarted.coordinator.status({ actorSessionId: actor.id })).resolves.toMatchObject({
      canonical: {
        frozen: true,
        initialized: false,
        physicalState: "rejected",
      },
    });
    await expect(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list", scope: "working" },
    })).resolves.toMatchObject({
      canonical: { frozen: true, included: false },
      rows: [expect.objectContaining({ key: "legacy/refused-working-effect" })],
      scope: "working",
    });
    expect((await Bun.file(databasePath).arrayBuffer()).byteLength).toBe(0);
  });

  test("continues a working-only query against one deterministic ephemeral canonical authority", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Working-only continuation");
    for (let index = 0; index < 6; index += 1) {
      await expect(value.runtime.coordinator.remember({
        actorSessionId: actor.id,
        ...operationInput(300 + index, `remember-working-continuation-${String(index)}`),
        value: page({
          key: `working/continuation-${String(index)}`,
          title: `Working continuation ${String(index)}`,
        }),
      })).resolves.toMatchObject({ ok: true });
    }

    const first = await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list", scope: "working" },
    }) as { continuation: string | null; rows: readonly unknown[] };
    expect(first.rows).toHaveLength(5);
    if (first.continuation === null) throw new Error("Expected a working-only continuation.");
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { continuation: first.continuation, mode: "list", scope: "working" },
    })).resolves.toMatchObject({
      canonical: { included: false },
      continuation: null,
      rows: [expect.objectContaining({ lane: "working" })],
      scope: "working",
    });
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
  });

  test("durably rejects a head-empty legacy database with hidden same-space state", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Legacy hidden-state refusal");
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
    await mkdir(canonicalDirectory, { mode: 0o700 });
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(value.firstProject.id),
      identityContract: 1,
      projectId: value.firstProject.id,
    });
    const canonical = createOhSqliteStoreAuthorityV1({
      path: join(canonicalDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: identity.canonicalRealmId,
      spaceId: identity.canonicalSpaceId,
    });
    await canonical.store.close();
    const database = new Database(join(canonicalDirectory, "oh.sqlite"));
    try {
      database.query(
        `INSERT INTO oh_sync_state(
           remote_id,space_id,pulled_sequence,pushed_sequence,remote_head_sha256,updated_at
         ) VALUES ('hidden',?,0,0,NULL,'2026-09-06T00:00:00.000Z')`,
      ).run(identity.canonicalSpaceId);
    } finally {
      database.close(false);
    }

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: 1,
      physicalState: "rejected",
      syncState: "error",
    });
  });

  test("durably rejects an unsafe sidecar-only legacy remnant", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Legacy sidecar refusal");
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
    await mkdir(canonicalDirectory, { mode: 0o700 });
    await writeFile(join(canonicalDirectory, "oh.sqlite-wal"), new Uint8Array(), { mode: 0o600 });

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      identityContract: 1,
      physicalState: "rejected",
      syncState: "error",
    });
  });

  test("keeps an unavailable first inspection retryable without manufacturing an identity", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Retryable canonical inspection");
    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    const unavailablePaths: StatePaths = {
      ...value.paths,
      projectMemory: join(value.paths.root, "x".repeat(300)),
    };
    const unavailable = makeRuntime(unavailablePaths, value.clock);

    await expectRefusal(unavailable.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_RECOVERY_REQUIRED");
    expect(unavailable.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
  });

  test("keeps a raw SQLite lock retryable without freezing canonical memory", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Retryable canonical lock");
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const databasePath = join(value.paths.projectMemory, projectDigest, "oh.sqlite");
    const lock = new Database(databasePath, { create: false, strict: true });
    try {
      lock.exec("BEGIN IMMEDIATE");
      await expectRefusal(value.runtime.coordinator.query({
        actorSessionId: actor.id,
        value: { mode: "list" },
      }), "MEMORY_RECOVERY_REQUIRED");
      expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
        physicalState: "initialized",
        syncState: "local_only",
      });
    } finally {
      if (lock.inTransaction) lock.exec("ROLLBACK");
      lock.close(false);
    }
    await expect(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    })).resolves.toMatchObject({ ok: true, rows: [] });
  }, 12_000);

  test("never recreates a missing database after canonical initialization", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Initialized deletion fence");
    await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    });
    const projectDigest = canonicalSha256({ projectId: value.firstProject.id, v: 1 });
    const canonicalDirectory = join(value.paths.projectMemory, projectDigest);
    await rm(join(canonicalDirectory, "oh.sqlite"));
    await rm(join(canonicalDirectory, "oh.sqlite-wal"), { force: true });
    await rm(join(canonicalDirectory, "oh.sqlite-shm"), { force: true });

    await expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_CANONICAL_FROZEN");
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      physicalState: "initialized",
      syncState: "error",
    });
    await expect(Bun.file(join(canonicalDirectory, "oh.sqlite")).exists()).resolves.toBe(false);
  });

  test("refuses a terminalized actor after lifecycle selection without reopening purged memory", async () => {
    let gate: GateFirstEnsure | undefined;
    const value = await createFixture((lifecycle) => {
      gate = new GateFirstEnsure(lifecycle, 1, true);
      return gate;
    });
    const actor = value.session(value.firstProject, "Terminal lifecycle race");
    const refused = expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_SESSION_REFUSED");
    if (gate === undefined) throw new Error("Expected a lifecycle gate.");
    await gate.entered;

    const current = value.runtime.store.requireSession(actor.id);
    value.runtime.store.setSessionTurnState({
      expectedRevision: current.revision,
      sessionId: current.id,
      state: "terminal",
    });
    await value.runtime.lifecycle.cleanupSession({
      ownerId: current.profileId,
      reason: "archive",
      sessionId: current.id,
    });
    gate.release();

    await refused;
    expect(value.runtime.lifecycle.readSession(actor.id)).toMatchObject({ state: "purged" });
    expect(value.runtime.store.readProjectMemoryAuthority(value.firstProject.id)).toBeNull();
    expect(value.runtime.store.readUnsettledMemorySubmissionForSession(actor.id)).toBeNull();
  });

  test("refuses in-flight and queued operations when the session changes projects before authority selection", async () => {
    const value = await createFixture();
    const actor = value.session(value.firstProject, "Queued project change");
    value.runtime.store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });

    await value.runtime.coordinator.close();
    value.runtime.control.close();
    value.runtime.store.close();
    let gate: GateFirstEnsure | undefined;
    const restarted = makeRuntime(value.paths, value.clock, (lifecycle) => {
      gate = new GateFirstEnsure(lifecycle);
      return gate;
    });

    const firstRefusal = expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_RECOVERY_REQUIRED");
    if (gate === undefined) throw new Error("Expected a lifecycle gate.");
    await gate.entered;
    const queuedRefusal = expectRefusal(restarted.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_RECOVERY_REQUIRED");

    const current = restarted.store.requireSession(actor.id);
    restarted.store.updateSessionMetadata({
      sessionId: current.id,
      expectedRevision: current.revision,
      projectId: value.secondProject.id,
    });
    gate.release();

    await firstRefusal;
    await queuedRefusal;
    expect(restarted.store.readProjectMemoryAuthority(value.secondProject.id)).toBeNull();
  });

  test("never explains a cached row after a queued session project change", async () => {
    let gate: GateFirstEnsure | undefined;
    const value = await createFixture((lifecycle) => {
      gate = new GateFirstEnsure(lifecycle, 3);
      return gate;
    });
    const actor = value.session(value.firstProject, "Queued explanation scope");
    value.runtime.store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });
    await value.runtime.coordinator.remember({
      actorSessionId: actor.id,
      ...operationInput(101, "explain-project-race-remember"),
      value: page({ key: "scope/explain-project-race" }),
    });
    const query = await value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }) as { queryId: string };
    const blockerRefusal = expectRefusal(value.runtime.coordinator.query({
      actorSessionId: actor.id,
      value: { mode: "list" },
    }), "MEMORY_RECOVERY_REQUIRED");
    if (gate === undefined) throw new Error("Expected a lifecycle gate.");
    await gate.entered;
    const explanation = expectRefusal(value.runtime.coordinator.explain({
      actorSessionId: actor.id,
      value: { queryId: query.queryId, row: 0 },
    }), "MEMORY_RECOVERY_REQUIRED");
    const current = value.runtime.store.requireSession(actor.id);
    value.runtime.store.updateSessionMetadata({
      sessionId: current.id,
      expectedRevision: current.revision,
      projectId: value.secondProject.id,
    });
    gate.release();

    await blockerRefusal;
    await explanation;
  });
});
