import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson, canonicalSha256 } from "@hraness/oh";
import {
  createOhMemoryPageRecordV1,
  createOhMemoryPageValueV1,
} from "@hraness/oh/memory";
import {
  createOhSqliteStoreAuthorityV1,
} from "@hraness/oh/sqlite";
import {
  emptyOhHeadV1,
  OH_CANONICAL_STORE_PROFILE_V1,
  type OhHeadV1,
} from "@hraness/oh/store";

import {
  canonicalMemoryBindingDigest,
  deriveCanonicalMemoryGenesisToken,
  encryptCanonicalMemoryDescriptor,
  encryptCanonicalMemoryTerminalHeadProof,
  wrapCanonicalMemorySpaceKey,
  type CanonicalMemoryEncryptionKey,
} from "./canonical-memory-crypto.ts";
import {
  CanonicalMemoryTransportError,
  type CanonicalMemoryTransport,
} from "./canonical-memory-transport.ts";
import type {
  CanonicalMemoryCloudAuthority,
  CanonicalMemoryCloudAuthoritySource,
  CanonicalMemoryEncryptionKeyRequest,
} from "./local-control.ts";
import type {
  CanonicalMemoryCreateResult,
  CanonicalMemoryHead,
  CanonicalMemoryOperation,
  CanonicalMemoryPullPage,
  CanonicalMemorySpaceConfiguration,
  CanonicalMemorySpaceSummary,
  CanonicalMemoryWriteResult,
} from "./memory-sync-contracts.ts";
import {
  deriveProjectMemoryCanonicalIdentity,
  legacyProjectMemorySpaceId,
  PROJECT_MEMORY_EMPTY_HEAD,
} from "../domain/project-memory.ts";
import {
  memoryPageContentDigest,
  memoryPageKeyDigest,
  memoryPagePhysicalKey,
} from "../domain/memory-page.ts";
import {
  encodeBase64Url,
  encryptBytes,
  GcmMessageBudget,
  hmacSha256Hex,
} from "./crypto.ts";
import {
  digestOhHead,
  OhSqliteFactsMemoryEngine,
} from "../storage/oh-facts-memory-engine.ts";
import {
  initializeStatePaths,
  resolveStatePaths,
  type StatePaths,
} from "../storage/paths.ts";
import { StateStore, type ProjectMemoryHeadRef } from "../storage/state-store.ts";
import {
  CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
  OompaCanonicalMemorySynchronizer,
  type CanonicalMemoryBackgroundFailure,
} from "./canonical-memory-sync.ts";
import { ProjectMemorySerialExecutor } from "../daemon/project-memory-serial.ts";

const roots: string[] = [];
const fixtures: DeviceFixture[] = [];
const ownedMemoryTeardowns: Array<() => Promise<void>> = [];

type DeviceFixture = Readonly<{
  engine: OhSqliteFactsMemoryEngine;
  paths: StatePaths;
  projectId: string;
  store: StateStore;
  sync: OompaCanonicalMemorySynchronizer;
}>;

afterEach(async () => {
  // A later stage depends on earlier fixtures: abort and join it before closing them.
  for (const teardown of ownedMemoryTeardowns.splice(0).reverse()) await teardown();
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.sync.close().catch(() => undefined);
    fixture.store.close();
  }
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

function testEncryptionKey(
  bytes: Uint8Array,
  keyVersion: number,
  usageScope: CanonicalMemoryEncryptionKey["usageScope"],
): CanonicalMemoryEncryptionKey {
  const owned = Uint8Array.from(bytes);
  const budget = new GcmMessageBudget();
  let disposed = false;
  return Object.freeze({
    authenticate: async (purpose: string, value: string) => {
      if (disposed) throw new Error("TEST_KEY_DISPOSED");
      return await hmacSha256Hex(owned, purpose, value);
    },
    dispose: () => {
      disposed = true;
      owned.fill(0);
    },
    encrypt: async (plaintext: Uint8Array, aad: Uint8Array) => {
      if (disposed) throw new Error("TEST_KEY_DISPOSED");
      return await encryptBytes(plaintext, owned, keyVersion, aad, budget);
    },
    keyVersion,
    usageScope,
  });
}

class MemoryServer implements CanonicalMemoryTransport {
  beforeGet: (() => Promise<void>) | undefined;
  readonly calls: string[] = [];
  configuration: CanonicalMemorySpaceConfiguration | undefined;
  createAttempts = 0;
  failCreateAfterApplyOnce = false;
  failCreateBeforeApplyOnce = false;
  failGetTransportCount = 0;
  readonly operations: CanonicalMemoryOperation[] = [];
  failAfterApplyOnce = false;
  missing = false;

  constructor(configuration?: CanonicalMemorySpaceConfiguration) {
    this.configuration = configuration;
  }

  async create(
    request: Parameters<CanonicalMemoryTransport["create"]>[0],
  ): Promise<CanonicalMemoryCreateResult> {
    this.calls.push("create");
    this.createAttempts += 1;
    if (this.failCreateBeforeApplyOnce) {
      this.failCreateBeforeApplyOnce = false;
      throw new CanonicalMemoryTransportError("transport", "indeterminate");
    }
    const proposed: CanonicalMemorySpaceConfiguration = {
      ...request,
      revision: 1,
    };
    const existing = this.configuration;
    if (existing === undefined) {
      this.configuration = proposed;
    } else {
      const comparable = {
        bindingPolicy: existing.bindingPolicy,
        encryptedDescriptor: existing.encryptedDescriptor,
        genesisHeadProof: existing.genesisHeadProof,
        genesisToken: existing.genesisToken,
        identityContract: existing.identityContract,
        keyVersion: existing.keyVersion,
        spaceId: existing.spaceId,
        wrappedSpaceKey: existing.wrappedSpaceKey,
      };
      if (existing.revision !== 1 || canonicalJson(comparable) !== canonicalJson(request)) {
        throw new CanonicalMemoryTransportError("conflict", "indeterminate");
      }
    }
    if (this.failCreateAfterApplyOnce) {
      this.failCreateAfterApplyOnce = false;
      throw new CanonicalMemoryTransportError("transport", "indeterminate");
    }
    return { ...(this.configuration ?? proposed), replay: existing !== undefined };
  }

  async get(): Promise<CanonicalMemorySpaceConfiguration> {
    this.calls.push("get");
    await this.beforeGet?.();
    if (this.failGetTransportCount > 0) {
      this.failGetTransportCount -= 1;
      throw new CanonicalMemoryTransportError("transport", "none");
    }
    if (this.missing || this.configuration === undefined) {
      throw new CanonicalMemoryTransportError("missing", "none");
    }
    return this.configuration;
  }

  async head(): Promise<CanonicalMemoryHead> {
    this.calls.push("head");
    if (this.missing || this.configuration === undefined) {
      throw new CanonicalMemoryTransportError("missing", "none");
    }
    const configuration = this.configuration;
    const operation = this.operations.at(-1);
    return operation === undefined
      ? {
          genesisToken: configuration.genesisToken,
          headToken: configuration.genesisToken,
          keyVersion: configuration.keyVersion,
          revision: configuration.revision,
          sequence: 0,
          spaceId: configuration.spaceId,
          terminalHeadProof: configuration.genesisHeadProof,
        }
      : {
          genesisToken: operation.genesisToken,
          headToken: operation.headToken,
          keyVersion: operation.operation.keyVersion,
          revision: configuration.revision,
          sequence: operation.sequence,
          spaceId: configuration.spaceId,
          terminalHeadProof: operation.terminalHeadProof,
        };
  }

  async list(): Promise<readonly CanonicalMemorySpaceSummary[]> {
    this.calls.push("list");
    if (this.configuration === undefined) return [];
    return [{
      bindingPolicy: "one_project_one_space",
      identityContract: 2,
      keyVersion: this.configuration.keyVersion,
      revision: this.configuration.revision,
      spaceId: this.configuration.spaceId,
    }];
  }

  async pull(input: Parameters<CanonicalMemoryTransport["pull"]>[0]): Promise<CanonicalMemoryPullPage> {
    this.calls.push("pull");
    if (this.configuration === undefined) {
      throw new CanonicalMemoryTransportError("missing", "none");
    }
    const operation = this.operations.find((candidate) =>
      candidate.sequence === input.afterSequence + 1);
    const operations = operation === undefined || operation.sequence > input.terminalSequence
      ? []
      : [operation] as const;
    return {
      done: operation === undefined
        ? input.afterSequence === input.terminalSequence
        : operation.sequence === input.terminalSequence,
      operations,
      spaceId: this.configuration.spaceId,
      terminalHeadToken: input.terminalHeadToken,
      terminalSequence: input.terminalSequence,
    };
  }

  async push(input: Parameters<CanonicalMemoryTransport["push"]>[0]): Promise<CanonicalMemoryWriteResult> {
    this.calls.push("push");
    if (this.configuration === undefined) {
      throw new CanonicalMemoryTransportError("missing", "indeterminate");
    }
    const operation = input.operations[0];
    const existing = this.operations.find((candidate) => candidate.sequence === operation.sequence);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(operation)) {
        throw new CanonicalMemoryTransportError("conflict", "indeterminate");
      }
    } else {
      const current = await this.head();
      if (
        operation.sequence !== current.sequence + 1
        || operation.priorToken !== current.headToken
      ) throw new CanonicalMemoryTransportError("conflict", "indeterminate");
      this.operations.push(operation);
    }
    if (this.failAfterApplyOnce) {
      this.failAfterApplyOnce = false;
      throw new CanonicalMemoryTransportError("transport", "indeterminate");
    }
    return {
      acceptedHeadToken: operation.headToken,
      acceptedSequence: operation.sequence,
      acceptedTerminalHeadProof: operation.terminalHeadProof,
      keyVersion: input.expectedKeyVersion,
      replay: existing !== undefined,
      revision: input.expectedRevision,
      spaceId: input.spaceId,
    };
  }
}

