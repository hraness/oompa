import { describe, expect, test } from "bun:test";

import {
  AUTORESPOND_GATEWAY_KEY_SLOT,
  AUTORESPOND_HOSTED_RESPONDER_MARKER,
  AUTORESPOND_HOSTED_RESPONDER_SLOT,
  CustodyGatewayKeyStore,
  GatewayKeyError,
  InMemoryGatewayKeyStore,
  normalizeGatewayKey,
  type GatewaySecretCustodyPort,
} from "./gateway-key-custody";

// Printable keys assembled from parts so no credential-shaped literal enters
// the repository.
const firstKey = ["gw", "a".repeat(22)].join("");
const secondKey = ["gw", "b".repeat(30)].join("");

class MemoryCustody implements GatewaySecretCustodyPort {
  readonly slots = new Map<string, Readonly<{ generation: number; value: string }>>();
  #generation = 0;

  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return Promise.resolve(this.slots.get(slot) ?? null);
  }

  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    const current = this.slots.get(slot) ?? null;
    if ((current?.generation ?? null) !== expectedGeneration) return Promise.resolve(null);
    this.#generation += 1;
    const committed = { generation: this.#generation, value };
    this.slots.set(slot, committed);
    return Promise.resolve(committed);
  }

  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    const current = this.slots.get(slot);
    if (current === undefined || current.generation !== expectedGeneration) {
      return Promise.resolve(false);
    }
    this.slots.delete(slot);
    return Promise.resolve(true);
  }
}

describe("normalizeGatewayKey", () => {
  test("accepts one trimmed line of printable ASCII", () => {
    expect(normalizeGatewayKey(`  ${firstKey}\n`)).toBe(firstKey);
  });

  test("refuses empty, short, wrapped, and non-ASCII values", () => {
    for (const candidate of ["", "  ", "short", `${firstKey} ${firstKey}`, `${firstKey}\n${secondKey}`, `gw${"é".repeat(22)}`]) {
      expect(() => normalizeGatewayKey(candidate)).toThrow(GatewayKeyError);
    }
  });

  test("refuses a value beyond the custody bound", () => {
    expect(() => normalizeGatewayKey("k".repeat(513))).toThrow(GatewayKeyError);
  });
});

describe("CustodyGatewayKeyStore", () => {
  test("stores, replaces, reports, and clears the key in one custody slot", async () => {
    const custody = new MemoryCustody();
    const store = new CustodyGatewayKeyStore(custody);

    expect(await store.isConfigured()).toBe(false);
    expect(await store.read()).toBeNull();
    expect(await store.clear()).toBe(false);

    await store.set(`${firstKey}\n`);
    expect(await store.isConfigured()).toBe(true);
    expect(await store.read()).toBe(firstKey);
    expect([...custody.slots.keys()]).toEqual([AUTORESPOND_GATEWAY_KEY_SLOT]);

    await store.set(secondKey);
    expect(await store.read()).toBe(secondKey);

    // Rewriting the same value is a no-op, not a new generation.
    const generation = custody.slots.get(AUTORESPOND_GATEWAY_KEY_SLOT)?.generation;
    await store.set(secondKey);
    expect(custody.slots.get(AUTORESPOND_GATEWAY_KEY_SLOT)?.generation).toBe(generation as number);

    expect(await store.clear()).toBe(true);
    expect(await store.isConfigured()).toBe(false);
    expect(custody.slots.size).toBe(0);
  });

  test("refuses a rejected value before it reaches custody", async () => {
    const custody = new MemoryCustody();
    const store = new CustodyGatewayKeyStore(custody);
    await expect(store.set("short")).rejects.toBeInstanceOf(GatewayKeyError);
    expect(custody.slots.size).toBe(0);
  });
});

describe("InMemoryGatewayKeyStore", () => {
  test("holds one validated value for the process lifetime", async () => {
    const store = new InMemoryGatewayKeyStore();
    expect(await store.isConfigured()).toBe(false);
    await store.set(firstKey);
    expect(await store.read()).toBe(firstKey);
    expect(await store.clear()).toBe(true);
    expect(await store.clear()).toBe(false);
    expect(() => new InMemoryGatewayKeyStore("short")).toThrow(GatewayKeyError);
  });
});

describe("hosted responder selection", () => {
  test("selects the hosted responder exclusively of a key and clears both together", async () => {
    const custody = new MemoryCustody();
    const store = new CustodyGatewayKeyStore(custody);
    expect(await store.readMode()).toBeNull();

    await store.setHosted();
    expect(await store.readMode()).toBe("hosted");
    expect(await store.isConfigured()).toBe(false);
    expect(await store.read()).toBeNull();
    expect([...custody.slots.keys()]).toEqual([AUTORESPOND_HOSTED_RESPONDER_SLOT]);
    expect(custody.slots.get(AUTORESPOND_HOSTED_RESPONDER_SLOT)?.value).toBe(AUTORESPOND_HOSTED_RESPONDER_MARKER);

    // A key replaces the hosted selection; the hosted selection replaces a key.
    await store.set(firstKey);
    expect(await store.readMode()).toBe("gateway-key");
    expect([...custody.slots.keys()]).toEqual([AUTORESPOND_GATEWAY_KEY_SLOT]);
    await store.setHosted();
    expect(await store.readMode()).toBe("hosted");
    expect([...custody.slots.keys()]).toEqual([AUTORESPOND_HOSTED_RESPONDER_SLOT]);

    expect(await store.clear()).toBe(true);
    expect(await store.readMode()).toBeNull();
    expect(custody.slots.size).toBe(0);
    expect(await store.clear()).toBe(false);
  });

  test("a stored key wins over a stale hosted marker", async () => {
    const custody = new MemoryCustody();
    await custody.compareAndSwap(AUTORESPOND_HOSTED_RESPONDER_SLOT, null, AUTORESPOND_HOSTED_RESPONDER_MARKER);
    await custody.compareAndSwap(AUTORESPOND_GATEWAY_KEY_SLOT, null, firstKey);
    const store = new CustodyGatewayKeyStore(custody);
    expect(await store.readMode()).toBe("gateway-key");
    await custody.clearIfGeneration(AUTORESPOND_GATEWAY_KEY_SLOT, custody.slots.get(AUTORESPOND_GATEWAY_KEY_SLOT)?.generation ?? 0);
    expect(await store.readMode()).toBe("hosted");
    await custody.compareAndSwap(AUTORESPOND_HOSTED_RESPONDER_SLOT, custody.slots.get(AUTORESPOND_HOSTED_RESPONDER_SLOT)?.generation ?? null, "other");
    expect(await store.readMode()).toBeNull();
  });

  test("the in-memory store mirrors the same exclusive selection", async () => {
    const store = new InMemoryGatewayKeyStore(null, { hosted: true });
    expect(await store.readMode()).toBe("hosted");
    await store.set(firstKey);
    expect(await store.readMode()).toBe("gateway-key");
    await store.setHosted();
    expect(await store.read()).toBeNull();
    expect(await store.readMode()).toBe("hosted");
    expect(await store.clear()).toBe(true);
    expect(await store.readMode()).toBeNull();
  });
});
