import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { spawnSync } from "node:child_process";

import {
  canonicalProfileCatalog,
  canonicalProfileKeySchema,
  decodeHistoricalPresetProfile,
  decodeHistoricalProfileKey,
  decodeHistoricalProfileTuple,
} from "./canonical-profile";
import {
  activePresetBinding,
  presetProviders,
  presetRequirementForContract,
  presetSchema,
  providerSchema,
  supportedPresetSchema,
  supportedProviderSchema,
} from "./presets";

const expectedCatalog = [
  { key: "codex:gpt-5.6-luna:max", provider: "codex", model: "gpt-5.6-luna", effort: "max" },
  { key: "codex:gpt-5.6-sol:max", provider: "codex", model: "gpt-5.6-sol", effort: "max" },
  { key: "codex:gpt-5.6-sol:ultra", provider: "codex", model: "gpt-5.6-sol", effort: "ultra" },
  { key: "codex:gpt-6-astra:max", provider: "codex", model: "gpt-6-astra", effort: "max" },
  { key: "codex:gpt-6-astra:ultra", provider: "codex", model: "gpt-6-astra", effort: "ultra" },
  { key: "claude:claude-fable-5-1:max", provider: "claude", model: "claude-fable-5-1", effort: "max" },
  { key: "devin:gpt-6-astra:provider-default", provider: "devin", model: "gpt-6-astra", effort: "provider-default" },
] as const;

const tuple = { provider: "codex", model: "gpt-5.6-sol", effort: "ultra" };
const provenance = { provider: "codex", preset: "ultra", contract: 1 };
const decoders = [
  decodeHistoricalProfileKey,
  decodeHistoricalProfileTuple,
  decodeHistoricalPresetProfile,
] as const;

