import { expect, test } from "bun:test";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { NATIVE_PROCESS_RELEASE_ARCHIVE, NATIVE_PROCESS_RELEASE_PROVENANCE, NATIVE_PROCESS_RELEASE_REPOSITORY,
  NATIVE_PROCESS_RELEASE_TAG, NATIVE_PROCESS_RELEASE_WORKFLOW, nativeReleaseBody, type NativeReleaseIdentity } from "./native-process-release-policy.ts";
import { reconcileNativeReleasePublication, type NativePublicationPorts } from "./native-process-publish.ts";

const repository = { id: 1343008607, full_name: NATIVE_PROCESS_RELEASE_REPOSITORY, default_branch: "main",
  owner: { id: 307125679 }, private: false, visibility: "public" };
// Deliberately synthetic identity tests the effect-port algorithm only. The real
// entrypoint must obtain byte identity from actual Sigstore verification.
function fixture() {
  const hash = nativeInputHash(Buffer.from("synthetic"));
  const identity: NativeReleaseIdentity = { coordinate: {
    source: { commitSha: "a".repeat(40), treeSha256: hash, bunLockSha256: hash, cargoLockSha256: hash, toolchainSha256: hash,
      rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
    tagObjectSha: "b".repeat(40), archive: { bytes: 9, sha256: hash }, manifestSha256: hash,
    run: { id: "123", attempt: 1, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40),
      workflowRef: `${NATIVE_PROCESS_RELEASE_REPOSITORY}/${NATIVE_PROCESS_RELEASE_WORKFLOW}@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}` },
  }, assets: ([NATIVE_PROCESS_RELEASE_ARCHIVE, "SHA256SUMS", NATIVE_PROCESS_RELEASE_PROVENANCE] as const).map(name => ({ name, bytes: 9, sha256: hash })) };
  const assets = identity.assets.map((asset, index) => ({ id: 200 + index, name: asset.name, state: "uploaded", size: asset.bytes,
    digest: `sha256:${asset.sha256}`, url: `https://api.github.com/repos/hraness/oompa/releases/assets/${200 + index}`,
    browser_download_url: `https://github.com/hraness/oompa/releases/download/${NATIVE_PROCESS_RELEASE_TAG}/${asset.name}` }));
  const empty = () => ({ id: 41, tag_name: NATIVE_PROCESS_RELEASE_TAG, name: NATIVE_PROCESS_RELEASE_TAG,
    target_commitish: identity.coordinate.source.commitSha, draft: true, prerelease: false, immutable: false,
    author: { id: 41898282, type: "Bot" }, body: nativeReleaseBody(identity),
    url: "https://api.github.com/repos/hraness/oompa/releases/41",
    html_url: `https://github.com/hraness/oompa/releases/tag/${NATIVE_PROCESS_RELEASE_TAG}`, assets: [] as typeof assets });
  let retained: ReturnType<typeof empty> | undefined;
  const effects: string[] = [];
  const ports: NativePublicationPorts = {
    authority: async () => { effects.push("authority"); return repository; },
    list: async () => retained === undefined ? [] : [structuredClone(retained)],
    read: async releaseId => { expect(releaseId).toBe(41); return structuredClone(retained); },
    latest: async () => ({ id: 99, tag_name: "v1.2.3", draft: false, prerelease: false, immutable: true,
      html_url: "https://github.com/hraness/oompa/releases/tag/v1.2.3" }),
    mayCreate: async () => true,
    verifyAssets: async release => { effects.push("bytes"); expect(release.assets).toHaveLength(3); },
    intent: value => { effects.push(`intent:${value.operation}`); },
    create: async request => { effects.push("create"); retained = { ...empty(), ...request }; },
    upload: async (releaseId, name) => {
      expect(releaseId).toBe(41); if (retained === undefined || retained.assets.some(asset => asset.name === name)) throw Error("no overwrite");
      const asset = assets.find(value => value.name === name); if (asset === undefined) throw Error("unknown name");
      effects.push(`upload:${name}`); retained.assets.push(asset);
    },
    publish: async (releaseId, request) => {
      expect(releaseId).toBe(41); if (retained === undefined) throw Error();
      effects.push("publish"); retained = { ...retained, ...request, immutable: true };
    },
  };
  return { identity, ports, effects, assets, empty,
    get: () => retained, set: (value: ReturnType<typeof empty>) => { retained = value; } };
}

