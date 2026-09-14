import { describe, expect, test } from "bun:test";
import { canonicalDigest, withSelfDigest } from "./release-evidence";
import {
  assertDeletionListeners,
  assertDeletionLoopbackRequest,
  backendPin,
  deletionBackendReceiptSchema,
  deletionChildEnvironment,
  parseDeletionBackendArguments,
  parseDeletionBackendAdminKey,
  rewriteDeletionFixture,
} from "./deletion-backend-acceptance";

function receiptFixture() {
  const production = [{ path: "convex/crons.ts", bytes: 1, sha256: "b".repeat(64) }];
  const runId = "00000000-0000-4000-8000-000000000000";
  return withSelfDigest({
    schemaVersion: 1, kind: "disposable-native-deletion-backend-acceptance",
    runId, productionDigest: canonicalDigest(production), production,
    harnessDigest: "c".repeat(64), fixtureSha256: "d".repeat(64), cliSha256: "e".repeat(64), backend: backendPin,
    cronsSha256: "b".repeat(64), startedAt: 1, completedAt: 2, processGroupCollected: true,
    saasLoginQualified: false, jwtQualified: false,
    result: { schemaVersion: 1, runId, nativeBackend: true, productionCronUnchanged: true,
      dedicatedComplete: true, inlineComplete: true, abandonedComplete: true, witnessUnchanged: true,
      serviceBalanced: true, wrongCapabilityDenied: true, disabledAuthorityDenied: true, sameKeyReplay: true,
      inlineIdentityRecords: 256, backfillAddedNonIdentityRecords: 5, exactBytesCharged: true,
      subjectNonGrowing: true, childrenCollected: true, polls: 1, elapsedMs: 1 },
  });
}

describe("disposable native deletion backend acceptance boundaries", () => {
  test("binds the official keygen format to the exact fresh instance", () => {
    const instance = "oompa-qualification-0123456789abcdef";
    const key = `${instance}|${"a".repeat(56)}`;
    expect(parseDeletionBackendAdminKey(`${key}\n`, instance)).toBe(key);
    expect(parseDeletionBackendAdminKey(key, instance)).toBe(key);
    for (const output of [key.replace(instance, "other-instance"), `${key}\nextra`,
      ` ${key}`, `${instance}|short`, `${instance}|${"z".repeat(56)}`, `${key}|extra`])
      expect(() => parseDeletionBackendAdminKey(output, instance)).toThrow();
  });

  test("accepts only the reviewed backend pin and exact option set", () => {
    const args = ["--backend-binary", "/opt/qualification/convex-local-backend",
      "--backend-sha256", backendPin.sha256, "--evidence-path", "/protected/deletion-backend.json"];
    expect(parseDeletionBackendArguments(args).backendSha256).toBe(backendPin.sha256);
    for (const changed of [
      [...args.slice(0, 3), "a".repeat(64), ...args.slice(4)],
      [...args, "--deployment", "production"],
      ["--backend-binary", "relative/convex-local-backend", ...args.slice(2)],
      ["--backend-binary", "/opt/qualification/other-program", ...args.slice(2)],
      [...args.slice(0, 4), "--backend-binary", "/opt/qualification/convex-local-backend"],
    ]) expect(() => parseDeletionBackendArguments(changed)).toThrow();
  });

  test("rewrites the isolated fixture imports and refuses foreign traversal", () => {
    const source = 'import "../../convex/foo"; import "../../src/bar";';
    expect(rewriteDeletionFixture(source)).toBe('import "./foo"; import "../src/bar";');
    expect(() => rewriteDeletionFixture('import "../../other/file";')).toThrow();
    expect(() => rewriteDeletionFixture('import "../../convex/foo"; import "../../other/file";')).toThrow();
  });

  test("requires both listeners on loopback and the owned pid", () => {
    expect(() => assertDeletionListeners("p123\nf10\nn127.0.0.1:3210\nf11\nn127.0.0.1:3211\n", 123, [3210, 3211])).not.toThrow();
    for (const observed of ["p123\nf10\nn0.0.0.0:3210\nf11\nn127.0.0.1:3211\n",
      "p999\nf10\nn127.0.0.1:3210\nf11\nn127.0.0.1:3211\n", "p123\nn127.0.0.1:3210\n",
      "p123\nf10\nn127.0.0.1:3210\nf11\nn127.0.0.1:3211\nn127.0.0.1:3212\n"])
      expect(() => assertDeletionListeners(observed, 123, [3210, 3211])).toThrow();
  });

  test("bounds SDK requests to the exact owned endpoint and closed paths", () => {
    const origin = "http://127.0.0.1:3210";
    expect(() => assertDeletionLoopbackRequest(`${origin}/api/query`, origin)).not.toThrow();
    for (const url of ["https://example.com/api/query", "http://127.0.0.1:3211/api/query",
      `${origin}/api/query?redirect=1`, `${origin}/api/query#fragment`, `${origin}/api/admin`,
      "http://credential@127.0.0.1:3210/api/query"])
      expect(() => assertDeletionLoopbackRequest(url, origin)).toThrow();
  });

  test("does not inherit credentials or replace HOME and fences CLI provisioning", () => {
    const env = deletionChildEnvironment("/private/tmp/oompa-deletion-backend-ABC123");
    for (const name of ["HOME", "CODEX_HOME", "CONVEX_DEPLOY_KEY", "CONVEX_SELF_HOSTED_ADMIN_KEY",
      "HTTPS_PROXY", "NODE_OPTIONS", "BUN_OPTIONS"]) expect(env[name]).toBeUndefined();
    expect(env.DISABLE_BEACON).toBe("1");
    expect(env.CONVEX_PROVISION_HOST).toBe("http://127.0.0.1:9");
    expect(env.CONVEX_OVERRIDE_ACCESS_TOKEN).toMatch(/^oompa-disposable-native-[a-f0-9]{32}$/u);
    expect(deletionChildEnvironment("/private/tmp/oompa-deletion-backend-ABC123").CONVEX_OVERRIDE_ACCESS_TOKEN)
      .not.toBe(env.CONVEX_OVERRIDE_ACCESS_TOKEN);
  });

  test("admits a bound receipt and rejects unsupported claims or broken evidence", () => {
    const base = receiptFixture();
    expect(deletionBackendReceiptSchema.parse(base).processGroupCollected).toBe(true);
    for (const patch of [
      { saasLoginQualified: true }, { jwtQualified: true }, { processGroupCollected: false },
      { productionDigest: "0".repeat(64) }, { cronsSha256: "0".repeat(64) }, { completedAt: 0 },
      { result: { ...base.result, runId: "00000000-0000-4000-8000-000000000001" } },
      { result: { ...base.result, abandonedComplete: false } },
      { result: { ...base.result, serviceBalanced: false } },
      { result: { ...base.result, childrenCollected: false } },
    ]) expect(() => deletionBackendReceiptSchema.parse({ ...base, ...patch })).toThrow();
  });
});