describe("canonical historical profile identities", () => {
  test("cold browser-safe imports and decoders never attempt dynamic code generation", () => {
    const result = spawnSync(process.execPath, ["--eval", `
      import assert from "node:assert/strict";
      let attempts = 0;
      const refuse = () => { attempts += 1; throw new EvalError("CSP probe refused"); };
      globalThis.Function = new Proxy(globalThis.Function, { apply: refuse, construct: refuse });
      assert.throws(() => Reflect.construct(globalThis.Function, [""]), EvalError);
      assert.throws(() => Reflect.apply(globalThis.Function, undefined, [""]), EvalError);
      assert.equal(attempts, 2, "The sentinel must detect both code-generation entry points");
      attempts = 0;
      const profiles = await import(${JSON.stringify(new URL("./canonical-profile.ts", import.meta.url).href)});
      const payloads = await import(${JSON.stringify(new URL("../cloud/payloads.ts", import.meta.url).href)});
      for (const profile of profiles.canonicalProfileCatalog) {
        assert.equal(profiles.decodeHistoricalProfileKey(profile.key), profile);
        assert.equal(profiles.decodeHistoricalProfileTuple({
          provider: profile.provider, model: profile.model, effort: profile.effort,
        }), profile);
      }
      const observation = {
        version: 1, preset: "ultra", profileKey: "codex:gpt-5.6-sol:ultra",
        observedAt: 1, registryRevision: 1, registryEnvelopeDigest: "a".repeat(64),
      };
      assert.deepEqual(payloads.parseProfileBindingPayload(observation), observation);
      assert.equal(payloads.parseProfileBindingPayload({ ...observation, preset: "low" }), null);
      assert.equal(profiles.decodeHistoricalPresetProfile({
        provider: "codex", preset: "ultra", contract: 1,
      })?.key, observation.profileKey);
      assert.equal(profiles.decodeHistoricalPresetProfile({
        provider: "codex", preset: "constructor", contract: 1,
      }), null);
      const accessor = Object.defineProperty({}, "provider", {
        enumerable: true, get() { throw new Error("Accessor invoked"); },
      });
      assert.equal(profiles.decodeHistoricalProfileTuple(accessor), null);
      assert.equal(profiles.decodeHistoricalPresetProfile(accessor), null);
      assert.equal(attempts, 0, "Browser-safe profile imports must not probe or compile dynamic code");
    `], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  test("pins seven unique immutable keys and exact tuples", () => {
    expect(canonicalProfileCatalog).toEqual(expectedCatalog);
    expect(canonicalProfileKeySchema.options).toEqual(expectedCatalog.map((profile) => profile.key));
    expect(new Set(canonicalProfileCatalog.map((profile) => profile.key)).size).toBe(7);
    expect(new Set(canonicalProfileCatalog.map(({ provider, model, effort }) =>
      JSON.stringify([provider, model, effort]))).size).toBe(7);
    expect(Object.isFrozen(canonicalProfileCatalog)).toBe(true);
    expect(Reflect.set(canonicalProfileCatalog, "0", null)).toBe(false);
    for (const profile of canonicalProfileCatalog) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Reflect.set(profile, "model", "unreviewed")).toBe(false);
      expect(Reflect.deleteProperty(profile, "effort")).toBe(false);
      expect(decodeHistoricalProfileKey(profile.key)).toBe(profile);
      expect(canonicalProfileKeySchema.parse(profile.key)).toBe(profile.key);
      expect(decodeHistoricalProfileTuple({
        provider: profile.provider, model: profile.model, effort: profile.effort,
      })).toBe(profile);
    }
    expect(canonicalProfileCatalog).toEqual(expectedCatalog);
  });

  test("decodes the entire provider, preset, and frozen contract matrix", () => {
    for (const contract of [1, 2] as const) {
      for (const preset of presetSchema.options) {
        const requirement = presetRequirementForContract(preset, contract);
        for (const provider of providerSchema.options) {
          const result = decodeHistoricalPresetProfile({ provider, preset, contract });
          if (requirement === undefined || presetProviders[preset] !== provider) {
            expect(result).toBeNull();
          } else {
            expect(result).toBe(decodeHistoricalProfileTuple({
              provider, model: requirement.model, effort: requirement.effort,
            }));
            expect(result).not.toBeNull();
          }
        }
      }
    }
    for (const preset of ["low", "fable-max"] as const) {
      const provider = presetProviders[preset];
      expect(decodeHistoricalPresetProfile({ provider, preset, contract: 1 }))
        .toBe(decodeHistoricalPresetProfile({ provider, preset, contract: 2 }));
    }
    for (const preset of ["high", "ultra"] as const) {
      expect(decodeHistoricalPresetProfile({ provider: "codex", preset, contract: 1 })?.model)
        .toBe("gpt-5.6-sol");
      expect(decodeHistoricalPresetProfile({ provider: "codex", preset, contract: 2 })?.model)
        .toBe("gpt-6-astra");
    }
  });

  test("historical recognition neither selects a fresh route nor admits a retired provider", () => {
    const before = JSON.stringify([activePresetBinding("high"), activePresetBinding("ultra")]);
    expect(decodeHistoricalPresetProfile({ provider: "devin", preset: "astra", contract: 2 }))
      .toBe(decodeHistoricalProfileKey("devin:gpt-6-astra:provider-default"));
    expect(decodeHistoricalPresetProfile({ provider: "devin", preset: "astra", contract: 1 })).toBeNull();
    expect(supportedProviderSchema.safeParse("devin").success).toBe(false);
    expect(supportedPresetSchema.safeParse("astra").success).toBe(false);
    expect(decodeHistoricalPresetProfile({ provider: "codex", preset: "ultra", contract: 2 })?.model)
      .toBe("gpt-6-astra");
    expect(activePresetBinding("ultra").requirement).toEqual({ model: "gpt-6-astra", effort: "ultra" });
    expect(decodeHistoricalPresetProfile({ provider: "codex", preset: "ultra", contract: 1 })?.model)
      .toBe("gpt-5.6-sol");
    expect(JSON.stringify([activePresetBinding("high"), activePresetBinding("ultra")])).toBe(before);
    for (const profile of canonicalProfileCatalog) {
      expect(Object.keys(profile)).toEqual(["key", "provider", "model", "effort"]);
    }
  });

  test("rejects unknown keys without coercion or object-key inheritance", () => {
    for (const input of [
      "", "__proto__", "constructor", "toString", "codex:gpt-5.6-terra:ultra",
      " codex:gpt-5.6-sol:ultra", "codex:gpt-5.6-sol:ultra ", "CODEX:gpt-5.6-sol:ultra",
      { key: "codex:gpt-5.6-sol:ultra" }, Object("codex:gpt-5.6-sol:ultra"),
    ]) {
      expect(decodeHistoricalProfileKey(input)).toBeNull();
      expect(canonicalProfileKeySchema.safeParse(input).success).toBe(false);
    }
  });

  test("requires a complete coherent exact tuple and provenance without added authority fields", () => {
    for (const input of [
      { ...tuple, provider: "claude" }, { ...tuple, provider: "devin" },
      { ...tuple, model: "gpt-5.6-terra" }, { ...tuple, model: " gpt-5.6-sol" },
      { ...tuple, effort: "high" }, { ...tuple, effort: "provider-default" },
      { ...tuple, effort: undefined }, { provider: "codex", model: tuple.model },
      { model: tuple.model, effort: tuple.effort }, { ...tuple, key: "codex:gpt-6-astra:ultra" },
      { ...tuple, fast: true }, { ...tuple, available: true },
    ]) expect(decodeHistoricalProfileTuple(input)).toBeNull();
    for (const input of [
      { ...provenance, provider: "claude" }, { ...provenance, preset: "fable-max" },
      { ...provenance, contract: undefined }, { ...provenance, contract: "1" },
      { ...provenance, contract: 0 }, { ...provenance, contract: 3 },
      { ...provenance, contract: 1.5 }, { ...provenance, contract: NaN },
      { ...provenance, contract: Infinity }, { ...provenance, model: tuple.model },
      { provider: "codex", preset: "ultra" },
    ]) expect(decodeHistoricalPresetProfile(input)).toBeNull();
  });

  test("snapshots plain own data without invoking accessors or returning caller-owned objects", () => {
    for (const [input, decode] of [
      [tuple, decodeHistoricalProfileTuple],
      [provenance, decodeHistoricalPresetProfile],
    ] as const) {
      const expected = decode(input);
      expect(expected).not.toBeNull();
      expect(decode(Object.assign(Object.create(null) as object, input))).toBe(expected);
      expect(decode(Object.create(input))).toBeNull();
      expect(decode({ ...input, [Symbol("extra")]: true })).toBeNull();
      expect(decode(Object.defineProperty({ ...input }, "extra", { value: true }))).toBeNull();
      expect(decode(Object.defineProperty({ ...input }, "extra", { get: () => true }))).toBeNull();
      for (const field of Object.keys(input)) {
        let reads = 0;
        for (const throws of [false, true]) {
          const accessor = Object.defineProperty({ ...input }, field, {
            enumerable: true,
            get: () => { reads += 1; if (throws) throw new Error("getter"); return "codex"; },
          });
          expect(decode(accessor)).toBeNull();
        }
        expect(reads).toBe(0);
        expect(decode(Object.defineProperty({ ...input }, field, { enumerable: false }))).toBeNull();
      }
      const mutable = { ...input };
      expect(decode(mutable)).toBe(expected);
      Reflect.set(mutable, "provider", "unreviewed");
      expect(decode(input)).toBe(expected);
      expect(decode(new Proxy({ ...input }, { get() { throw new Error("no field rereads"); } })))
        .toBe(expected);
    }
  });

  test("returns null for hostile proxies and non-data values instead of throwing", () => {
    const revokedObject = Proxy.revocable({}, {});
    const revokedArray = Proxy.revocable([], {});
    revokedObject.revoke();
    revokedArray.revoke();
    const selfRevoking = Proxy.revocable({ ...tuple }, {
      getPrototypeOf() { selfRevoking.revoke(); return Object.prototype; },
    });
    class Foreign { provider = "codex"; model = "gpt-5.6-sol"; effort = "ultra"; }
    const inputs: unknown[] = [
      null, undefined, 1, NaN, Infinity, true, 1n, Symbol("foreign"), () => tuple,
      [], [tuple], new Foreign(), new Date(), revokedObject.proxy, revokedArray.proxy,
      selfRevoking.proxy,
      new Proxy({}, { getPrototypeOf() { throw new Error("prototype"); } }),
      new Proxy({}, { ownKeys() { throw new Error("keys"); } }),
      new Proxy({ ...tuple }, { getOwnPropertyDescriptor() { throw new Error("descriptor"); } }),
      new Proxy({}, { ownKeys() { return ["provider", "provider"]; } }),
    ];
    for (const input of inputs) {
      for (const decode of decoders) expect(decode(input)).toBeNull();
    }
  });

  test("rejects nonexact key sets before reading any descriptors", () => {
    let descriptors = 0;
    const input = new Proxy({}, {
      ownKeys() { return ["provider", "model", "effort", "extra"]; },
      getOwnPropertyDescriptor() { descriptors += 1; throw new Error("unexpected descriptor read"); },
    });
    expect(decodeHistoricalProfileTuple(input)).toBeNull();
    expect(decodeHistoricalPresetProfile(input)).toBeNull();
    expect(descriptors).toBe(0);
  });

  test("hostile nested values cannot escape through scalar schema validation", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = new Proxy({}, {
      get() { throw new Error("nested property access"); },
      getPrototypeOf() { throw new Error("nested prototype access"); },
      ownKeys() { throw new Error("nested own keys"); },
    });
    for (const value of [revoked.proxy, hostile]) {
      for (const field of Object.keys(tuple)) {
        expect(decodeHistoricalProfileTuple({ ...tuple, [field]: value })).toBeNull();
      }
      for (const field of Object.keys(provenance)) {
        expect(decodeHistoricalPresetProfile({ ...provenance, [field]: value })).toBeNull();
      }
    }
  });

  test("property: exact key and tuple JSON round trips return the frozen catalog member", () => {
    fc.assert(fc.property(fc.constantFrom(...canonicalProfileCatalog), (profile) => {
      expect(decodeHistoricalProfileKey(JSON.parse(JSON.stringify(profile.key)) as unknown)).toBe(profile);
      expect(decodeHistoricalProfileTuple(JSON.parse(JSON.stringify({
        provider: profile.provider, model: profile.model, effort: profile.effort,
      })) as unknown)).toBe(profile);
    }), { numRuns: 100 });
  });

  test("property: unknown JSON parsing is total and cannot create an identity", () => {
    fc.assert(fc.property(fc.jsonValue(), (input) => {
      for (const decode of decoders) {
        const result = decode(input);
        if (result !== null) {
          expect(canonicalProfileCatalog.includes(result)).toBe(true);
          expect(Object.isFrozen(result)).toBe(true);
        }
      }
    }), { numRuns: 500 });
  });
});
