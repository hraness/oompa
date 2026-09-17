/*
 * Local custody for the prose-autorespond gateway key.
 *
 * The key is a provider credential, so it never enters SQLite, argv, events,
 * evidence, logs, or the cloud projection. It lives in the same generational
 * secret custody that holds device credentials and cursor keys: an immutable
 * mode-0600 value under the state directory, addressed by a staged pointer, so
 * a replacement is atomic and a clear is provably scrubbed.
 *
 * Callers outside the daemon only ever learn whether a key is configured.
 */

import {
  GATEWAY_KEY_MAX_BYTES,
  GATEWAY_KEY_MIN_BYTES,
  gatewayKeySchema,
} from "../domain/values";

/** Custody slot holding the AI Gateway key. Never identity- or deployment-scoped. */
export const AUTORESPOND_GATEWAY_KEY_SLOT = "autorespond-gateway-key";

/**
 * Custody slot that selects the hosted responder metered by Hraness credits.
 * It holds one fixed marker, never a credential; the credits device token
 * stays in the credits state file the `oompa credits` commands own.
 */
export const AUTORESPOND_HOSTED_RESPONDER_SLOT = "autorespond-hosted-responder";

/** The one value the hosted slot may hold. */
export const AUTORESPOND_HOSTED_RESPONDER_MARKER = "hosted-v1";

/** Which prose responder custody selects: the person's own gateway key, or the hosted one. */
export type ProseResponderMode = "gateway-key" | "hosted";

export class GatewayKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayKeyError";
  }
}

/*
 * The three-method custody surface shared with `CloudSecretCustodyPort`. Kept
 * structural so tests can substitute an in-memory implementation without
 * touching the filesystem custody machinery.
 */
export interface GatewaySecretCustodyPort {
  read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null>;
  compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null>;
  clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean>;
}

export interface GatewayKeyPort {
  /** Removes the configured key and any hosted selection. Returns false when neither was configured. */
  clear(): Promise<boolean>;
  /** Public status of the key. The only gateway fact any command output may carry. */
  isConfigured(): Promise<boolean>;
  /** Daemon-internal read for the responder. Never rendered or logged. */
  read(): Promise<string | null>;
  /** Which responder is selected, or null when prose autorespond is inert. A stored key always wins. */
  readMode(): Promise<ProseResponderMode | null>;
  /** Replaces any configured key and drops a hosted selection. Throws `GatewayKeyError` on a rejected value. */
  set(key: string): Promise<void>;
  /** Selects the hosted responder and drops any configured key. */
  setHosted(): Promise<void>;
}

/** Normalizes one descriptor read into a candidate key, or throws. */
export function normalizeGatewayKey(value: string): string {
  const trimmed = value.trim();
  const parsed = gatewayKeySchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new GatewayKeyError(
      "The gateway key must be one line of printable ASCII between "
      + `${String(GATEWAY_KEY_MIN_BYTES)} and `
      + `${String(GATEWAY_KEY_MAX_BYTES)} characters.`,
    );
  }
  return parsed.data;
}

const MAXIMUM_CUSTODY_ATTEMPTS = 8;

export class CustodyGatewayKeyStore implements GatewayKeyPort {
  readonly #custody: GatewaySecretCustodyPort;

  constructor(custody: GatewaySecretCustodyPort) {
    this.#custody = custody;
  }

  async isConfigured(): Promise<boolean> {
    return await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT) !== null;
  }

  async read(): Promise<string | null> {
    const observed = await this.#custody.read(AUTORESPOND_GATEWAY_KEY_SLOT);
    return observed?.value ?? null;
  }

  async readMode(): Promise<ProseResponderMode | null> {
    if (await this.isConfigured()) return "gateway-key";
    const hosted = await this.#custody.read(AUTORESPOND_HOSTED_RESPONDER_SLOT);
    return hosted?.value === AUTORESPOND_HOSTED_RESPONDER_MARKER ? "hosted" : null;
  }

  async set(key: string): Promise<void> {
    await this.#put(AUTORESPOND_GATEWAY_KEY_SLOT, normalizeGatewayKey(key));
    await this.#drop(AUTORESPOND_HOSTED_RESPONDER_SLOT);
  }

  async setHosted(): Promise<void> {
    await this.#put(AUTORESPOND_HOSTED_RESPONDER_SLOT, AUTORESPOND_HOSTED_RESPONDER_MARKER);
    await this.#drop(AUTORESPOND_GATEWAY_KEY_SLOT);
  }

  async clear(): Promise<boolean> {
    const hadKey = await this.#drop(AUTORESPOND_GATEWAY_KEY_SLOT);
    const hadHosted = await this.#drop(AUTORESPOND_HOSTED_RESPONDER_SLOT);
    return hadKey || hadHosted;
  }

  async #put(slot: string, value: string): Promise<void> {
    for (let attempt = 0; attempt < MAXIMUM_CUSTODY_ATTEMPTS; attempt += 1) {
      const current = await this.#custody.read(slot);
      if (current?.value === value) return;
      const committed = await this.#custody.compareAndSwap(slot, current?.generation ?? null, value);
      if (committed !== null) return;
    }
    throw new GatewayKeyError("The gateway key custody slot changed concurrently.");
  }

  async #drop(slot: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAXIMUM_CUSTODY_ATTEMPTS; attempt += 1) {
      const current = await this.#custody.read(slot);
      if (current === null) return false;
      if (await this.#custody.clearIfGeneration(slot, current.generation)) return true;
    }
    throw new GatewayKeyError("The gateway key custody slot changed concurrently.");
  }
}

/*
 * Deterministic in-process key holder for tests and for daemon boots where no
 * filesystem custody is available. It holds the value in memory only.
 */
export class InMemoryGatewayKeyStore implements GatewayKeyPort {
  #hosted: boolean;
  #value: string | null;

  constructor(value: string | null = null, options: Readonly<{ hosted?: boolean }> = {}) {
    this.#value = value === null ? null : normalizeGatewayKey(value);
    this.#hosted = this.#value === null && options.hosted === true;
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(this.#value !== null);
  }

  read(): Promise<string | null> {
    return Promise.resolve(this.#value);
  }

  readMode(): Promise<ProseResponderMode | null> {
    return Promise.resolve(this.#value !== null ? "gateway-key" : this.#hosted ? "hosted" : null);
  }

  set(key: string): Promise<void> {
    this.#value = normalizeGatewayKey(key);
    this.#hosted = false;
    return Promise.resolve();
  }

  setHosted(): Promise<void> {
    this.#value = null;
    this.#hosted = true;
    return Promise.resolve();
  }

  clear(): Promise<boolean> {
    const had = this.#value !== null || this.#hosted;
    this.#value = null;
    this.#hosted = false;
    return Promise.resolve(had);
  }
}
