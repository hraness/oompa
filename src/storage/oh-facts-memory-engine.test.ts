import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKnowledgeGraphRecordV1, sha256Hex } from "@hraness/oh";
import { OH_LIBSQL_STORE_LIMITS_V1 } from "@hraness/oh/libsql";
import {
  createOhMemoryPageRecordV1,
  OH_MEMORY_LIMITS_V1,
  OH_MEMORY_PAGE_FORMAT_V1,
} from "@hraness/oh/memory";
import {
  OhSqliteStore,
  applyOhSqliteMigrations,
  createOhSqliteStoreAuthorityV1,
} from "@hraness/oh/sqlite";
import {
  OH_CANONICAL_STORE_PROFILE_V1,
  OH_WORKING_STORE_PROFILE_V1,
  emptyOhHeadV1,
} from "@hraness/oh/store";

import {
  createFactsMemoryBinding,
  type FactsMemoryBinding,
  type FactsMemoryCheckpoint,
} from "../domain/facts-memory";
import { OompaFactsMemoryLifecycle } from "../daemon/facts-memory-lifecycle";
import { FactsMemoryControlStore } from "./facts-memory-control";
import { LocalFactsMemoryBroker } from "./local-facts-memory-broker";
import {
  OOMPA_OH_FACTS_MEMORY_LIMITS_V1,
  inspectOhCanonicalDatabaseForRecovery,
  OhCanonicalDatabaseInspectionError,
  OhSqliteFactsMemoryEngine,
  projectOhHead,
  type OhCanonicalReplicationInput,
  type OpenOhCanonicalReplication,
  type OpenOhWorkingMemoryStores,
} from "./oh-facts-memory-engine";
import { ensurePrivateDirectory } from "./paths";

const ownerId = `acct_${"a".repeat(32)}`;
const otherOwnerId = `acct_${"b".repeat(32)}`;
const parentSessionId = `sess_${"1".repeat(32)}`;
const childSessionId = `sess_${"2".repeat(32)}`;
const metadataName = ".hra-oh-adapter-v1.json";
const pendingMetadataName = ".hra-oh-adapter-v1.pending";
const migratingMetadataName = ".hra-oh-adapter-v1.migrating";

const roots: string[] = [];
const controls: FactsMemoryControlStore[] = [];
const testForkAttestations = {
  finalizeMemoryWorkingPageAttestationFork: () => 0,
};
afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

const fixture = async (now: () => number = () => 100) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-oh-engine-")));
  roots.push(root);
  await chmod(root, 0o700);
  const engine = new OhSqliteFactsMemoryEngine({ forkAttestations: testForkAttestations, now });
  const broker = new LocalFactsMemoryBroker({ engine, now, root });
  return { broker, engine, root };
};

const openOhAuthority = (binding: FactsMemoryBinding, directory: string) =>
  createOhSqliteStoreAuthorityV1({
    path: join(directory, "oh.sqlite"),
    profile: OH_WORKING_STORE_PROFILE_V1,
    realmId: `oompa:${binding.bindingDigest}`,
    spaceId: binding.epoch === 1
      ? `oompa:${binding.sessionId}`
      : `oompa:${binding.sessionId}:epoch:${String(binding.epoch)}`,
  });