class TestAuthoritySource implements CanonicalMemoryCloudAuthoritySource {
  readonly #accountKey: Uint8Array;
  readonly #accountBindingDigest: string;
  readonly #transport: CanonicalMemoryTransport;
  readonly accountKeySnapshots: Uint8Array[] = [];
  readonly encryptionKeyInputs: Uint8Array[] = [];

  constructor(input: Readonly<{
    accountBindingDigest: string;
    accountKey: Uint8Array;
    transport: CanonicalMemoryTransport;
  }>) {
    this.#accountBindingDigest = input.accountBindingDigest;
    this.#accountKey = Uint8Array.from(input.accountKey);
    this.#transport = input.transport;
  }

  async snapshotCanonicalMemoryAuthority(): Promise<CanonicalMemoryCloudAuthority> {
    const accountKey = Uint8Array.from(this.#accountKey);
    this.accountKeySnapshots.push(accountKey);
    let disposed = false;
    return Object.freeze({
      accountBindingDigest: this.#accountBindingDigest,
      accountKey: Object.freeze({ bytes: accountKey, keyVersion: 1 }),
      assertCurrent: async () => {
        if (disposed) throw new Error("TEST_AUTHORITY_DISPOSED");
      },
      dispose: () => {
        disposed = true;
        accountKey.fill(0);
      },
      openEncryptionKey: async (input: CanonicalMemoryEncryptionKeyRequest) => {
        if (disposed) throw new Error("TEST_AUTHORITY_DISPOSED");
        this.encryptionKeyInputs.push(input.bytes);
        const usageScope = input.usage.kind === "account_data"
          ? "account_data" as const
          : `space:${input.usage.hostedSpaceId}` as const;
        return testEncryptionKey(input.bytes, input.keyVersion, usageScope);
      },
      retireEncryptionKey: async () => undefined,
      transport: this.#transport,
    });
  }
}

function createEmptyRemote() {
  const accountKey = Uint8Array.from({ length: 32 }, (_, index) => index + 31);
  const accountBindingDigest = canonicalSha256({ account: "create-owner", v: 1 });
  const server = new MemoryServer();
  return {
    accountBindingDigest,
    accountKey,
    server,
    source: new TestAuthoritySource({ accountBindingDigest, accountKey, transport: server }),
  };
}

async function createRemote() {
  const accountKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const spaceKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const accountBindingDigest = canonicalSha256({ account: "test-owner", v: 1 });
  const canonicalSpaceId = "hra:project:space-0123456789abcdef0123456789abcdef";
  const hostedSpaceId = `memory_${encodeBase64Url(new Uint8Array(24).fill(19))}`;
  const binding = {
    bindingDigest: canonicalMemoryBindingDigest(canonicalSpaceId),
    canonicalSpaceId,
    hostedSpaceId,
    keyVersion: 1,
  } as const;
  const accountHandle = testEncryptionKey(accountKey, 1, "account_data");
  const spaceHandle = testEncryptionKey(spaceKey, 1, `space:${hostedSpaceId}`);
  try {
    const genesis = emptyOhHeadV1();
    const genesisToken = await deriveCanonicalMemoryGenesisToken({
      authority: binding,
      head: genesis,
      spaceKey,
    });
    const configuration: CanonicalMemorySpaceConfiguration = {
      bindingPolicy: "one_project_one_space",
      encryptedDescriptor: await encryptCanonicalMemoryDescriptor({
        authority: binding,
        encryptionKey: spaceHandle,
      }),
      genesisHeadProof: await encryptCanonicalMemoryTerminalHeadProof({
        authority: binding,
        encryptionKey: spaceHandle,
        head: genesis,
        headToken: genesisToken,
      }),
      genesisToken,
      identityContract: 2,
      keyVersion: 1,
      revision: 1,
      spaceId: hostedSpaceId,
      wrappedSpaceKey: await wrapCanonicalMemorySpaceKey({
        authority: {
          accountKeyVersion: 1,
          hostedSpaceId,
          spaceKeyVersion: 1,
        },
        encryptionKey: accountHandle,
        spaceKey: Uint8Array.from(spaceKey),
      }),
    };
    const server = new MemoryServer(configuration);
    return {
      accountBindingDigest,
      accountKey,
      canonicalSpaceId,
      hostedSpaceId,
      server,
      source: new TestAuthoritySource({ accountBindingDigest, accountKey, transport: server }),
    };
  } finally {
    accountHandle.dispose();
    spaceHandle.dispose();
    spaceKey.fill(0);
  }
}

async function createDevice(
  label: string,
  source: CanonicalMemoryCloudAuthoritySource,
  background: Pick<
    ConstructorParameters<typeof OompaCanonicalMemorySynchronizer>[0],
    | "backgroundBackoffMaxMs"
    | "backgroundIntervalMs"
    | "backgroundNow"
    | "backgroundSleep"
    | "onBackgroundFailure"
  > = {},
  registerStore?: (store: StateStore) => void,
): Promise<DeviceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `oompa-memory-sync-${label}-`)));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const store = new StateStore(paths);
  registerStore?.(store);
  const project = await store.createProject(`Project ${label}`, projectRoot, true);
  const engine = new OhSqliteFactsMemoryEngine({ forkAttestations: store });
  const projectSerial = new ProjectMemorySerialExecutor();
  const sync = new OompaCanonicalMemorySynchronizer({
    authoritySource: source,
    ...background,
    engine,
    paths,
    projectSerial,
    store,
  });
  const fixture = { engine, paths, projectId: project.id, store, sync };
  fixtures.push(fixture);
  return fixture;
}