test("publication records intent before each bounded mutation and preserves the CLI Latest release", async () => {
  const f = fixture();
  const result = await reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, f.ports);
  expect(result.id).toBe(41); expect(result.assets.map(asset => asset.id)).toEqual([200, 201, 202]);
  expect(result.publishedAttempt).toBe(1);
  const mutations = f.effects.filter(value => value.startsWith("intent:") || value.startsWith("upload:") || value === "create" || value === "publish");
  expect(mutations).toEqual(["intent:create", "create", "intent:upload", `upload:${NATIVE_PROCESS_RELEASE_ARCHIVE}`,
    "intent:upload", "upload:SHA256SUMS", "intent:upload", `upload:${NATIVE_PROCESS_RELEASE_PROVENANCE}`, "intent:publish", "publish"]);
  for (const operation of ["create", "upload", "publish"]) {
    const index = f.effects.indexOf(`intent:${operation}`); expect(f.effects[index - 1]).toBe("authority");
  }
});
test("uncertain create upload and publish are reconciled without dispatching a second write", async () => {
  const f = fixture();
  const ports = { ...f.ports,
    create: async (...args: Parameters<NativePublicationPorts["create"]>) => { await f.ports.create(...args); throw Error("lost response"); },
    upload: async (...args: Parameters<NativePublicationPorts["upload"]>) => { await f.ports.upload(...args); throw Error("lost response"); },
    publish: async (...args: Parameters<NativePublicationPorts["publish"]>) => { await f.ports.publish(...args); throw Error("lost response"); },
  };
  expect((await reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, ports)).publishedAttempt).toBe(1);
  expect(f.effects.filter(value => value === "create")).toHaveLength(1);
  expect(f.effects.filter(value => value.startsWith("upload:"))).toHaveLength(3);
  expect(f.effects.filter(value => value === "publish")).toHaveLength(1);
});
test("unknown writes with no exact readback stop and preserve the partial draft", async () => {
  for (const phase of ["create", "upload", "publish"] as const) {
    const f = fixture(); let attempts = 0;
    const ports = { ...f.ports, [phase]: async () => { attempts += 1; throw Error("unknown"); } };
    await expect(reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, ports)).rejects.toThrow();
    expect(attempts).toBe(1); expect(f.get()?.draft ?? true).toBe(true);
  }
});
test("existing exact partial draft resumes missing assets and an immutable release performs no writes", async () => {
  const f = fixture(); f.set({ ...f.empty(), assets: [f.assets[0]!] });
  const later = { ...f.identity.coordinate.run, attempt: 2 };
  const result = await reconcileNativeReleasePublication(f.identity, later, f.ports);
  expect(result.createdAttempt).toBe(1); expect(result.publishedAttempt).toBe(2);
  expect(f.effects).not.toContain("create"); expect(f.effects).not.toContain(`upload:${NATIVE_PROCESS_RELEASE_ARCHIVE}`);
  const effectCount = f.effects.length;
  expect((await reconcileNativeReleasePublication(f.identity, { ...later, attempt: 3 }, f.ports)).publishedAttempt).toBe(2);
  expect(f.effects.slice(effectCount).filter(value => value.startsWith("intent:"))).toEqual([]);
});
test("foreign or altered releases are preserved and cannot become owned empty drafts", async () => {
  for (const change of [{ body: "foreign" }, { author: { id: 894119, type: "User" } }, { target_commitish: "c".repeat(40) },
    { assets: [{ ...fixture().assets[0]!, digest: "sha256:" + "f".repeat(64) }] }]) {
    const f = fixture(); f.set({ ...f.empty(), ...change });
    await expect(reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, f.ports)).rejects.toThrow();
    expect(f.effects.filter(value => value.startsWith("intent:"))).toEqual([]);
  }
});
test("duplicate tag claims or an unexhausted bounded release list cannot authorize creation", async () => {
  for (const list of [async () => [{ ...fixture().empty() }, { ...fixture().empty(), id: 42 }],
    async (page: number) => Array.from({ length: 100 }, (_, index) => ({ id: page * 100 + index, tag_name: `other-${page}-${index}`, draft: false }))]) {
    const f = fixture();
    await expect(reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, { ...f.ports, list })).rejects.toThrow();
    expect(f.effects).not.toContain("create");
  }
});
test("absent provider visibility after a prior dispatch never authorizes another draft", async () => {
  const f = fixture();
  await expect(reconcileNativeReleasePublication(f.identity, { ...f.identity.coordinate.run, attempt: 2 },
    { ...f.ports, mayCreate: async () => false })).rejects.toThrow();
  expect(f.effects).not.toContain("create");
});
test("authority loss and absent remote byte proof prevent publication", async () => {
  for (const mode of ["authority", "bytes"] as const) {
    const f = fixture(); f.set({ ...f.empty(), assets: [...f.assets] });
    let calls = 0;
    const ports = { ...f.ports,
      authority: async () => { calls += 1; if (mode === "authority" && calls > 1) throw Error("changed"); return repository; },
      verifyAssets: async () => { if (mode === "bytes") throw Error("changed bytes"); },
    };
    await expect(reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, ports)).rejects.toThrow();
    expect(f.effects).not.toContain("publish"); expect(f.get()?.draft).toBe(true);
  }
});
test("a mutable publication or changed asset ID fails terminal admission without deletion or republishing", async () => {
  for (const mode of ["mutable", "asset"] as const) {
    const f = fixture();
    const ports = { ...f.ports, publish: async (...args: Parameters<NativePublicationPorts["publish"]>) => {
      await f.ports.publish(...args); const retained = f.get(); if (retained === undefined) throw Error();
      f.set(mode === "mutable" ? { ...retained, immutable: false } : { ...retained, assets: [{ ...retained.assets[0]!, id: 999 }, ...retained.assets.slice(1)] });
    } };
    await expect(reconcileNativeReleasePublication(f.identity, f.identity.coordinate.run, ports)).rejects.toThrow();
    expect(f.effects.filter(value => value === "publish")).toHaveLength(1); expect(f.get()?.draft).toBe(false);
  }
});