const sqliteLogicalBytes = async (directory: string): Promise<number> => {
  let bytes = 0;
  for (const name of ["oh.sqlite", "oh.sqlite-wal"] as const) {
    try {
      bytes += (await stat(join(directory, name))).size;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return bytes;
};

const memoryPageRecord = (index: number, body: string) => createOhMemoryPageRecordV1({
  dependencies: [],
  key: `edition:memory-capacity-${String(index).padStart(4, "0")}`,
  value: {
    body,
    createdAt: "2026-09-04T00:00:00.000Z",
    format: OH_MEMORY_PAGE_FORMAT_V1,
    language: "en",
    provenance: {
      actorId: "hra.memory.host",
      attestationSha256: sha256Hex(`attestation:${String(index)}`),
      attestedAt: "2026-09-04T00:00:00.000Z",
      kind: "host-attested",
      v: 1,
    },
    sources: [],
    summary: `Capacity page ${String(index)}`,
    title: `Capacity page ${String(index)}`,
    updatedAt: "2026-09-04T00:00:00.000Z",
    v: 1,
  },
});

const inspectionHead = async (
  broker: LocalFactsMemoryBroker,
  binding: FactsMemoryBinding,
) => {
  const inspected = await broker.inspect(binding);
  if (inspected.status !== "present") throw new Error("Expected an active Oh store.");
  return inspected.inspection.head;
};

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

type AdapterMetadataFixture = Readonly<{
  adapterDigest: string;
  bindingDigest: string;
  createdAt: number;
  createKind: "create" | "fork";
  handleHash: string;
  initialHead: Readonly<{ digest: string; operationSha256: string | null; sequence: number }>;
  ohBindingSha256: string;
  operationKey: string;
  parent: null | Readonly<{
    bindingDigest: string;
    epoch: number;
    head: Readonly<{ digest: string; operationSha256: string | null; sequence: number }>;
    ownerId: string;
    sessionId: string;
  }>;
  receiptDigest: string;
  version: 1;
}>;

type LegacyMetadataFixture = Readonly<{
  adapterDigest: string;
  bindingDigest: string;
  createdAt: number;
  createKind: "create" | "fork";
  handleHash: string;
  initialHead: Readonly<{ digest: string; sequence: number }>;
  ohBindingSha256: string;
  operationKey: string;
  parent: null | Readonly<{
    bindingDigest: string;
    head: Readonly<{ digest: string; sequence: number }>;
    ownerId: string;
    sessionId: string;
  }>;
  receiptDigest: string;
  version: 1;
}>;

const signLegacyMetadataFixture = (
  body: Omit<LegacyMetadataFixture, "adapterDigest">,
): LegacyMetadataFixture => ({
  ...body,
  adapterDigest: digestParts("hra-oh-adapter-metadata-v1", [
    body.bindingDigest,
    String(body.createdAt),
    body.createKind,
    body.handleHash,
    String(body.initialHead.sequence),
    body.initialHead.digest,
    body.ohBindingSha256,
    body.operationKey,
    body.parent?.bindingDigest ?? "no-parent",
    body.parent?.ownerId ?? "no-parent",
    body.parent?.sessionId ?? "no-parent",
    body.parent === null ? "no-parent" : String(body.parent.head.sequence),
    body.parent?.head.digest ?? "no-parent",
    body.receiptDigest,
    String(body.version),
  ]),
});

const legacyReceiptDigestFixture = (
  body: Pick<
    LegacyMetadataFixture,
    "bindingDigest" | "createdAt" | "handleHash" | "initialHead"
  >,
): string => digestParts("hra-facts-memory-store-receipt-v1", [
  body.bindingDigest,
  body.handleHash,
  String(body.initialHead.sequence),
  body.initialHead.digest,
  String(body.createdAt),
]);

const makeLegacyMetadataFixture = (
  body: Omit<LegacyMetadataFixture, "adapterDigest" | "receiptDigest">,
): LegacyMetadataFixture => {
  const unsigned = { ...body, receiptDigest: "" };
  return signLegacyMetadataFixture({
    ...unsigned,
    receiptDigest: legacyReceiptDigestFixture(unsigned),
  });
};

const legacyMetadataFixture = (current: AdapterMetadataFixture): LegacyMetadataFixture =>
  makeLegacyMetadataFixture({
    bindingDigest: current.bindingDigest,
    createdAt: current.createdAt,
    createKind: current.createKind,
    handleHash: current.handleHash,
    initialHead: {
      digest: current.initialHead.digest,
      sequence: current.initialHead.sequence,
    },
    ohBindingSha256: current.ohBindingSha256,
    operationKey: current.operationKey,
    parent: current.parent === null ? null : {
      bindingDigest: current.parent.bindingDigest,
      head: {
        digest: current.parent.head.digest,
        sequence: current.parent.head.sequence,
      },
      ownerId: current.parent.ownerId,
      sessionId: current.parent.sessionId,
    },
    version: 1 as const,
  });

describe("released Oh SQLite facts-memory adapter", () => {
  test("opens a verified working store without touching durable canonical custody", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const receipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const expectedHead = await inspectionHead(broker, working);
    const brokenCanonicalDirectory = await ensurePrivateDirectory(
      join(root, "broken-durable-canonical"),
    );
    const brokenCanonicalDatabase = join(brokenCanonicalDirectory, "oh.sqlite");
    await symlink(join(root, "missing-canonical-target"), brokenCanonicalDatabase);

    let escaped: OpenOhWorkingMemoryStores | undefined;
    const completed = await engine.withWorkingMemoryStore({
      binding: working,
      directory: join(root, working.sessionId),
      expectedHandleHash: receipt.handleHash,
      expectedHead,
    }, async (stores) => {
      escaped = stores;
      expect(Object.keys(stores).sort()).toEqual(["ephemeralCanonical", "working"]);
      expect(stores.ephemeralCanonical.expectedHead).toEqual(emptyOhHeadV1());
      expect(stores.ephemeralCanonical.store.binding.profile.profileKind).toBe("canonical");
      expect(stores.working.store.binding.profile.profileKind).toBe("working");
      expect(await stores.ephemeralCanonical.store.verify()).toMatchObject({
        head: emptyOhHeadV1(),
        operations: 0,
        records: 0,
      });

      const record = createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:working-only",
        kind: "entity",
        v: 1,
        value: { name: "Working only" },
      });
      await expect(stores.ephemeralCanonical.store.commit({
        actorId: "hra.memory.host",
        changes: [{ kind: "put", record, v: 1 }],
        expectedHead: stores.ephemeralCanonical.expectedHead,
        operationId: "host.test.working-only-ephemeral-refusal",
      })).rejects.toThrow("FACTS_MEMORY_OH_WORKING_ONLY_EPHEMERAL_READ_ONLY");
      const committed = await stores.working.store.commit({
        actorId: "hra.memory.host",
        changes: [{ kind: "put", record, v: 1 }],
        expectedHead: stores.working.expectedHead,
        operationId: "host.test.working-only-commit",
      });
      return committed.operationSha256;
    });

    expect(completed.workingHead.operationSha256).toBe(completed.result);
    expect(completed.workingHead.sequence).toBe(1);
    expect(Object.keys(completed).sort()).toEqual(["result", "workingHead"]);
    expect((await lstat(brokenCanonicalDatabase)).isSymbolicLink()).toBe(true);
    expect(escaped).toBeDefined();
    await expect(escaped!.working.store.head()).rejects.toThrow();
    await expect(escaped!.ephemeralCanonical.store.head()).rejects.toThrow();
  });

  test("rechecks working custody and closes both capabilities after failure", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const receipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const expectedHead = await inspectionHead(broker, working);
    const directory = join(root, working.sessionId);
    const databasePath = join(directory, "oh.sqlite");
    let escaped: OpenOhWorkingMemoryStores | undefined;

    let callbackCalled = false;
    await expect(engine.withWorkingMemoryStore({
      binding: working,
      directory,
      expectedHandleHash: "f".repeat(64),
      expectedHead,
    }, async () => {
      callbackCalled = true;
    })).rejects.toThrow("FACTS_MEMORY_OH_HANDLE_MISMATCH");
    await expect(engine.withWorkingMemoryStore({
      binding: working,
      directory,
      expectedHandleHash: receipt.handleHash,
      expectedHead: { ...expectedHead, digest: "f".repeat(64) },
    }, async () => {
      callbackCalled = true;
    })).rejects.toThrow("FACTS_MEMORY_OH_WORKING_HEAD_CONFLICT");
    expect(callbackCalled).toBe(false);

    let failure: unknown;
    try {
      await engine.withWorkingMemoryStore({
        binding: working,
        directory,
        expectedHandleHash: receipt.handleHash,
        expectedHead,
      }, async (stores) => {
        escaped = stores;
        await rename(databasePath, join(directory, "oh.sqlite.replaced"));
        await writeFile(databasePath, new Uint8Array(), { mode: 0o600 });
      });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("FACTS_MEMORY_OH_WORKING_DATABASE_REPLACED");
    expect((failure as Error).message).not.toContain("CANONICAL");
    expect(escaped).toBeDefined();
    await expect(escaped!.working.store.head()).rejects.toThrow();
    await expect(escaped!.ephemeralCanonical.store.head()).rejects.toThrow();
  });

  test("exports and imports exact canonical operations through a callback-scoped host capability", async () => {
    const { broker, engine, root } = await fixture();
    const realmId = "hra:project-memory:replication-round-trip";
    const spaceId = "hra:project:replication-round-trip";
    const sourceDirectory = await ensurePrivateDirectory(join(root, "replication-source"));
    const targetDirectory = await ensurePrivateDirectory(join(root, "replication-target"));
    const sourceAuthority = createOhSqliteStoreAuthorityV1({
      path: join(sourceDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await sourceAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{
        kind: "put",
        record: createKnowledgeGraphRecordV1({
          dependencies: [],
          key: "entity:replicated",
          kind: "entity",
          v: 1,
          value: { name: "Replicated" },
        }),
        v: 1,
      }],
      expectedHead: await sourceAuthority.store.head(),
      operationId: "host.test.replication-source",
    });
    const sourceHead = await sourceAuthority.store.head();
    const sourceBindingSha256 = sourceAuthority.store.binding.bindingSha256;
    await sourceAuthority.store.close();
    const sourceInspection = inspectOhCanonicalDatabaseForRecovery(sourceDirectory);
    if (sourceInspection.state !== "present") throw new Error("Expected source inode receipt.");

    const exported = await engine.withCanonicalReplication({
      directory: sourceDirectory,
      expectedDatabaseFile: sourceInspection.file,
      expectedHead: projectOhHead(sourceHead),
      realmId,
      requireExisting: true,
      spaceId,
    }, async (opened) => {
      expect(Object.keys(opened).sort()).toEqual([
        "bindingSha256",
        "expectedHead",
        "replication",
      ]);
      expect(opened.bindingSha256).toBe(sourceBindingSha256);
      expect(opened.expectedHead).toEqual(sourceHead);
      expect(Object.keys(opened.replication).sort()).toEqual(["exportBundle", "importBundle"]);
      const page = await opened.replication.exportBundle({
        after: { operationSha256: null, sequence: 0 },
      });
      expect(page).toMatchObject({
        from: { operationSha256: null, sequence: 0 },
        hasMore: false,
        through: sourceHead,
        to: { operationSha256: sourceHead.operationSha256, sequence: 1 },
        v: 1,
      });
      expect(page.bundle.operations).toHaveLength(1);
      return { bundle: page.bundle, escaped: opened.replication };
    });
    expect(exported.canonicalHead).toEqual(sourceHead);
    await expect(exported.result.escaped.exportBundle({
      after: { operationSha256: null, sequence: 0 },
    })).rejects.toThrow();

    const imported = await engine.withCanonicalReplication({
      directory: targetDirectory,
      expectedHead: projectOhHead(emptyOhHeadV1()),
      realmId,
      requireVacant: true,
      spaceId,
    }, async (opened) => await opened.replication.importBundle({
      bundle: exported.result.bundle,
    }));
    expect(imported.result).toMatchObject({ imported: 1, status: "imported", v: 1 });
    expect(imported.canonicalHead).toEqual(sourceHead);

    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    await engine.withMemoryStores({
      canonical: {
        directory: targetDirectory,
        expectedHead: projectOhHead(imported.canonicalHead),
        realmId,
        requireExisting: true,
        spaceId,
      },
      working: {
        binding: working,
        directory: join(root, working.sessionId),
        expectedHandleHash: workingReceipt.handleHash,
        expectedHead: workingHead,
      },
    }, async (opened) => {
      expect(Object.hasOwn(opened.working, "replication")).toBe(false);
      expect(opened.working.store.binding.profile.capabilities.operationReplication).toBe(false);
    });
  });

  test("pins an exact canonical ancestor and rejects equivocation or regression", async () => {
    const { engine, root } = await fixture();
    const directory = await ensurePrivateDirectory(join(root, "replication-heads"));
    const realmId = "hra:project-memory:replication-heads";
    const spaceId = "hra:project:replication-heads";
    const authority = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:replication-first",
        kind: "entity",
        v: 1,
        value: { name: "First" },
      }), v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.replication-first",
    });
    const firstHead = await authority.store.head();
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:replication-second",
        kind: "entity",
        v: 1,
        value: { name: "Second" },
      }), v: 1 }],
      expectedHead: firstHead,
      operationId: "host.test.replication-second",
    });
    const currentHead = await authority.store.head();
    await authority.store.close();

    let omittedHeadCallbackCalled = false;
    expect(() => engine.withCanonicalReplication({
      directory,
      realmId,
      requireExisting: true,
      spaceId,
    } as unknown as OhCanonicalReplicationInput, async () => {
      omittedHeadCallbackCalled = true;
    })).toThrow();
    expect(omittedHeadCallbackCalled).toBe(false);

    const pinned = await engine.withCanonicalReplication({
      directory,
      expectedHead: projectOhHead(firstHead),
      realmId,
      requireExisting: true,
      spaceId,
    }, async (opened) => {
      expect(opened.expectedHead).toEqual(firstHead);
      return await opened.replication.exportBundle({
        after: { operationSha256: null, sequence: 0 },
        // A caller cannot widen the authority even through an unchecked JS
        // value: the wrapper reconstructs an exact request at the pin.
        through: currentHead,
      } as Parameters<typeof opened.replication.exportBundle>[0] & {
        through: typeof currentHead;
      });
    });
    expect(pinned.result.bundle.operations).toHaveLength(1);
    expect(pinned.canonicalHead).toEqual(currentHead);

    let called = false;
    await expect(engine.withCanonicalReplication({
      directory,
      expectedHead: { ...projectOhHead(firstHead), digest: "f".repeat(64) },
      realmId,
      requireExisting: true,
      spaceId,
    }, async () => {
      called = true;
    })).rejects.toThrow("FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION");
    expect(called).toBe(false);

    await expect(engine.withCanonicalReplication({
      directory,
      expectedHead: {
        ...projectOhHead(firstHead),
        digest: "e".repeat(64),
        operationSha256: "e".repeat(64),
      },
      realmId,
      requireExisting: true,
      spaceId,
    }, async () => undefined)).rejects.toThrow(
      "FACTS_MEMORY_OH_CANONICAL_HEAD_EQUIVOCATION",
    );

    await expect(engine.withCanonicalReplication({
      directory,
      expectedHead: { ...projectOhHead(currentHead), sequence: currentHead.sequence + 1 },
      realmId,
      requireExisting: true,
      spaceId,
    }, async () => undefined)).rejects.toThrow(
      "FACTS_MEMORY_OH_CANONICAL_HEAD_REGRESSION",
    );
  });

  test("reads only an exact verified canonical snapshot and refuses physical head drift", async () => {
    const { engine, root } = await fixture();
    const directory = await ensurePrivateDirectory(join(root, "canonical-summary"));
    const realmId = "hra:project-memory:canonical-summary";
    const spaceId = "hra:project:canonical-summary";
    const authority = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: memoryPageRecord(1, "first"), v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.canonical-summary-first",
    });
    const firstHead = await authority.store.head();
    await authority.store.close();

    const snapshot = await engine.inspectCanonicalMemorySnapshot({
      directory,
      expectedHead: projectOhHead(firstHead),
      realmId,
      requireExisting: true,
      spaceId,
    });
    expect(snapshot.bindingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.head).toEqual(firstHead);
    expect(snapshot.records).toEqual([memoryPageRecord(1, "first")]);
    expect(Object.hasOwn(snapshot, "store")).toBe(false);

    const advanced = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await advanced.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: memoryPageRecord(2, "second"), v: 1 }],
      expectedHead: await advanced.store.head(),
      operationId: "host.test.canonical-summary-second",
    });
    await advanced.store.close();

    await expect(engine.inspectCanonicalMemorySnapshot({
      directory,
      expectedHead: projectOhHead(firstHead),
      realmId,
      requireExisting: true,
      spaceId,
    })).rejects.toThrow("FACTS_MEMORY_OH_CANONICAL_HEAD_NOT_SETTLED");
  });

  test("rechecks canonical inode custody after replication and rejects oversized storage", async () => {
    const { engine, root } = await fixture();
    const realmId = "hra:project-memory:replication-custody";
    const spaceId = "hra:project:replication-custody";
    const directory = await ensurePrivateDirectory(join(root, "replication-custody"));
    const authority = createOhSqliteStoreAuthorityV1({
      path: join(directory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await authority.store.close();
    const inspection = inspectOhCanonicalDatabaseForRecovery(directory);
    if (inspection.state !== "present") throw new Error("Expected canonical inode receipt.");
    const escaped: OpenOhCanonicalReplication["replication"][] = [];
    await expect(engine.withCanonicalReplication({
      directory,
      expectedDatabaseFile: inspection.file,
      expectedHead: projectOhHead(emptyOhHeadV1()),
      realmId,
      requireExisting: true,
      spaceId,
    }, async (opened) => {
      escaped.push(opened.replication);
      await rename(join(directory, "oh.sqlite"), join(directory, "oh.sqlite.replaced"));
      await writeFile(join(directory, "oh.sqlite"), new Uint8Array(), { mode: 0o600 });
    })).rejects.toThrow("FACTS_MEMORY_OH_CANONICAL_DATABASE_REPLACED");
    expect(escaped).toHaveLength(1);
    await expect(escaped[0]!.exportBundle({
      after: { operationSha256: null, sequence: 0 },
    })).rejects.toThrow();
    expect((await stat(join(directory, "oh.sqlite"))).size).toBe(0);

    const oversizedDirectory = await ensurePrivateDirectory(join(root, "replication-oversized"));
    const oversized = createOhSqliteStoreAuthorityV1({
      path: join(oversizedDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId,
      spaceId,
    });
    await oversized.store.close();
    await truncate(
      join(oversizedDirectory, "oh.sqlite"),
      OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes + 1,
    );
    let oversizedCallbackCalled = false;
    await expect(engine.withCanonicalReplication({
      directory: oversizedDirectory,
      expectedHead: projectOhHead(emptyOhHeadV1()),
      realmId,
      requireExisting: true,
      spaceId,
    }, async () => {
      oversizedCallbackCalled = true;
    })).rejects.toThrow("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
    expect(oversizedCallbackCalled).toBe(false);
  });

  test("classifies legacy recovery without following sidecars or accepting a replaced main inode", async () => {
    const { broker, engine, root } = await fixture();
    const absentDirectory = join(root, "recovery-absent");
    expect(inspectOhCanonicalDatabaseForRecovery(absentDirectory)).toEqual({ state: "absent" });

    const sidecarOnly = await ensurePrivateDirectory(join(root, "recovery-sidecar-only"));
    await writeFile(join(sidecarOnly, "oh.sqlite-wal"), new Uint8Array(), { mode: 0o600 });
    expect(() => inspectOhCanonicalDatabaseForRecovery(sidecarOnly)).toThrow(
      "FACTS_MEMORY_OH_CANONICAL_DATABASE_UNSAFE",
    );
    try {
      inspectOhCanonicalDatabaseForRecovery(sidecarOnly);
      throw new Error("Expected unsafe sidecar evidence to be rejected.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OhCanonicalDatabaseInspectionError);
      expect(error).toMatchObject({ failure: "unsafe" });
    }

    const unavailableDirectory = join(root, "x".repeat(300));
    try {
      inspectOhCanonicalDatabaseForRecovery(unavailableDirectory);
      throw new Error("Expected an overlong lookup to be unavailable.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OhCanonicalDatabaseInspectionError);
      expect(error).toMatchObject({
        failure: "unavailable",
        message: "FACTS_MEMORY_OH_CANONICAL_DATABASE_INSPECTION_UNAVAILABLE",
      });
    }

    const directory = await ensurePrivateDirectory(join(root, "recovery-replaced"));
    const path = join(directory, "oh.sqlite");
    await writeFile(path, new Uint8Array(), { mode: 0o600 });
    const inspection = inspectOhCanonicalDatabaseForRecovery(directory);
    if (inspection.state !== "present") throw new Error("Expected a database inode receipt.");
    await rename(path, join(directory, "oh.sqlite.old"));
    await writeFile(path, new Uint8Array(), { mode: 0o600 });

    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    await expect(engine.withMemoryStores({
      canonical: {
        directory,
        expectedDatabaseFile: inspection.file,
        realmId: "hra:project-memory:replaced",
        requireExisting: true,
        spaceId: "hra:project:replaced",
      },
      working: {
        binding: working,
        directory: join(root, working.sessionId),
        expectedHandleHash: workingReceipt.handleHash,
        expectedHead: workingHead,
      },
    }, async () => undefined)).rejects.toThrow(
      "FACTS_MEMORY_OH_CANONICAL_DATABASE_REPLACED",
    );
    expect((await stat(path)).size).toBe(0);
  });

  test("requires total non-anchor vacancy before a bound canonical database is initialized", async () => {
    for (const hidden of ["sync", "fts", "operation-record"] as const) {
      const { broker, engine, root } = await fixture();
      const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
      const workingReceipt = await broker.create({
        binding: working,
        operationKey: `create:${working.sessionId}`,
      });
      const workingHead = await inspectionHead(broker, working);
      const directory = await ensurePrivateDirectory(join(root, `vacancy-${hidden}`));
      const spaceId = `hra:project:vacancy-${hidden}`;
      const realmId = `hra:project-memory:vacancy-${hidden}`;
      const authority = createOhSqliteStoreAuthorityV1({
        path: join(directory, "oh.sqlite"),
        profile: OH_CANONICAL_STORE_PROFILE_V1,
        realmId,
        spaceId,
      });
      await authority.store.close();
      const database = new Database(join(directory, "oh.sqlite"));
      try {
        if (hidden === "sync") {
          database.query(
            `INSERT INTO oh_sync_state(
               remote_id,space_id,pulled_sequence,pushed_sequence,remote_head_sha256,updated_at
             ) VALUES ('hidden',?,0,0,NULL,'2026-09-06T00:00:00.000Z')`,
          ).run(spaceId);
        } else if (hidden === "fts") {
          database.query(
            "INSERT INTO oh_search_fts(space_id,record_key,text) VALUES (?,'ghost','hidden')",
          ).run(spaceId);
        } else {
          database.exec("PRAGMA foreign_keys=OFF");
          database.query(
            `INSERT INTO oh_operation_records(
               operation_sha256,ordinal,record_key,change_kind,record_sha256
             ) VALUES (?,0,'ghost','tombstone',NULL)`,
          ).run("a".repeat(64));
          database.exec("PRAGMA foreign_keys=ON");
        }
      } finally {
        database.close(false);
      }

      await expect(engine.withMemoryStores({
        canonical: { directory, realmId, requireExisting: true, requireVacant: true, spaceId },
        working: {
          binding: working,
          directory: join(root, working.sessionId),
          expectedHandleHash: workingReceipt.handleHash,
          expectedHead: workingHead,
        },
      }, async () => undefined)).rejects.toThrow(
        "FACTS_MEMORY_OH_CANONICAL_MULTIPLE_SPACES_REFUSED",
      );
    }
  });

  test("refuses an alien canonical space without inserting the requested space", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    const canonicalDirectory = await ensurePrivateDirectory(join(root, "single-space-canonical"));
    const alien = createOhSqliteStoreAuthorityV1({
      path: join(canonicalDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: "hra:project-memory:space-alien",
      spaceId: "hra:project:space-alien",
    });
    await alien.store.close();

    await expect(engine.withMemoryStores({
      canonical: {
        directory: canonicalDirectory,
        realmId: "hra:project-memory:space-primary",
        spaceId: "hra:project:space-primary",
      },
      working: {
        binding: working,
        directory: join(root, working.sessionId),
        expectedHandleHash: workingReceipt.handleHash,
        expectedHead: workingHead,
      },
    }, async () => undefined)).rejects.toThrow(
      "FACTS_MEMORY_OH_CANONICAL_MULTIPLE_SPACES_REFUSED",
    );

    const database = new Database(join(canonicalDirectory, "oh.sqlite"), { readonly: true });
    try {
      for (const table of ["oh_spaces", "oh_space_bindings"] as const) {
        expect(database.query<{ space_id: string }, []>(
          `SELECT space_id FROM ${table} ORDER BY space_id`,
        ).all()).toEqual([{ space_id: "hra:project:space-alien" }]);
      }
    } finally {
      database.close();
    }
  });

  test("recovers exact empty SQLite bootstrap states before binding one space", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    const expectedSpaceId = "hra:project:bootstrap-recovery";
    const expectedRealmId = "hra:project-memory:bootstrap-recovery";

    for (const state of ["migrated", "space-created"] as const) {
      const directory = await ensurePrivateDirectory(join(root, `bootstrap-${state}`));
      const path = join(directory, "oh.sqlite");
      if (state === "migrated") {
        const database = new Database(path);
        try {
          applyOhSqliteMigrations(database);
        } finally {
          database.close(false);
        }
      } else {
        const interrupted = new OhSqliteStore({ path, spaceId: expectedSpaceId });
        interrupted.close();
      }

      await expect(engine.withMemoryStores({
        canonical: {
          directory,
          realmId: expectedRealmId,
          spaceId: expectedSpaceId,
        },
        working: {
          binding: working,
          directory: join(root, working.sessionId),
          expectedHandleHash: workingReceipt.handleHash,
          expectedHead: workingHead,
        },
      }, async () => undefined)).resolves.toMatchObject({
        canonicalHead: { sequence: 0 },
      });

      const database = new Database(path, { readonly: true });
      try {
        expect(database.query<{ space_id: string }, []>(
          "SELECT space_id FROM oh_spaces",
        ).all()).toEqual([{ space_id: expectedSpaceId }]);
        expect(database.query<{ space_id: string }, []>(
          "SELECT space_id FROM oh_space_bindings",
        ).all()).toEqual([{ space_id: expectedSpaceId }]);
      } finally {
        database.close();
      }
    }
  });

  test("rejects orphan foreign-key, search, and purge space rows", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    const canonicalDirectory = await ensurePrivateDirectory(join(root, "hidden-space-rows"));
    const canonicalInput = {
      directory: canonicalDirectory,
      realmId: "hra:project-memory:hidden-space-rows",
      spaceId: "hra:project:hidden-space-rows",
    } as const;
    const stores = {
      canonical: canonicalInput,
      working: {
        binding: working,
        directory: join(root, working.sessionId),
        expectedHandleHash: workingReceipt.handleHash,
        expectedHead: workingHead,
      },
    } as const;
    await engine.withMemoryStores(stores, async () => undefined);

    const database = new Database(join(canonicalDirectory, "oh.sqlite"));
    try {
      database.exec("PRAGMA foreign_keys=OFF");
      database.query(
        `INSERT INTO oh_sync_state(
           remote_id,space_id,pulled_sequence,pushed_sequence,remote_head_sha256,updated_at
         ) VALUES ('alien-remote','alien-space',0,0,NULL,'2026-09-06T00:00:00.000Z')`,
      ).run();
      database.query(
        "INSERT INTO oh_search_fts(space_id,record_key,text) VALUES ('alien-space','alien:key','hidden')",
      ).run();
      database.query(
        `INSERT INTO oh_space_purges(
           space_id,binding_sha256,prior_operation_sha256,prior_sequence,
           purged_at,receipt_sha256,receipt_json
         ) VALUES ('alien-space',?,NULL,0,'2026-09-06T00:00:00.000Z',?,?)`,
      ).run("a".repeat(64), "b".repeat(64), JSON.stringify({ alien: true }));
      database.exec("PRAGMA foreign_keys=ON");
    } finally {
      database.close(false);
    }

    await expect(engine.withMemoryStores(stores, async () => undefined)).rejects.toThrow(
      "FACTS_MEMORY_OH_CANONICAL_MULTIPLE_SPACES_REFUSED",
    );
  });

  test("pins the immutable public v0.10.8 release without installing optional semantic peers", async () => {
    const packageDocument = JSON.parse(
      await readFile(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(packageDocument.dependencies?.["@hraness/oh"])
      .toBe("0.10.8");
    const lockfile = await readFile(join(import.meta.dir, "..", "..", "bun.lock"), "utf8");
    expect(lockfile).toContain('"@hraness/oh": ["@hraness/oh@0.10.8"');
    expect(lockfile).toContain("sha512-rtm+D1pzlxTE84zAnIFq3dxQulU/HpstnaUYYW1Cl9HjNG1p+Z0Oy0oNTUQpxtYHh3XClDS2MLsV693WcUwOOA==");
    expect(lockfile).not.toContain("@hraness/oh@github:");
    expect(OH_LIBSQL_STORE_LIMITS_V1.snapshotComponentBytes).toBe(6 * 1024 * 1024);
    expect(OH_LIBSQL_STORE_LIMITS_V1.providerResponseBytes).toBe(9_000_000);
    await expect(lstat(join(import.meta.dir, "..", "..", "node_modules", "@suss", "datalog")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates, verifies, reopens, advances, and physically purges one working store", async () => {
    let now = 100;
    const { broker, root } = await fixture(() => now);
    const binding = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const created = await broker.create({ binding, operationKey: `create:${binding.sessionId}` });
    expect(created).toMatchObject({ createdAt: 100, head: { sequence: 0 } });
    const databasePath = join(root, binding.sessionId, "oh.sqlite");
    expect((await lstat(databasePath)).isFile()).toBe(true);
    expect((await lstat(databasePath)).mode & 0o077).toBe(0);
    expect((await lstat(join(root, binding.sessionId, metadataName))).mode & 0o077).toBe(0);

    await rename(
      join(root, binding.sessionId, metadataName),
      join(root, binding.sessionId, pendingMetadataName),
    );
    const restartedBroker = new LocalFactsMemoryBroker({
      engine: new OhSqliteFactsMemoryEngine({
        forkAttestations: testForkAttestations,
        now: () => 150,
      }),
      now: () => 150,
      root,
    });
    await expect(restartedBroker.inspect(binding)).resolves.toMatchObject({
      status: "present",
      inspection: { createdAt: 100, initialHead: created.head },
    });
    await expect(lstat(join(root, binding.sessionId, pendingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const legacyMetadataPath = join(root, binding.sessionId, metadataName);
    const currentMetadata = JSON.parse(
      await readFile(legacyMetadataPath, "utf8"),
    ) as AdapterMetadataFixture;
    const legacyMetadata = legacyMetadataFixture(currentMetadata);
    await writeFile(legacyMetadataPath, JSON.stringify(legacyMetadata), { mode: 0o600 });
    await writeFile(join(root, binding.sessionId, migratingMetadataName), "{", { mode: 0o600 });
    expect(await restartedBroker.inspect(binding)).toMatchObject({ status: "present" });
    const migratedMetadata = JSON.parse(await readFile(legacyMetadataPath, "utf8")) as {
      adapterDigest: string;
      initialHead: Record<string, unknown>;
    };
    expect(migratedMetadata.initialHead.operationSha256).toBeNull();
    expect(migratedMetadata.adapterDigest).not.toBe(legacyMetadata.adapterDigest);
    await expect(lstat(join(root, binding.sessionId, migratingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    await chmod(legacyMetadataPath, 0o666);
    await expect(restartedBroker.inspect(binding)).rejects.toThrow("FACTS_MEMORY_OH_METADATA_UNSAFE");
    await chmod(legacyMetadataPath, 0o600);

    await chmod(databasePath, 0o666);
    expect((await lstat(databasePath)).mode & 0o077).not.toBe(0);
    await expect(broker.inspect(binding)).resolves.toMatchObject({ status: "present" });
    expect((await lstat(databasePath)).mode & 0o077).toBe(0);

    now = 200;
    expect(await broker.create({ binding, operationKey: `create:${binding.sessionId}` })).toEqual(created);
    const authority = openOhAuthority(binding, join(root, binding.sessionId));
    const record = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "assertion:session-fact",
      kind: "assertion",
      v: 1,
      value: { predicate: "session.remembers", subject: "agent" },
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.remember",
    });
    await authority.store.close();

    const inspected = await broker.inspect(binding);
    expect(inspected).toMatchObject({
      status: "present",
      inspection: {
        createdAt: 100,
        initialHead: { sequence: 0 },
        head: { sequence: 1 },
      },
    });
    await expect(broker.inspect(createFactsMemoryBinding({
      ownerId: otherOwnerId,
      sessionId: binding.sessionId,
    }))).rejects.toThrow();

    await writeFile(legacyMetadataPath, '{"tampered":true}', { mode: 0o600 });
    await broker.purge({
      binding,
      expectedHandleHash: created.handleHash,
      operationKey: `cleanup:${binding.sessionId}:archive`,
    });
    await expect(lstat(join(root, binding.sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("migrates an exact empty legacy fork across a completed migration crash", async () => {
    const { broker, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const emptyParentHead = await inspectionHead(broker, parent);
    expect(emptyParentHead).toMatchObject({ operationSha256: null, sequence: 0 });
    await broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: emptyParentHead },
    });

    const childDirectory = join(root, child.sessionId);
    const metadataPath = join(childDirectory, metadataName);
    const currentMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as AdapterMetadataFixture;
    expect(currentMetadata.initialHead).toMatchObject({ operationSha256: null, sequence: 0 });
    expect(currentMetadata.parent).toMatchObject({
      epoch: 1,
      head: { operationSha256: null, sequence: 0 },
    });
    const legacyMetadata = legacyMetadataFixture(currentMetadata);
    expect(Object.hasOwn(legacyMetadata.initialHead, "operationSha256")).toBe(false);
    expect(legacyMetadata.parent === null || Object.hasOwn(legacyMetadata.parent, "epoch")).toBe(false);
    expect(
      legacyMetadata.parent === null || Object.hasOwn(legacyMetadata.parent.head, "operationSha256"),
    ).toBe(false);

    await writeFile(metadataPath, JSON.stringify(legacyMetadata), { mode: 0o600 });
    await writeFile(
      join(childDirectory, migratingMetadataName),
      JSON.stringify(currentMetadata),
      { mode: 0o600 },
    );
    await expect(broker.inspect(child)).resolves.toMatchObject({
      status: "present",
      inspection: { initialHead: { operationSha256: null, sequence: 0 } },
    });
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(currentMetadata);
    await expect(lstat(join(childDirectory, migratingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    const source = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:legacy-nonempty",
      kind: "entity",
      v: 1,
      value: { name: "Nonempty" },
    });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: source, v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.legacy-nonempty",
    });
    await parentAuthority.store.close();
    const nonemptyChild = createFactsMemoryBinding({
      ownerId,
      sessionId: `sess_${"5".repeat(32)}`,
    });
    const nonemptyReceipt = await broker.fork({
      binding: nonemptyChild,
      operationKey: `fork:${nonemptyChild.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    });
    const nonemptyDirectory = join(root, nonemptyChild.sessionId);
    const nonemptyMetadataPath = join(nonemptyDirectory, metadataName);
    const nonemptyMetadata = JSON.parse(
      await readFile(nonemptyMetadataPath, "utf8"),
    ) as AdapterMetadataFixture;
    const nonemptyLegacy = legacyMetadataFixture(nonemptyMetadata);
    expect(nonemptyLegacy.receiptDigest).not.toBe(nonemptyMetadata.receiptDigest);
    await writeFile(
      nonemptyMetadataPath,
      JSON.stringify(nonemptyLegacy),
      { mode: 0o600 },
    );
    await expect(broker.inspect(nonemptyChild))
      .rejects.toThrow("FACTS_MEMORY_OH_LEGACY_NONEMPTY_RECOVERY_REQUIRED");
    await expect(broker.purge({
      binding: nonemptyChild,
      expectedHandleHash: nonemptyReceipt.handleHash,
      operationKey: `cleanup:${nonemptyChild.sessionId}:expired`,
    })).resolves.toMatchObject({ handleHash: nonemptyReceipt.handleHash });
    await expect(lstat(nonemptyDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("repairs a crash-partial pending sidecar without accepting a path alias", async () => {
    const { broker, engine, root } = await fixture();
    const binding = createFactsMemoryBinding({
      ownerId,
      sessionId: `sess_${"3".repeat(32)}`,
    });
    const directory = join(root, binding.sessionId);
    await ensurePrivateDirectory(directory);
    await writeFile(join(directory, pendingMetadataName), "{", { encoding: "utf8", mode: 0o600 });
    await expect(broker.create({
      binding,
      operationKey: `create:${binding.sessionId}`,
    })).resolves.toMatchObject({ bindingDigest: binding.bindingDigest, head: { sequence: 0 } });
    expect((await lstat(join(directory, metadataName))).mode & 0o077).toBe(0);
    await expect(lstat(join(directory, pendingMetadataName)))
      .rejects.toMatchObject({ code: "ENOENT" });

    await expect(engine.inspect({
      binding,
      directory: `${directory}/../${binding.sessionId}`,
    })).rejects.toThrow("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");
  });

  test("forks one exact parent snapshot without copying working operation authority", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    const source = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:source",
      kind: "entity",
      v: 1,
      value: { name: "Source" },
    });
    const dependent = createKnowledgeGraphRecordV1({
      dependencies: [source.key],
      key: "assertion:dependent",
      kind: "assertion",
      v: 1,
      value: { claim: "bounded" },
    });
    const parentOperation = await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [
        { kind: "put", record: dependent, v: 1 },
        { kind: "put", record: source, v: 1 },
      ],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.parent",
    });
    await parentAuthority.store.close();
    const parentHead = await inspectionHead(broker, parent);
    const checkpoint: FactsMemoryCheckpoint = { ...parent, head: parentHead };

    const forked = await broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: checkpoint,
    });
    expect(forked.head.sequence).toBe(1);
    const childAuthority = openOhAuthority(child, join(root, child.sessionId));
    const childSnapshot = await childAuthority.store.snapshot({ maximumRecords: 8_192 });
    const childChanges = await childAuthority.store.changesSince({
      operationSha256: null,
      sequence: 0,
    });
    expect(childSnapshot.records.map((record) => [record.key, record.recordSha256])).toEqual([
      [dependent.key, dependent.recordSha256],
      [source.key, source.recordSha256],
    ]);
    expect(childChanges.operations).toHaveLength(1);
    expect(childChanges.operations[0]).toMatchObject({
      actorId: "hra.memory.host",
      parentOperationSha256: null,
      sequence: 1,
    });
    expect(childChanges.operations[0]?.operationId).toMatch(/^hra\.fork\./u);
    expect(childChanges.operations[0]?.operationId).not.toBe(parentOperation.operationId);
    expect(childChanges.operations[0]?.operationSha256).not.toBe(parentOperation.operationSha256);
    expect((await childAuthority.store.verify()).operations).toBe(1);
    expect(childAuthority.store.binding.profile).toEqual(OH_WORKING_STORE_PROFILE_V1);
    await childAuthority.store.close();

    const advancedParent = openOhAuthority(parent, join(root, parent.sessionId));
    await advancedParent.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:later",
        kind: "entity",
        v: 1,
        value: { name: "Later" },
      }), v: 1 }],
      expectedHead: await advancedParent.store.head(),
      operationId: "host.test.later",
    });
    await advancedParent.store.close();
    await expect(engine.fork({
      binding: child,
      directory: join(root, child.sessionId),
      operationKey: `fork:${child.sessionId}`,
      parent: checkpoint,
      parentDirectory: join(root, parent.sessionId),
    })).resolves.toEqual(forked);
  });

  test("reconciles a fork commit that completed before adapter metadata publication", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const record = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:reconcile",
      kind: "entity",
      v: 1,
      value: { name: "Reconcile" },
    });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.reconcile.parent",
    });
    await parentAuthority.store.close();
    const checkpoint: FactsMemoryCheckpoint = {
      ...parent,
      head: await inspectionHead(broker, parent),
    };
    const childDirectory = join(root, child.sessionId);
    await ensurePrivateDirectory(childDirectory);
    const operationKey = `fork:${child.sessionId}`;
    const childAuthority = openOhAuthority(child, childDirectory);
    await childAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record, v: 1 }],
      expectedHead: await childAuthority.store.head(),
      operationId: `hra.fork.${digestParts("hra-oh-fork-operation-v1", [operationKey])}`,
    });
    await childAuthority.store.close();
    await expect(engine.inspect({ binding: child, directory: childDirectory }))
      .resolves.toEqual({ status: "missing" });

    const receipt = await engine.fork({
      binding: child,
      directory: childDirectory,
      operationKey,
      parent: checkpoint,
      parentDirectory: join(root, parent.sessionId),
    });
    expect(receipt.head.sequence).toBe(1);
    const reopened = openOhAuthority(child, childDirectory);
    expect((await reopened.store.verify()).operations).toBe(1);
    await reopened.store.close();
  });

  test("replays fork attestation finalization against the immutable initial child head", async () => {
    const { root } = await fixture();
    const calls: Array<Readonly<{
      childBindingDigest: string;
      childHead: { digest: string; operationSha256: string | null; sequence: number };
      parentBindingDigest: string;
      parentHead: { digest: string; operationSha256: string | null; sequence: number };
    }>> = [];
    let loseFirstResponse = true;
    const engine = new OhSqliteFactsMemoryEngine({
      forkAttestations: {
        finalizeMemoryWorkingPageAttestationFork: (input) => {
          calls.push(input);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error("lost fork attestation finalization response");
          }
          return 0;
        },
      },
      now: () => 120,
    });
    const broker = new LocalFactsMemoryBroker({ engine, now: () => 120, root });
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const source = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:attested-fork",
      kind: "entity",
      v: 1,
      value: { name: "Attested fork" },
    });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: source, v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.attested-fork.parent",
    });
    await parentAuthority.store.close();
    const checkpoint: FactsMemoryCheckpoint = {
      ...parent,
      head: await inspectionHead(broker, parent),
    };
    const forkInput = {
      binding: child,
      directory: join(root, child.sessionId),
      operationKey: `fork:${child.sessionId}`,
      parent: checkpoint,
      parentDirectory: join(root, parent.sessionId),
    } as const;
    await ensurePrivateDirectory(forkInput.directory);
    await expect(engine.fork(forkInput)).rejects.toThrow(
      "lost fork attestation finalization response",
    );
    const receipt = await engine.fork(forkInput);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.childHead).toEqual(receipt.head);
    expect(calls[1]?.childHead).toEqual(receipt.head);

    const childAuthority = openOhAuthority(child, forkInput.directory);
    await childAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:child-later",
        kind: "entity",
        v: 1,
        value: { name: "Child later" },
      }), v: 1 }],
      expectedHead: await childAuthority.store.head(),
      operationId: "host.test.attested-fork.child-later",
    });
    const advancedHead = projectOhHead(await childAuthority.store.head());
    await childAuthority.store.close();
    expect(advancedHead.sequence).toBeGreaterThan(receipt.head.sequence);
    await expect(engine.fork(forkInput)).resolves.toEqual(receipt);
    expect(calls[2]?.childHead).toEqual(receipt.head);
  });

  test("reconciles a child commit through lifecycle after the recorded parent checkpoint advances", async () => {
    const { broker, root } = await fixture();
    const control = new FactsMemoryControlStore(join(root, "control.sqlite"), { now: () => 90 });
    controls.push(control);
    const lifecycle = new OompaFactsMemoryLifecycle({ broker, control });
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await lifecycle.ensureSession({ ownerId, sessionId: parent.sessionId, expiresAt: 1_000 });
    const source = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:crash-source",
      kind: "entity",
      v: 1,
      value: { name: "Crash source" },
    });
    const parentAuthority = openOhAuthority(parent, join(root, parent.sessionId));
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: source, v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.crash.parent",
    });
    await parentAuthority.store.close();
    const resumed = await lifecycle.resumeSession({ ownerId, sessionId: parent.sessionId });
    if (resumed.head === null) throw new Error("Expected exact parent checkpoint.");
    const checkpoint: FactsMemoryCheckpoint = { ...parent, head: resumed.head };
    const operationKey = `fork:${child.sessionId}`;
    control.reserve({ binding: child, createOperationKey: operationKey, expiresAt: 2_000, parent: checkpoint });
    control.markCreating(child);
    const childDirectory = join(root, child.sessionId);
    await ensurePrivateDirectory(childDirectory);
    const interruptedChild = openOhAuthority(child, childDirectory);
    await interruptedChild.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: source, v: 1 }],
      expectedHead: await interruptedChild.store.head(),
      operationId: `hra.fork.${digestParts("hra-oh-fork-operation-v1", [operationKey])}`,
    });
    await interruptedChild.store.close();
    control.markCreateAmbiguous(child);

    const advancedParent = openOhAuthority(parent, join(root, parent.sessionId));
    const later = createKnowledgeGraphRecordV1({
      dependencies: [],
      key: "entity:crash-later",
      kind: "entity",
      v: 1,
      value: { name: "Later" },
    });
    await advancedParent.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: later, v: 1 }],
      expectedHead: await advancedParent.store.head(),
      operationId: "host.test.crash.parent.later",
    });
    await advancedParent.store.close();

    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId: parent.sessionId,
    })).rejects.toThrow("FACTS_MEMORY_PARENT_REFERENCED");
    expect((await lstat(join(root, parent.sessionId))).isDirectory()).toBe(true);
    await expect(lifecycle.forkSession({
      childExpiresAt: 2_000,
      childSessionId: child.sessionId,
      ownerId,
      parentSessionId: parent.sessionId,
    })).resolves.toMatchObject({ state: "active" });
    const reopened = openOhAuthority(child, childDirectory);
    expect((await reopened.store.snapshot({ maximumRecords: 8_192 })).records.map(({ key }) => key))
      .toEqual([source.key]);
    expect((await reopened.store.verify()).operations).toBe(1);
    await reopened.store.close();
    await expect(lifecycle.cleanupSession({
      ownerId,
      reason: "archive",
      sessionId: parent.sessionId,
    })).resolves.toMatchObject({ state: "purged" });
  });

  test("rejects a copied sidecar over a valid divergent same-binding history", async () => {
    const { broker, root } = await fixture();
    const binding = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    await broker.create({ binding, operationKey: `create:${binding.sessionId}` });
    const directory = join(root, binding.sessionId);
    const first = openOhAuthority(binding, directory);
    await first.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [], key: "entity:accepted", kind: "entity", v: 1, value: { branch: "accepted" },
      }), v: 1 }],
      expectedHead: await first.store.head(),
      operationId: "host.test.accepted",
    });
    await first.store.close();
    const accepted = await inspectionHead(broker, binding);

    await rm(join(directory, "oh.sqlite"));
    const replacement = openOhAuthority(binding, directory);
    for (const [key, operationId] of [
      ["entity:alternate-one", "host.test.alternate.one"],
      ["entity:alternate-two", "host.test.alternate.two"],
    ] as const) {
      await replacement.store.commit({
        actorId: "hra.memory.host",
        changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
          dependencies: [], key, kind: "entity", v: 1, value: { branch: key },
        }), v: 1 }],
        expectedHead: await replacement.store.head(),
        operationId,
      });
    }
    await replacement.store.close();
    await expect(broker.inspect(binding, accepted)).rejects.toThrow();
  });

  test("physically isolates a recreated expired session in its next epoch", async () => {
    const { broker, root } = await fixture();
    const control = new FactsMemoryControlStore(join(root, "control.sqlite"), { now: () => 90 });
    controls.push(control);
    const lifecycle = new OompaFactsMemoryLifecycle({ broker, control });
    const first = await lifecycle.ensureSession({ ownerId, sessionId: parentSessionId, expiresAt: 100 });
    expect(await lifecycle.sweepExpired(100)).toMatchObject({ purged: 1 });
    const second = await lifecycle.ensureSession({ ownerId, sessionId: parentSessionId, expiresAt: 1_000 });
    expect([first.epoch, second.epoch]).toEqual([1, 2]);
    await expect(lstat(join(root, parentSessionId))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(root, `${parentSessionId}.epoch-2`))).isDirectory()).toBe(true);
    await expect(broker.purge({
      binding: createFactsMemoryBinding({ ownerId, sessionId: parentSessionId }),
      expectedHandleHash: first.handleHash,
      operationKey: `cleanup:${parentSessionId}:expired`,
    })).resolves.toBeDefined();
    await expect(broker.inspect(createFactsMemoryBinding({
      epoch: 2,
      ownerId,
      sessionId: parentSessionId,
    }))).resolves.toMatchObject({ status: "present" });
  });

  test("rejects metadata tampering, path aliases, and an inexact parent checkpoint", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const parentHead = await inspectionHead(broker, parent);
    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: { ...parentHead, digest: "f".repeat(64) } },
    })).rejects.toThrow("FACTS_MEMORY_PARENT_CHECKPOINT_MISMATCH");

    const outside = await realpath(await mkdtemp(join(tmpdir(), "hra-oh-engine-outside-")));
    roots.push(outside);
    await symlink(join(root, parent.sessionId), join(outside, "aliased"));
    await expect(engine.inspect({
      binding: parent,
      directory: join(outside, "aliased"),
    })).rejects.toThrow("FACTS_MEMORY_OH_DIRECTORY_UNSAFE");

    const path = join(root, parent.sessionId, metadataName);
    const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    metadata.receiptDigest = "e".repeat(64);
    await writeFile(path, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
    await expect(broker.inspect(parent)).rejects.toThrow("FACTS_MEMORY_OH_METADATA_DIGEST_MISMATCH");
  });

  test("accepts the released memory snapshot bound and rejects the first oversized fork", async () => {
    const { broker, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    const oversizedChild = createFactsMemoryBinding({
      ownerId,
      sessionId: `sess_${"3".repeat(32)}`,
    });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    expect(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes)
      .toBe(OH_MEMORY_LIMITS_V1.snapshotBytesPerLane);
    const records = Array.from({ length: 65 }, (_, index) =>
      memoryPageRecord(index, "word ".repeat(102_000)));
    const encodedAtLimit = Buffer.byteLength(JSON.stringify(records), "utf8");
    expect(encodedAtLimit).toBeLessThanOrEqual(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes);
    expect(encodedAtLimit)
      .toBeGreaterThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes - 512 * 1024);
    const parentDirectory = join(root, parent.sessionId);
    const parentAuthority = openOhAuthority(parent, parentDirectory);
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: records.map((record) => ({ kind: "put" as const, record, v: 1 as const })),
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.oversized-fork",
    });
    await parentAuthority.store.close();
    expect(await sqliteLogicalBytes(parentDirectory))
      .toBeLessThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes);

    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    })).resolves.toMatchObject({ head: { sequence: 1 } });
    await expect(broker.inspect(child)).resolves.toMatchObject({
      status: "present",
      inspection: { head: { sequence: 1 } },
    });

    const advancedParent = openOhAuthority(parent, parentDirectory);
    await advancedParent.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: memoryPageRecord(65, "word ".repeat(102_000)), v: 1 }],
      expectedHead: await advancedParent.store.head(),
      operationId: "host.test.oversized-fork-final-page",
    });
    const oversizedSnapshot = await advancedParent.store.snapshot({ maximumRecords: 8_192 });
    await advancedParent.store.close();
    expect(Buffer.byteLength(JSON.stringify(oversizedSnapshot.records), "utf8"))
      .toBeGreaterThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.forkSnapshotBytes);
    await expect(broker.fork({
      binding: oversizedChild,
      operationKey: `fork:${oversizedChild.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    })).rejects.toThrow("FACTS_MEMORY_OH_FORK_SNAPSHOT_TOO_LARGE");
    await expect(lstat(join(root, oversizedChild.sessionId, "oh.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(broker.inspect(oversizedChild)).resolves.toEqual({ status: "missing" });
  }, 60_000);

  test("rejects legacy oversized history before verification while preserving purge authority", async () => {
    const { broker, root } = await fixture();
    const churn = createFactsMemoryBinding({
      ownerId,
      sessionId: `sess_${"6".repeat(32)}`,
    });
    const churnReceipt = await broker.create({
      binding: churn,
      operationKey: `create:${churn.sessionId}`,
    });
    const churnDirectory = join(root, churn.sessionId);
    await truncate(
      join(churnDirectory, "oh.sqlite"),
      OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes + 1,
    );
    expect(await sqliteLogicalBytes(churnDirectory))
      .toBeGreaterThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes);
    await expect(broker.inspect(churn)).rejects.toThrow("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
    await expect(broker.purge({
      binding: churn,
      expectedHandleHash: churnReceipt.handleHash,
      operationKey: `cleanup:${churn.sessionId}:expired`,
    })).resolves.toBeDefined();
    await expect(lstat(churnDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("rolls back a capacity-exhausting commit before binding its operation id", async () => {
    const { broker, engine, root } = await fixture();
    const working = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const workingReceipt = await broker.create({
      binding: working,
      operationKey: `create:${working.sessionId}`,
    });
    const workingHead = await inspectionHead(broker, working);
    const canonicalDirectory = await ensurePrivateDirectory(join(root, "project-canonical"));
    const canonicalRealmId = "hra:project:capacity-test";
    const canonicalSpaceId = "hra:project:capacity-test";
    const canonicalAuthority = createOhSqliteStoreAuthorityV1({
      path: join(canonicalDirectory, "oh.sqlite"),
      profile: OH_CANONICAL_STORE_PROFILE_V1,
      realmId: canonicalRealmId,
      spaceId: canonicalSpaceId,
    });
    const canonicalHead = projectOhHead(await canonicalAuthority.store.head());
    await canonicalAuthority.store.close();

    const database = new Database(join(canonicalDirectory, "oh.sqlite"));
    try {
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.exec("CREATE TABLE hra_capacity_padding(id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT");
      const pageSize = database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size;
      if (pageSize === undefined) throw new Error("Expected SQLite page size.");
      const maximumPages = Math.floor(
        (OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes - 32) / (2 * pageSize + 24),
      );
      const insert = database.query("INSERT INTO hra_capacity_padding(id, payload) VALUES (?, zeroblob(?))");
      let id = 0;
      const initialPages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
      if (initialPages === undefined) throw new Error("Expected SQLite page count.");
      let available = maximumPages - initialPages;
      while (available > 256) {
        const requestedPages = Math.min(8_192, available - 256);
        insert.run(id, Math.max(1, (requestedPages - 8) * pageSize));
        id += 1;
        const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
        if (pages === undefined) throw new Error("Expected SQLite page count.");
        available = maximumPages - pages;
      }
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
      expect(pages).toBeDefined();
      expect(pages!).toBeLessThanOrEqual(maximumPages);
      expect(maximumPages - pages!).toBeLessThanOrEqual(256);
    } finally {
      database.close();
    }
    expect(await sqliteLogicalBytes(canonicalDirectory))
      .toBeLessThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes);

    const record = memoryPageRecord(9_999, "word ".repeat(104_000));
    const stores = {
      canonical: {
        directory: canonicalDirectory,
        expectedHead: canonicalHead,
        realmId: canonicalRealmId,
        spaceId: canonicalSpaceId,
      },
      working: {
        binding: working,
        directory: join(root, working.sessionId),
        expectedHandleHash: workingReceipt.handleHash,
        expectedHead: workingHead,
      },
    } as const;
    const commit = async () => await engine.withMemoryStores(stores, async (opened) =>
      await opened.canonical.store.commit({
        actorId: "hra.memory.host",
        changes: [{ kind: "put", record, v: 1 }],
        expectedHead: opened.canonical.expectedHead,
        operationId: "host.test.capacity-rollback",
      }));
    await expect(commit()).rejects.toThrow("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");
    await expect(commit()).rejects.toThrow("FACTS_MEMORY_OH_DATABASE_TOO_LARGE");

    const reopened = await engine.withMemoryStores(stores, async (opened) => ({
      canonical: await opened.canonical.store.head(),
      working: await opened.working.store.head(),
    }));
    expect(reopened.result.canonical).toMatchObject({ operationSha256: null, sequence: 0 });
    expect(reopened.result.working).toMatchObject({ operationSha256: null, sequence: 0 });
    expect(reopened.canonicalHead).toMatchObject({ operationSha256: null, sequence: 0 });
    expect(reopened.workingHead).toMatchObject({ operationSha256: null, sequence: 0 });
    expect(await sqliteLogicalBytes(canonicalDirectory))
      .toBeLessThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes);
  }, 60_000);

  test("authorizes oversized legacy cleanup only from exact historical sidecar preimages", async () => {
    const { broker, engine, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const parentDirectory = join(root, parent.sessionId);
    const parentAuthority = openOhAuthority(parent, parentDirectory);
    await parentAuthority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: createKnowledgeGraphRecordV1({
        dependencies: [],
        key: "entity:legacy-cleanup-source",
        kind: "entity",
        v: 1,
        value: { name: "Legacy cleanup source" },
      }), v: 1 }],
      expectedHead: await parentAuthority.store.head(),
      operationId: "host.test.legacy-cleanup-source",
    });
    await parentAuthority.store.close();
    const childReceipt = await broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    });
    const childDirectory = join(root, child.sessionId);
    const metadataPath = join(childDirectory, metadataName);
    const currentMetadata = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as AdapterMetadataFixture;
    const validLegacy = legacyMetadataFixture(currentMetadata);
    const {
      adapterDigest: validLegacyAdapterDigest,
      receiptDigest: validLegacyReceiptDigest,
      ...validLegacyBody
    } = validLegacy;
    expect(currentMetadata.initialHead.sequence).toBeGreaterThan(0);
    expect(currentMetadata.parent?.head.sequence).toBeGreaterThan(0);
    expect(validLegacyReceiptDigest).not.toBe(currentMetadata.receiptDigest);
    expect(validLegacyAdapterDigest).not.toBe(currentMetadata.adapterDigest);

    await truncate(
      join(childDirectory, "oh.sqlite"),
      OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes + 1,
    );
    expect(await sqliteLogicalBytes(childDirectory))
      .toBeGreaterThan(OOMPA_OH_FACTS_MEMORY_LIMITS_V1.sqliteLogicalBytes);

    const writeMetadata = async (metadata: LegacyMetadataFixture): Promise<void> => {
      await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    };
    const expectCleanupAuthorityRejected = async (): Promise<void> => {
      await expect(engine.quiesceForPurge({ binding: child, directory: childDirectory }))
        .rejects.toThrow();
      expect((await lstat(childDirectory)).isDirectory()).toBe(true);
    };

    await writeMetadata({ ...validLegacy, adapterDigest: "f".repeat(64) });
    await expectCleanupAuthorityRejected();

    await writeMetadata(signLegacyMetadataFixture({
      ...validLegacyBody,
      receiptDigest: "e".repeat(64),
    }));
    await expectCleanupAuthorityRejected();

    const mismatchedBinding = createFactsMemoryBinding({
      ownerId: otherOwnerId,
      sessionId: child.sessionId,
    });
    await writeMetadata(makeLegacyMetadataFixture({
      ...validLegacyBody,
      bindingDigest: mismatchedBinding.bindingDigest,
      handleHash: digestParts("hra-oh-handle-v1", [
        mismatchedBinding.bindingDigest,
        validLegacy.ohBindingSha256,
      ]),
    }));
    await expectCleanupAuthorityRejected();

    await writeMetadata(makeLegacyMetadataFixture({
      ...validLegacyBody,
      handleHash: "d".repeat(64),
    }));
    await expectCleanupAuthorityRejected();

    const migrationPath = join(childDirectory, migratingMetadataName);
    await writeMetadata(validLegacy);
    await rename(metadataPath, migrationPath);
    await writeFile(migrationPath, "{", { mode: 0o600 });
    await expectCleanupAuthorityRejected();
    await rm(migrationPath);

    await writeMetadata(validLegacy);
    await chmod(metadataPath, 0o666);
    await expectCleanupAuthorityRejected();
    await chmod(metadataPath, 0o600);

    const metadataLink = join(childDirectory, ".hra-oh-adapter-v1.hardlink");
    await link(metadataPath, metadataLink);
    await expectCleanupAuthorityRejected();
    await rm(metadataLink);

    const metadataTarget = join(childDirectory, ".hra-oh-adapter-v1.target");
    await rename(metadataPath, metadataTarget);
    await symlink(metadataTarget, metadataPath);
    await expectCleanupAuthorityRejected();
    await rm(metadataPath);
    await rename(metadataTarget, metadataPath);

    await expect(broker.purge({
      binding: child,
      expectedHandleHash: "c".repeat(64),
      operationKey: `cleanup:${child.sessionId}:expired`,
    })).rejects.toThrow("FACTS_MEMORY_PURGE_HANDLE_MISMATCH");
    expect((await lstat(childDirectory)).isDirectory()).toBe(true);
    await expect(broker.purge({
      binding: child,
      expectedHandleHash: childReceipt.handleHash,
      operationKey: `cleanup:${child.sessionId}:expired`,
    })).resolves.toMatchObject({ handleHash: childReceipt.handleHash });
    await expect(lstat(childDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("fails closed above the released memory lane bound and has no Suss runtime", async () => {
    const { broker, root } = await fixture();
    const parent = createFactsMemoryBinding({ ownerId, sessionId: parentSessionId });
    const child = createFactsMemoryBinding({ ownerId, sessionId: childSessionId });
    await broker.create({ binding: parent, operationKey: `create:${parent.sessionId}` });
    const authority = openOhAuthority(parent, join(root, parent.sessionId));
    const records = Array.from({ length: 8_193 }, (_, index) => createKnowledgeGraphRecordV1({
      dependencies: [],
      key: `entity:bounded-${String(index).padStart(4, "0")}`,
      kind: "entity",
      v: 1,
      value: { index },
    }));
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: records.slice(0, 8_192).map((record) => ({ kind: "put" as const, record, v: 1 as const })),
      expectedHead: await authority.store.head(),
      operationId: "host.test.bound.one",
    });
    await authority.store.commit({
      actorId: "hra.memory.host",
      changes: [{ kind: "put", record: records[8_192]!, v: 1 }],
      expectedHead: await authority.store.head(),
      operationId: "host.test.bound.two",
    });
    await authority.store.close();
    await expect(broker.fork({
      binding: child,
      operationKey: `fork:${child.sessionId}`,
      parent: { ...parent, head: await inspectionHead(broker, parent) },
    })).rejects.toThrow();
    await expect(broker.inspect(child)).resolves.toEqual({ status: "missing" });

    const source = await readFile(join(import.meta.dir, "oh-facts-memory-engine.ts"), "utf8");
    expect(source).not.toMatch(/projection-suss|@suss\/datalog/u);
  }, 30_000);
});