function ownedMemoryCase(runCase: (context: Readonly<{
  createDevice: (label: string, source: CanonicalMemoryCloudAuthoritySource) => Promise<DeviceFixture>;
  request: <T>(operation: () => Promise<T>) => Promise<T>;
}>) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const requests = new Set<Promise<unknown>>();
  const stores: StateStore[] = [];
  const devices: DeviceFixture[] = [];
  const request = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const result = await operation();
      controller.signal.throwIfAborted();
      return result;
    });
    requests.add(task);
    void task.then(() => { requests.delete(task); }, () => { requests.delete(task); });
    return task;
  };
  // The owner is registered before setup starts. Its join includes the whole
  // case continuation, not only a synchronizer's current network operation.
  const caseTask = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    await runCase({
      createDevice: (label, source) => request(async () => {
        const device = await createDevice(label, source, {}, (store) => { stores.push(store); });
        devices.push(device);
        return device;
      }),
      request,
    });
    controller.signal.throwIfAborted();
  });
  ownedMemoryTeardowns.push(async () => {
    controller.abort(new Error("Owned canonical memory case is closing."));
    await Promise.allSettled([caseTask, ...requests]);
    for (const device of devices) await device.sync.close();
    // Completed fixtures retain their ordinary outer cleanup; partial setup
    // still closes any store it opened before createDevice could return.
    for (const store of stores) {
      if (!devices.some((device) => device.store === store)) store.close();
    }
  });
  void caseTask.catch(() => undefined);
  return caseTask;
}

function projectDirectory(fixture: DeviceFixture): string {
  return resolve(join(
    fixture.paths.projectMemory,
    canonicalSha256({ projectId: fixture.projectId, v: 1 }),
  ));
}

function deviceHead(fixture: DeviceFixture): ProjectMemoryHeadRef | undefined {
  return fixture.store.readProjectMemoryAuthority(fixture.projectId)?.head;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledBackgroundTime() {
  type PendingSleep = {
    milliseconds: number;
    resolve: () => void;
    settled: boolean;
  };
  const pending: PendingSleep[] = [];
  let now = 0;
  const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolveSleep, rejectSleep) => {
      const entry: PendingSleep = { milliseconds, resolve: () => undefined, settled: false };
      const finish = (callback: () => void): void => {
        if (entry.settled) return;
        entry.settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => rejectSleep(signal.reason));
      entry.resolve = () => finish(resolveSleep);
      pending.push(entry);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
  const nextPending = async (): Promise<PendingSleep> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const selected = pending.find((entry) => !entry.settled);
      if (selected !== undefined) return selected;
      await Bun.sleep(1);
    }
    throw new Error("TEST_BACKGROUND_SLEEP_NOT_SCHEDULED");
  };
  return {
    advanceNext: async (): Promise<number> => {
      const selected = await nextPending();
      now += selected.milliseconds;
      selected.resolve();
      return selected.milliseconds;
    },
    nextDelay: async (): Promise<number> => (await nextPending()).milliseconds,
    now: () => now,
    sleep,
  };
}

async function waitForTest(predicate: () => boolean, failure: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(failure);
}

async function addProject(fixture: DeviceFixture, label: string): Promise<string> {
  const root = join(fixture.paths.root, `project-${label}`);
  await mkdir(root, { recursive: true });
  return (await fixture.store.createProject(`Project ${label}`, root)).id;
}

async function seedLegacyCanonicalDatabase(
  fixture: DeviceFixture,
  name: string,
): Promise<void> {
  const directory = projectDirectory(fixture);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const identity = deriveProjectMemoryCanonicalIdentity({
    canonicalSpaceId: legacyProjectMemorySpaceId(fixture.projectId),
    identityContract: 1,
    projectId: fixture.projectId,
  });
  const canonical = createOhSqliteStoreAuthorityV1({
    path: join(directory, "oh.sqlite"),
    profile: OH_CANONICAL_STORE_PROFILE_V1,
    realmId: identity.canonicalRealmId,
    spaceId: identity.canonicalSpaceId,
  });
  try {
    const key = `entity:${name}`;
    const record = {
      dependencies: [],
      key,
      kind: "entity" as const,
      recordSha256: canonicalSha256({
        dependencies: [],
        key,
        kind: "entity",
        v: 1,
        value: { name },
      }),
      v: 1 as const,
      value: { name },
    };
    await canonical.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await canonical.store.head(),
      operationId: `host.legacy.${name}`,
    });
  } finally {
    await canonical.store.close();
  }
}

async function advanceLocal(fixture: DeviceFixture, name: string): Promise<ProjectMemoryHeadRef> {
  const authority = fixture.store.readProjectMemoryAuthority(fixture.projectId);
  if (authority === null) throw new Error("TEST_AUTHORITY_MISSING");
  const identity = deriveProjectMemoryCanonicalIdentity({
    canonicalSpaceId: authority.canonicalSpaceId,
    identityContract: authority.identityContract,
    projectId: fixture.projectId,
  });
  const direct = createOhSqliteStoreAuthorityV1({
    path: join(projectDirectory(fixture), "oh.sqlite"),
    profile: OH_CANONICAL_STORE_PROFILE_V1,
    realmId: identity.canonicalRealmId,
    spaceId: identity.canonicalSpaceId,
  });
  let head: OhHeadV1;
  try {
    await direct.store.commit({
      actorId: "hra.memory.host",
      changes: [{
        kind: "put",
        record: {
          dependencies: [],
          key: `entity:${name}`,
          kind: "entity",
          recordSha256: canonicalSha256({
            dependencies: [],
            key: `entity:${name}`,
            kind: "entity",
            v: 1,
            value: { name },
          }),
          v: 1,
          value: { name },
        },
        v: 1,
      }],
      expectedHead: await direct.store.head(),
      operationId: `host.test.${name}`,
    });
    head = await direct.store.head();
  } finally {
    await direct.store.close();
  }
  return fixture.store.compareAndSwapProjectMemoryHead({
    expectedHead: authority.head,
    expectedRevision: authority.revision,
    nextHead: {
      headDigest: digestOhHead(head),
      operationSha256: head.operationSha256,
      sequence: head.sequence,
    },
    projectId: fixture.projectId,
  }).head;
}

async function advancePortableMemoryPage(
  fixture: DeviceFixture,
  key: string,
): Promise<Readonly<{
  contentDigest: string;
  head: ProjectMemoryHeadRef;
  keyDigest: string;
  recordSha256: string;
  sourceReceiptSha256: string;
}>> {
  const authority = fixture.store.readProjectMemoryAuthority(fixture.projectId);
  if (authority === null) throw new Error("TEST_AUTHORITY_MISSING");
  const identity = deriveProjectMemoryCanonicalIdentity({
    canonicalSpaceId: authority.canonicalSpaceId,
    identityContract: authority.identityContract,
    projectId: fixture.projectId,
  });
  const instant = "2026-09-06T12:00:00.000Z";
  const value = createOhMemoryPageValueV1({
    body: "Portable memory body",
    createdAt: instant,
    format: "oh.memory-page.v1",
    language: "en",
    provenance: {
      actorId: "hra.session.sess-portable-proof",
      attestationSha256: canonicalSha256({ attestation: key, v: 1 }),
      attestedAt: instant,
      kind: "host-attested",
      v: 1,
    },
    sources: [],
    summary: "Portable memory summary",
    title: "Portable memory",
    updatedAt: instant,
    v: 1,
  });
  const record = createOhMemoryPageRecordV1({
    dependencies: [],
    key: memoryPagePhysicalKey(key),
    value,
  });
  const direct = createOhSqliteStoreAuthorityV1({
    path: join(projectDirectory(fixture), "oh.sqlite"),
    profile: OH_CANONICAL_STORE_PROFILE_V1,
    realmId: identity.canonicalRealmId,
    spaceId: identity.canonicalSpaceId,
  });
  let head: OhHeadV1;
  try {
    await direct.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await direct.store.head(),
      operationId: `host.memory.${key}`,
    });
    head = await direct.store.head();
  } finally {
    await direct.store.close();
  }
  const projectHead = {
    headDigest: digestOhHead(head),
    operationSha256: head.operationSha256,
    sequence: head.sequence,
  };
  if (projectHead.operationSha256 === null) throw new Error("TEST_OPERATION_MISSING");
  fixture.store.compareAndSwapProjectMemoryHead({
    expectedHead: authority.head,
    expectedRevision: authority.revision,
    nextHead: projectHead,
    projectId: fixture.projectId,
  });
  const contentDigest = memoryPageContentDigest({
    body: value.body,
    key,
    ...(value.language === null ? {} : { language: value.language }),
    summary: value.summary,
    title: value.title,
  });
  const keyDigest = memoryPageKeyDigest(key);
  const sourceReceiptSha256 = canonicalSha256({ receipt: key, v: 1 });
  const writer = new Database(fixture.store.paths.database, { create: false, strict: true });
  try {
    writer.exec("PRAGMA foreign_keys=ON");
    writer.query(
      `INSERT INTO project_memory_portable_adoption_proofs(
         project_id,canonical_space_id,canonical_binding_digest,sequence,
         operation_sha256,record_sha256,key_digest,content_digest,
         source_receipt_sha256,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      fixture.projectId,
      authority.canonicalSpaceId,
      authority.bindingDigest,
      projectHead.sequence,
      projectHead.operationSha256,
      record.recordSha256,
      keyDigest,
      contentDigest,
      sourceReceiptSha256,
      Date.parse(instant),
    );
  } finally {
    writer.close(false);
  }
  return {
    contentDigest,
    head: projectHead,
    keyDigest,
    recordSha256: record.recordSha256,
    sourceReceiptSha256,
  };
}

describe("OompaCanonicalMemorySynchronizer", () => {
  test("creates one encrypted hosted owner space and returns only redacted ownership data", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("create-owner", remote.source);
    const idempotencyKey = "00000000-0000-4000-8000-000000000801";

    const created = await device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    });

    expect(created).toEqual({
      attachment: expect.objectContaining({
        generation: 1,
        projectId: device.projectId,
        state: "attached",
      }),
      canonicalSpaceId: expect.stringMatching(/^hra:project:space-[a-f0-9]{32}$/u),
      hostedSpaceId: expect.stringMatching(/^memory_[A-Za-z0-9_-]{32}$/u),
      projectId: device.projectId,
      replay: false,
    });
    expect(Object.keys(created).sort()).toEqual([
      "attachment",
      "canonicalSpaceId",
      "hostedSpaceId",
      "projectId",
      "replay",
    ]);
    expect(canonicalJson(created)).not.toContain("ciphertext");
    expect(canonicalJson(created)).not.toContain("wrappedSpaceKey");
    expect(remote.server.configuration).toMatchObject({
      bindingPolicy: "one_project_one_space",
      identityContract: 2,
      keyVersion: 1,
      revision: 1,
      spaceId: created.hostedSpaceId,
    });
    expect(device.store.readProjectMemoryAuthority(device.projectId)).toMatchObject({
      canonicalSpaceId: created.canonicalSpaceId,
      identityContract: 2,
      physicalState: "initialized",
    });
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toBeNull();
    expect(remote.source.encryptionKeyInputs.every((bytes) =>
      bytes.every((byte) => byte === 0))).toBe(true);

    const replayed = await device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    });
    expect(replayed).toMatchObject({
      canonicalSpaceId: created.canonicalSpaceId,
      hostedSpaceId: created.hostedSpaceId,
      replay: true,
    });
    expect(remote.server.createAttempts).toBe(1);
  });

  test("never reserves a portable create authority over an existing canonical database", () => ownedMemoryCase(async (
    { createDevice: createOwnedDevice, request },
  ) => {
    const emptyRemote = createEmptyRemote();
    const createDeviceFixture = await createOwnedDevice("legacy-create-preflight", emptyRemote.source);
    await request(() => seedLegacyCanonicalDatabase(createDeviceFixture, "legacy-create-record"));

    await expect(request(() => createDeviceFixture.sync.createHostedSpace({
      idempotencyKey: "00000000-0000-4000-8000-000000000806",
      projectId: createDeviceFixture.projectId,
    }))).rejects.toThrow("CANONICAL_MEMORY_DATABASE_RECOVERY_REQUIRED");
    expect(createDeviceFixture.store.readProjectMemoryAuthority(createDeviceFixture.projectId))
      .toBeNull();
    expect(emptyRemote.server.createAttempts).toBe(0);
  }));

  test("never reserves a portable attach authority over an existing canonical database", () => ownedMemoryCase(async (
    { createDevice: createOwnedDevice, request },
  ) => {
    const attachRemote = await request(() => createRemote());
    const attachDevice = await createOwnedDevice("legacy-attach-preflight", attachRemote.source);
    await request(() => seedLegacyCanonicalDatabase(attachDevice, "legacy-attach-record"));

    await expect(request(() => attachDevice.sync.attachHostedSpace({
      hostedSpaceId: attachRemote.hostedSpaceId,
      projectId: attachDevice.projectId,
    }))).rejects.toThrow("CANONICAL_MEMORY_DATABASE_RECOVERY_REQUIRED");
    expect(attachDevice.store.readProjectMemoryAuthority(attachDevice.projectId)).toBeNull();
    expect(attachDevice.store.readCanonicalMemoryHostedAttachment(attachDevice.projectId))
      .toBeNull();
  }));

  test("recovers an applied create with a lost response by comparing the exact winner", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("create-lost-response", remote.source);
    const idempotencyKey = "00000000-0000-4000-8000-000000000802";
    remote.server.failCreateAfterApplyOnce = true;

    await expect(device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    expect(remote.server.configuration).toBeDefined();
    expect(remote.server.createAttempts).toBe(1);
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toMatchObject({ state: "effect_started" });

    await device.sync.recover();
    expect(remote.server.createAttempts).toBe(1);
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toBeNull();
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId))
      .toMatchObject({ state: "attached" });
    expect(remote.server.calls.indexOf("get")).toBeGreaterThan(
      remote.server.calls.indexOf("create"),
    );
    expect(remote.server.calls.indexOf("head")).toBeGreaterThan(
      remote.server.calls.indexOf("get"),
    );

    const replayed = await device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    });
    expect(replayed.replay).toBe(true);
    expect(remote.server.createAttempts).toBe(1);
  });

  test("keeps an indeterminate unapplied create recoverable and retries its durable bytes", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("create-transient", remote.source);
    const idempotencyKey = "00000000-0000-4000-8000-000000000803";
    remote.server.failCreateBeforeApplyOnce = true;

    await expect(device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    const interrupted = device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(
      device.projectId,
    );
    expect(interrupted).toMatchObject({
      request: expect.any(Object),
      state: "effect_started",
    });
    expect(remote.server.configuration).toBeUndefined();

    await device.sync.recover();
    expect(remote.server.createAttempts).toBe(2);
    expect(remote.server.configuration).toMatchObject(interrupted?.request ?? {});
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId))
      .toMatchObject({ state: "attached" });
  });

  test("sticky-freezes a create when recovery observes a different remote winner", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("create-mismatched-winner", remote.source);
    const idempotencyKey = "00000000-0000-4000-8000-000000000804";
    remote.server.failCreateAfterApplyOnce = true;

    await expect(device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    const interrupted = device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(
      device.projectId,
    );
    const applied = remote.server.configuration;
    if (interrupted === null || applied === undefined) {
      throw new Error("TEST_CREATE_INTENT_MISSING");
    }
    remote.server.configuration = {
      ...applied,
      genesisToken: canonicalSha256({ replacement: true, v: 1 }),
    };

    await expect(device.sync.recover()).rejects.toThrow("REMOTE_MEMORY_CREATE_CONFLICT");
    expect(device.store.readCanonicalMemoryHostedCreateIntent(interrupted.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      state: "conflict",
    });
    expect(device.store.readProjectMemoryAuthority(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      syncState: "conflict",
    });
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId)).toBeNull();
  });

  test("settles a winner journal after a crash without dispatching create again", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("create-winner-journal", remote.source);
    const idempotencyKey = "00000000-0000-4000-8000-000000000805";
    const settle = device.store.settleCanonicalMemoryHostedCreate.bind(device.store);
    let failOnce = true;
    Object.defineProperty(device.store, "settleCanonicalMemoryHostedCreate", {
      configurable: true,
      value: (intentId: string) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("TEST_CRASH_AFTER_CREATE_WINNER");
        }
        return settle(intentId);
      },
    });

    await expect(device.sync.createHostedSpace({
      idempotencyKey,
      projectId: device.projectId,
    })).rejects.toThrow("TEST_CRASH_AFTER_CREATE_WINNER");
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toMatchObject({ state: "winner_observed" });
    expect(remote.server.createAttempts).toBe(1);

    Object.defineProperty(device.store, "settleCanonicalMemoryHostedCreate", {
      configurable: true,
      value: settle,
    });
    await device.sync.recover();
    expect(remote.server.createAttempts).toBe(1);
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId))
      .toMatchObject({ state: "attached" });
  });

  test("keeps close pending until one recovery sweep stops extending the lifecycle tail", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("recovery-close-barrier", remote.source);
    const secondProjectId = await addProject(device, "recovery-close-second");
    for (const [projectId, idempotencyKey] of [
      [device.projectId, "00000000-0000-4000-8000-000000000807"],
      [secondProjectId, "00000000-0000-4000-8000-000000000808"],
    ] as const) {
      remote.server.failCreateBeforeApplyOnce = true;
      await expect(device.sync.createHostedSpace({ idempotencyKey, projectId }))
        .rejects.toBeInstanceOf(CanonicalMemoryTransportError);
      expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(projectId))
        .toMatchObject({ state: "effect_started" });
    }

    const firstGetEntered = deferred();
    const releaseFirstGet = deferred();
    const secondGetEntered = deferred();
    const releaseSecondGet = deferred();
    let getCount = 0;
    remote.server.beforeGet = async () => {
      getCount += 1;
      if (getCount === 1) {
        firstGetEntered.resolve();
        await releaseFirstGet.promise;
      } else if (getCount === 2) {
        secondGetEntered.resolve();
        await releaseSecondGet.promise;
      }
    };

    const recovery = device.sync.recover().then(
      () => null,
      (error: unknown) => error,
    );
    await firstGetEntered.promise;
    let closeSettled = false;
    const closing = device.sync.close().then(() => {
      closeSettled = true;
    });
    releaseFirstGet.resolve();
    await secondGetEntered.promise;
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseSecondGet.resolve();
    expect(await recovery).toBeInstanceOf(Error);
    await closing;
    expect(closeSettled).toBe(true);
  });

  test("keeps explicit foreground recovery fail-closed on a transient cloud outage", async () => {
    const remote = createEmptyRemote();
    const device = await createDevice("foreground-recovery-outage", remote.source);
    remote.server.failCreateBeforeApplyOnce = true;
    await expect(device.sync.createHostedSpace({
      idempotencyKey: "00000000-0000-4000-8000-000000000809",
      projectId: device.projectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    const interrupted = device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(
      device.projectId,
    );
    expect(interrupted).toMatchObject({ state: "effect_started" });
    remote.server.failGetTransportCount = 1;

    await expect(device.sync.recover()).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toMatchObject({
        id: interrupted?.id,
        request: interrupted?.request,
        state: "effect_started",
      });
  });

  test("retries an exact unresolved create in the background after bounded backoff", async () => {
    const remote = createEmptyRemote();
    const clock = controlledBackgroundTime();
    const failures: CanonicalMemoryBackgroundFailure[] = [];
    const device = await createDevice("background-create-retry", remote.source, {
      backgroundBackoffMaxMs: 60_000,
      backgroundIntervalMs: CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
      backgroundNow: clock.now,
      backgroundSleep: clock.sleep,
      onBackgroundFailure: (failure) => failures.push(failure),
    });
    remote.server.failCreateBeforeApplyOnce = true;
    await expect(device.sync.createHostedSpace({
      idempotencyKey: "00000000-0000-4000-8000-000000000810",
      projectId: device.projectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    const interrupted = device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(
      device.projectId,
    );
    expect(interrupted).toMatchObject({ request: expect.any(Object), state: "effect_started" });
    remote.server.failGetTransportCount = 1;

    device.sync.startBackgroundRecovery();
    await waitForTest(() => failures.length === 1, "background create failure was not reported");
    expect(failures).toEqual([{
      code: "CANONICAL_MEMORY_BACKGROUND_CREATE_RECOVERY_FAILED",
      consecutiveFailures: 1,
      projectId: device.projectId,
    }]);
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toMatchObject({
        id: interrupted?.id,
        request: interrupted?.request,
        state: "effect_started",
      });
    expect(await clock.advanceNext()).toBe(CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS);
    await waitForTest(
      () => device.store.readCanonicalMemoryHostedAttachment(device.projectId)?.state === "attached",
      "background create recovery did not settle",
    );

    expect(remote.server.createAttempts).toBe(2);
    expect(remote.server.configuration).toMatchObject(interrupted?.request ?? {});
    expect(device.store.readUnresolvedCanonicalMemoryHostedCreateIntent(device.projectId))
      .toBeNull();
  });

  test("backs a repeatedly unavailable project off from fifteen seconds to a hard cap", async () => {
    const remote = await createRemote();
    const clock = controlledBackgroundTime();
    const failures: CanonicalMemoryBackgroundFailure[] = [];
    const device = await createDevice("background-project-backoff", remote.source, {
      backgroundBackoffMaxMs: 60_000,
      backgroundIntervalMs: CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
      backgroundNow: clock.now,
      backgroundSleep: clock.sleep,
      onBackgroundFailure: (failure) => failures.push(failure),
    });
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    remote.server.failGetTransportCount = 4;
    device.sync.startBackgroundRecovery();

    const delays: number[] = [];
    for (let failureCount = 1; failureCount <= 4; failureCount += 1) {
      await waitForTest(
        () => failures.length === failureCount,
        `background failure ${String(failureCount)} was not observed`,
      );
      delays.push(failureCount === 4
        ? await clock.nextDelay()
        : await clock.advanceNext());
    }
    expect(delays).toEqual([15_000, 30_000, 60_000, 60_000]);
    expect(failures.map((failure) => failure.consecutiveFailures)).toEqual([1, 2, 3, 4]);
    expect(failures.every((failure) =>
      failure.code === "CANONICAL_MEMORY_BACKGROUND_PROJECT_SYNC_FAILED"
      && failure.projectId === device.projectId)).toBe(true);
  });

  test("continues to a later attached project after another project freezes", async () => {
    const remote = await createRemote();
    const clock = controlledBackgroundTime();
    const failures: CanonicalMemoryBackgroundFailure[] = [];
    let callsAtFailure = 0;
    const device = await createDevice("background-project-isolation", remote.source, {
      backgroundIntervalMs: CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
      backgroundNow: clock.now,
      backgroundSleep: clock.sleep,
      onBackgroundFailure: (failure) => {
        failures.push(failure);
        callsAtFailure = remote.server.calls.length;
      },
    });
    const otherProjectId = await addProject(device, "background-project-isolation-other");
    const sortedProjectIds = [device.projectId, otherProjectId]
      .sort((left, right) => left.localeCompare(right));
    const brokenProjectId = sortedProjectIds[0];
    const healthyProjectId = sortedProjectIds[1];
    if (brokenProjectId === undefined || healthyProjectId === undefined) {
      throw new Error("TEST_PROJECT_IDS_MISSING");
    }
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: healthyProjectId,
    });
    remote.server.failCreateBeforeApplyOnce = true;
    await expect(device.sync.createHostedSpace({
      idempotencyKey: "00000000-0000-4000-8000-000000000811",
      projectId: brokenProjectId,
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    remote.server.calls.splice(0);

    device.sync.startBackgroundRecovery();
    await waitForTest(() => failures.length === 1, "frozen project failure was not reported");
    await waitForTest(
      () => remote.server.calls.slice(callsAtFailure).includes("head"),
      "healthy project was starved after another project failed",
    );

    expect(failures).toEqual([{
      code: "CANONICAL_MEMORY_BACKGROUND_CREATE_RECOVERY_FAILED",
      consecutiveFailures: 1,
      projectId: brokenProjectId,
    }]);
    expect(device.store.readProjectMemoryAuthority(brokenProjectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      syncState: "conflict",
    });
    expect(device.store.readCanonicalMemoryHostedAttachment(healthyProjectId))
      .toMatchObject({ state: "attached" });
    expect(device.store.readProjectMemoryAuthority(healthyProjectId))
      .toMatchObject({ syncState: "settled" });
  });

  test("does not spin after the background timer fails and restarts only on an explicit request", async () => {
    const remote = await createRemote();
    const failures: CanonicalMemoryBackgroundFailure[] = [];
    let sleepCalls = 0;
    const device = await createDevice("background-timer-failure", remote.source, {
      backgroundSleep: async () => {
        sleepCalls += 1;
        throw new Error("TEST_BACKGROUND_TIMER_FAILED");
      },
      onBackgroundFailure: (failure) => failures.push(failure),
    });
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });

    device.sync.startBackgroundRecovery();
    await waitForTest(
      () => failures.some((failure) =>
        failure.code === "CANONICAL_MEMORY_BACKGROUND_SUPERVISOR_FAILED"),
      "background timer failure was not reduced to a diagnostic",
    );
    await Bun.sleep(5);
    expect(sleepCalls).toBe(1);
    expect(failures.at(-1)).toEqual({
      code: "CANONICAL_MEMORY_BACKGROUND_SUPERVISOR_FAILED",
      consecutiveFailures: 1,
      projectId: null,
    });

    device.sync.startBackgroundRecovery();
    await waitForTest(() => sleepCalls === 2, "explicit supervisor restart was not attempted");
    await Bun.sleep(5);
    expect(sleepCalls).toBe(2);
  });

  test("periodically pulls an enrolled project without an owner command", async () => {
    const remote = await createRemote();
    const writer = await createDevice("background-periodic-writer", remote.source);
    const clock = controlledBackgroundTime();
    const reader = await createDevice("background-periodic-reader", remote.source, {
      backgroundIntervalMs: CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
      backgroundNow: clock.now,
      backgroundSleep: clock.sleep,
    });
    for (const device of [writer, reader]) {
      await device.sync.attachHostedSpace({
        hostedSpaceId: remote.hostedSpaceId,
        projectId: device.projectId,
      });
    }
    reader.sync.startBackgroundRecovery();
    expect(await clock.nextDelay()).toBe(CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS);
    const remoteHead = await advanceLocal(writer, "background-periodic-pull");
    await writer.sync.synchronizeProject({ projectId: writer.projectId, reason: "owner" });

    expect(await clock.advanceNext()).toBe(CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS);
    await waitForTest(
      () => deviceHead(reader)?.headDigest === remoteHead.headDigest,
      "periodic background pull did not converge",
    );
    expect(deviceHead(reader)).toEqual(remoteHead);
  });

  test("close wakes a sleeping supervisor and joins a scheduled in-flight sync", async () => {
    const remote = await createRemote();
    const clock = controlledBackgroundTime();
    const device = await createDevice("background-close-wake", remote.source, {
      backgroundIntervalMs: CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS,
      backgroundNow: clock.now,
      backgroundSleep: clock.sleep,
    });
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    device.sync.startBackgroundRecovery();
    expect(await clock.nextDelay()).toBe(CANONICAL_MEMORY_BACKGROUND_SYNC_INTERVAL_MS);

    const syncEntered = deferred();
    const releaseSync = deferred();
    remote.server.beforeGet = async () => {
      syncEntered.resolve();
      await releaseSync.promise;
    };
    device.sync.scheduleProject({
      projectId: device.projectId,
      reason: "after_canonical_mutation",
    });
    await syncEntered.promise;
    let closeSettled = false;
    const closing = device.sync.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    const callsBeforeRelease = remote.server.calls.length;
    device.sync.scheduleProject({
      projectId: device.projectId,
      reason: "after_canonical_mutation",
    });
    releaseSync.resolve();
    await closing;
    expect(closeSettled).toBe(true);
    expect(remote.server.calls.length).toBe(callsBeforeRelease);
  });

  test("recovers an uncertain push, pulls to a second device, and freezes divergence", async () => {
    const remote = await createRemote();
    const first = await createDevice("first", remote.source);
    const second = await createDevice("second", remote.source);

    await first.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: first.projectId,
    });
    await second.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: second.projectId,
    });
    expect(first.store.readProjectMemoryAuthority(first.projectId)?.physicalState)
      .toBe("initialized");

    const firstHead = await advanceLocal(first, "one");
    remote.server.failAfterApplyOnce = true;
    await expect(first.sync.synchronizeProject({
      projectId: first.projectId,
      reason: "owner",
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    expect(first.store.readUnresolvedCanonicalMemorySyncIntent(first.projectId)?.state)
      .toBe("effect_started");
    expect(remote.server.operations).toHaveLength(1);

    const firstPulled = await second.sync.synchronizeProject({
      projectId: second.projectId,
      reason: "owner",
    });
    expect(firstPulled.localHead).toEqual(firstHead);
    const advancedRemoteHead = await advanceLocal(second, "advanced-after-uncertain-push");
    await second.sync.synchronizeProject({ projectId: second.projectId, reason: "owner" });
    expect(remote.server.operations).toHaveLength(2);

    const settle = first.store.settleCanonicalMemorySync.bind(first.store);
    const settlementSnapshots: Array<Readonly<{
      authority: ReturnType<StateStore["readProjectMemoryAuthority"]>;
      input: Parameters<StateStore["settleCanonicalMemorySync"]>[0];
      remote: ReturnType<StateStore["readCanonicalMemoryHostedAttachment"]>;
    }>> = [];
    Object.defineProperty(first.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: (input: Parameters<StateStore["settleCanonicalMemorySync"]>[0]) => {
        const result = settle(input);
        settlementSnapshots.push({
          authority: first.store.readProjectMemoryAuthority(first.projectId),
          input,
          remote: first.store.readCanonicalMemoryHostedAttachment(first.projectId),
        });
        return result;
      },
    });
    const recovered = await first.sync.synchronizeProject({
      projectId: first.projectId,
      reason: "recovery",
    });
    Object.defineProperty(first.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: settle,
    });
    expect(settlementSnapshots[0]?.input.latestRemote?.head).toEqual(advancedRemoteHead);
    expect(settlementSnapshots[0]?.authority).toMatchObject({
      head: firstHead,
      lastExchangeHead: advancedRemoteHead,
      syncState: "local_only",
    });
    expect(settlementSnapshots[0]?.remote?.remote.head).toEqual(advancedRemoteHead);
    expect(recovered.state).toBe("converged");
    expect(recovered.localHead).toEqual(advancedRemoteHead);
    expect(remote.server.operations).toHaveLength(2);
    expect(first.store.readUnresolvedCanonicalMemorySyncIntent(first.projectId)).toBeNull();

    const pulled = await second.sync.synchronizeProject({
      projectId: second.projectId,
      reason: "owner",
    });
    expect(pulled.localHead).toEqual(advancedRemoteHead);
    expect(second.store.readProjectMemoryAuthority(second.projectId)?.head)
      .toEqual(advancedRemoteHead);

    const divergentFirst = await advanceLocal(first, "first-wins");
    const divergentSecond = await advanceLocal(second, "second-loses");
    expect(divergentFirst.sequence).toBe(divergentSecond.sequence);
    expect(divergentFirst).not.toEqual(divergentSecond);
    await first.sync.synchronizeProject({ projectId: first.projectId, reason: "owner" });
    await expect(second.sync.synchronizeProject({
      projectId: second.projectId,
      reason: "owner",
    })).rejects.toThrow("CANONICAL_MEMORY_SYNC_EQUAL_SEQUENCE_CONFLICT");
    expect(second.store.readProjectMemoryAuthority(second.projectId)).toMatchObject({
      head: divergentSecond,
      syncState: "conflict",
    });
    expect(first.store.readProjectMemoryAuthority(first.projectId)?.head).toEqual(divergentFirst);
  });

  test.each(["exact", "altered"] as const)(
    "carries a portable adoption proof and admits only the exact imported page (%s proof)",
    (proof) => ownedMemoryCase(async ({ createDevice: createOwnedDevice, request }) => {
      const remote = await request(() => createRemote());
      const [first, second] = await Promise.all([
        createOwnedDevice("portable-proof-source", remote.source),
        createOwnedDevice("portable-proof-receiver", remote.source),
      ]);
      await request(() => first.sync.attachHostedSpace({
        hostedSpaceId: remote.hostedSpaceId,
        projectId: first.projectId,
      }));
      if (proof === "exact") await request(() => second.sync.attachHostedSpace({
        hostedSpaceId: remote.hostedSpaceId,
        projectId: second.projectId,
      }));
      const expected = await request(() => advancePortableMemoryPage(first, "portable-key"));

      await request(() => first.sync.synchronizeProject({ projectId: first.projectId, reason: "owner" }));
      expect(remote.server.operations[0]?.adoptionProof).not.toBeNull();
      if (proof === "exact") {
        await request(() => second.sync.synchronizeProject({ projectId: second.projectId, reason: "owner" }));

        const imported = second.store.readCanonicalMemoryPortableAdoptionProof({
          operationSha256: expected.head.operationSha256 ?? "",
          projectId: second.projectId,
          sequence: expected.head.sequence,
        });
        expect(imported).toMatchObject({
          bindingDigest: second.store.readProjectMemoryAuthority(second.projectId)?.bindingDigest,
          canonicalSpaceId: remote.canonicalSpaceId,
          contentDigest: expected.contentDigest,
          keyDigest: expected.keyDigest,
          operationSha256: expected.head.operationSha256,
          projectId: second.projectId,
          recordSha256: expected.recordSha256,
          sourceReceiptSha256: expected.sourceReceiptSha256,
        });
        return;
      }

      const wire = remote.server.operations[0];
      const adoptionProof = wire?.adoptionProof;
      if (wire === undefined || adoptionProof === undefined || adoptionProof === null) {
        throw new Error("TEST_PORTABLE_ADOPTION_PROOF_MISSING");
      }
      const replacement = adoptionProof.ciphertext[0] === "A" ? "B" : "A";
      remote.server.operations[0] = {
        ...wire,
        adoptionProof: {
          ...adoptionProof,
          ciphertext: replacement + adoptionProof.ciphertext.slice(1),
        },
      };
      const hostileReceiver = second;
      await request(() => hostileReceiver.sync.attachHostedSpace({
        hostedSpaceId: remote.hostedSpaceId,
        projectId: hostileReceiver.projectId,
      }));
      expect(hostileReceiver.store.readProjectMemoryAuthority(hostileReceiver.projectId)?.head)
        .toEqual(expected.head);
      expect(hostileReceiver.store.readCanonicalMemoryPortableAdoptionProof({
        operationSha256: expected.head.operationSha256 ?? "",
        projectId: hostileReceiver.projectId,
        sequence: expected.head.sequence,
      })).toBeNull();
    }),
  );

  test("recovers after a pull import committed before control-plane settlement", async () => {
    const remote = await createRemote();
    const writer = await createDevice("pull-import-writer", remote.source);
    const reader = await createDevice("pull-import-reader", remote.source);
    await writer.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: writer.projectId,
    });
    await reader.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: reader.projectId,
    });
    const remoteHead = await advanceLocal(writer, "pull-import-crash");
    await writer.sync.synchronizeProject({ projectId: writer.projectId, reason: "owner" });

    const settle = reader.store.settleCanonicalMemorySync.bind(reader.store);
    let failOnce = true;
    Object.defineProperty(reader.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: (input: Parameters<StateStore["settleCanonicalMemorySync"]>[0]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("TEST_CRASH_AFTER_PHYSICAL_IMPORT");
        }
        return settle(input);
      },
    });
    await expect(reader.sync.synchronizeProject({
      projectId: reader.projectId,
      reason: "owner",
    })).rejects.toThrow("TEST_CRASH_AFTER_PHYSICAL_IMPORT");
    const interrupted = reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId);
    expect(interrupted).toMatchObject({ direction: "pull", state: "response_observed" });
    expect(interrupted?.resultHead).toEqual(remoteHead);
    expect(reader.store.readProjectMemoryAuthority(reader.projectId)?.head.sequence).toBe(0);

    Object.defineProperty(reader.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: settle,
    });
    const recovered = await reader.sync.synchronizeProject({
      projectId: reader.projectId,
      reason: "recovery",
    });
    expect(recovered.localHead).toEqual(remoteHead);
    expect(reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId)).toBeNull();
  });

  test("recovers a pull response recorded before result authorization", async () => {
    const remote = await createRemote();
    const writer = await createDevice("pull-response-writer", remote.source);
    const reader = await createDevice("pull-response-reader", remote.source);
    await writer.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: writer.projectId,
    });
    await reader.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: reader.projectId,
    });
    const remoteHead = await advanceLocal(writer, "pull-response-crash");
    await writer.sync.synchronizeProject({ projectId: writer.projectId, reason: "owner" });

    const authorize = reader.store.authorizeCanonicalMemoryPullResult.bind(reader.store);
    let failOnce = true;
    Object.defineProperty(reader.store, "authorizeCanonicalMemoryPullResult", {
      configurable: true,
      value: (input: Parameters<StateStore["authorizeCanonicalMemoryPullResult"]>[0]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("TEST_CRASH_BEFORE_RESULT_AUTHORIZATION");
        }
        return authorize(input);
      },
    });
    await expect(reader.sync.synchronizeProject({
      projectId: reader.projectId,
      reason: "owner",
    })).rejects.toThrow("TEST_CRASH_BEFORE_RESULT_AUTHORIZATION");
    const interrupted = reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId);
    expect(interrupted).toMatchObject({ direction: "pull", state: "response_observed" });
    expect(interrupted?.resultHead).toBeUndefined();

    Object.defineProperty(reader.store, "authorizeCanonicalMemoryPullResult", {
      configurable: true,
      value: authorize,
    });
    const recovered = await reader.sync.synchronizeProject({
      projectId: reader.projectId,
      reason: "recovery",
    });
    expect(recovered.localHead).toEqual(remoteHead);
    expect(reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId)).toBeNull();
  });

  describe("orphaned pull recovery", () => {
    let remote: Awaited<ReturnType<typeof createRemote>>;
    let originalWriter: DeviceFixture;
    let branchWriter: DeviceFixture;
    let reader: DeviceFixture;

    // Each fresh device runs the full StateStore migrations under its own
    // bounded setup hook. The case deadline covers the crash and recovery.
    beforeEach(() => ownedMemoryCase(async ({ createDevice: createOwnedDevice, request }) => {
      remote = await request(() => createRemote());
      originalWriter = await createOwnedDevice("pull-orphan-original", remote.source);
    }));
    beforeEach(() => ownedMemoryCase(async ({ createDevice: createOwnedDevice }) => {
      branchWriter = await createOwnedDevice("pull-orphan-branch", remote.source);
    }));
    beforeEach(() => ownedMemoryCase(async ({ createDevice: createOwnedDevice }) => {
      reader = await createOwnedDevice("pull-orphan-reader", remote.source);
    }));

    test("freezes before importing a crash-left pull operation removed from later remote history", () => ownedMemoryCase(async (
      { request },
    ) => {
      await Promise.all([originalWriter, branchWriter, reader].map((device) =>
        request(() => device.sync.attachHostedSpace({
          hostedSpaceId: remote.hostedSpaceId,
          projectId: device.projectId,
        }))));
      await request(() => advanceLocal(originalWriter, "pull-orphan-original-operation"));
      await request(() => originalWriter.sync.synchronizeProject({
        projectId: originalWriter.projectId,
        reason: "owner",
      }));
      const orphaned = remote.server.operations[0];
      if (orphaned === undefined) throw new Error("TEST_ORPHANED_OPERATION_MISSING");

      const authorize = reader.store.authorizeCanonicalMemoryPullResult.bind(reader.store);
      let failOnce = true;
      Object.defineProperty(reader.store, "authorizeCanonicalMemoryPullResult", {
        configurable: true,
        value: (input: Parameters<StateStore["authorizeCanonicalMemoryPullResult"]>[0]) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("TEST_CRASH_BEFORE_ORPHANED_PULL_AUTHORIZATION");
          }
          return authorize(input);
        },
      });
      await expect(request(() => reader.sync.synchronizeProject({
        projectId: reader.projectId,
        reason: "owner",
      }))).rejects.toThrow("TEST_CRASH_BEFORE_ORPHANED_PULL_AUTHORIZATION");
      expect(reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId))
        .toMatchObject({ direction: "pull", state: "response_observed" });

      remote.server.operations.splice(0);
      await request(() => advanceLocal(branchWriter, "pull-orphan-replacement-one"));
      await request(() => branchWriter.sync.synchronizeProject({
        projectId: branchWriter.projectId,
        reason: "owner",
      }));
      await request(() => advanceLocal(branchWriter, "pull-orphan-replacement-two"));
      await request(() => branchWriter.sync.synchronizeProject({
        projectId: branchWriter.projectId,
        reason: "owner",
      }));
      expect(remote.server.operations).toHaveLength(2);
      expect(remote.server.operations[0]).not.toEqual(orphaned);

      Object.defineProperty(reader.store, "authorizeCanonicalMemoryPullResult", {
        configurable: true,
        value: authorize,
      });
      await expect(request(() => reader.sync.synchronizeProject({
        projectId: reader.projectId,
        reason: "recovery",
      }))).rejects.toThrow("REMOTE_MEMORY_DIVERGENCE");
      expect(reader.store.readProjectMemoryAuthority(reader.projectId)).toMatchObject({
        head: PROJECT_MEMORY_EMPTY_HEAD,
        syncState: "conflict",
      });
      expect(reader.store.readUnresolvedCanonicalMemorySyncIntent(reader.projectId)).toBeNull();
    }));
  });

  test("sticky-freezes an erased attached remote and zeroizes the authority snapshot", async () => {
    const remote = await createRemote();
    const device = await createDevice("remote-erasure", remote.source);
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    remote.server.missing = true;

    await expect(device.sync.synchronizeProject({
      projectId: device.projectId,
      reason: "owner",
    })).rejects.toThrow("REMOTE_MEMORY_ERASED");
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      state: "conflict",
    });
    expect(device.store.readProjectMemoryAuthority(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      syncState: "conflict",
    });
    expect(remote.source.accountKeySnapshots.at(-1)?.every((byte) => byte === 0)).toBe(true);
  });

  test("sticky-freezes remote regression while recovering an uncertain push", async () => {
    const remote = await createRemote();
    const device = await createDevice("remote-regression", remote.source);
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    await advanceLocal(device, "regression-base");
    await device.sync.synchronizeProject({ projectId: device.projectId, reason: "owner" });
    await advanceLocal(device, "regression-pending");
    remote.server.failAfterApplyOnce = true;
    await expect(device.sync.synchronizeProject({
      projectId: device.projectId,
      reason: "owner",
    })).rejects.toBeInstanceOf(CanonicalMemoryTransportError);
    expect(remote.server.operations).toHaveLength(2);

    remote.server.operations.splice(0);
    await expect(device.sync.synchronizeProject({
      projectId: device.projectId,
      reason: "recovery",
    })).rejects.toThrow("REMOTE_MEMORY_RECOVERY_CONFLICT");
    expect(device.store.readUnresolvedCanonicalMemorySyncIntent(device.projectId)).toBeNull();
    expect(device.store.readCanonicalMemoryHostedAttachment(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_RECOVERY_CONFLICT",
      state: "conflict",
    });
    expect(device.store.readProjectMemoryAuthority(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_RECOVERY_CONFLICT",
      syncState: "conflict",
    });
  });

  test("does not settle an observed push after the remote rolls back", async () => {
    const remote = await createRemote();
    const device = await createDevice("observed-push-regression", remote.source);
    await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    await advanceLocal(device, "observed-before-settle");
    const settle = device.store.settleCanonicalMemorySync.bind(device.store);
    let failOnce = true;
    Object.defineProperty(device.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: (input: Parameters<StateStore["settleCanonicalMemorySync"]>[0]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("TEST_CRASH_AFTER_PUSH_RESPONSE");
        }
        return settle(input);
      },
    });
    await expect(device.sync.synchronizeProject({
      projectId: device.projectId,
      reason: "owner",
    })).rejects.toThrow("TEST_CRASH_AFTER_PUSH_RESPONSE");
    expect(device.store.readUnresolvedCanonicalMemorySyncIntent(device.projectId))
      .toMatchObject({ direction: "push", state: "response_observed" });
    expect(remote.server.operations).toHaveLength(1);

    Object.defineProperty(device.store, "settleCanonicalMemorySync", {
      configurable: true,
      value: settle,
    });
    remote.server.operations.splice(0);
    await expect(device.sync.synchronizeProject({
      projectId: device.projectId,
      reason: "recovery",
    })).rejects.toThrow("REMOTE_MEMORY_RECOVERY_CONFLICT");
    expect(device.store.readProjectMemoryAuthority(device.projectId)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_RECOVERY_CONFLICT",
      syncState: "conflict",
    });
  });

  test("sticky-freezes when a lower remote head is not an ancestor of local history", async () => {
    const remote = await createRemote();
    const writer = await createDevice("history-writer", remote.source);
    const divergent = await createDevice("history-divergent", remote.source);
    await writer.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: writer.projectId,
    });
    await divergent.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: divergent.projectId,
    });
    await advanceLocal(writer, "remote-history");
    await writer.sync.synchronizeProject({ projectId: writer.projectId, reason: "owner" });
    await advanceLocal(divergent, "divergent-one");
    await advanceLocal(divergent, "divergent-two");

    await expect(divergent.sync.synchronizeProject({
      projectId: divergent.projectId,
      reason: "owner",
    })).rejects.toThrow("REMOTE_MEMORY_HISTORY_CONFLICT");
    expect(remote.server.operations).toHaveLength(1);
    expect(divergent.store.readUnresolvedCanonicalMemorySyncIntent(divergent.projectId))
      .toBeNull();
    expect(divergent.store.readCanonicalMemoryHostedAttachment(divergent.projectId))
      .toMatchObject({
        diagnosticCode: "REMOTE_MEMORY_HISTORY_CONFLICT",
        state: "conflict",
      });
  });

  test("hosted-space listing reports only active attachments", async () => {
    const remote = await createRemote();
    const device = await createDevice("list-attachment", remote.source);
    const attached = await device.sync.attachHostedSpace({
      hostedSpaceId: remote.hostedSpaceId,
      projectId: device.projectId,
    });
    expect(await device.sync.listHostedSpaces()).toEqual([
      expect.objectContaining({ attachedProjectId: device.projectId }),
    ]);

    await device.sync.detachHostedSpace({
      expectedGeneration: attached.generation,
      projectId: device.projectId,
    });
    expect(await device.sync.listHostedSpaces()).toEqual([
      expect.objectContaining({ attachedProjectId: null }),
    ]);
  });
});
