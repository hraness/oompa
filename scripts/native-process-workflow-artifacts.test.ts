import { expect, spyOn, test } from "bun:test";
import { admitNativeWorkflowArtifact, nativeWorkflowArtifactEnvironment, parseNativeWorkflowArtifactInput,
  readNativeWorkflowArtifacts } from "./native-process-workflow-artifacts.ts";

const input = { token: "synthetic-token", runId: "123", sourceSha: "a".repeat(40), artifacts: [{ id: "1", digest: "b".repeat(64) }] };
const server = (id = 1, digest = "b".repeat(64)) => ({ id, digest: "sha256:" + digest, expired: false,
  workflow_run: { id: 123, repository_id: 1343008607, head_repository_id: 1343008607, head_sha: input.sourceSha } });
const environment = { GITHUB_TOKEN: input.token, GITHUB_RUN_ID: input.runId, NATIVE_PROCESS_SOURCE_SHA: input.sourceSha,
  NATIVE_PROCESS_ARTIFACTS: JSON.stringify(input.artifacts) };

test("artifact input and environment require a finite distinct exact job-output inventory", () => {
  expect(parseNativeWorkflowArtifactInput(input)).toEqual(input);
  expect(nativeWorkflowArtifactEnvironment(environment)).toEqual(input);
  for (const change of [{ token: "" }, { token: "x".repeat(8193) }, { token: "token\nheader" }, { runId: "01" },
    { sourceSha: "A".repeat(40) }, { sourceSha: "a".repeat(39) }, { artifacts: [] },
    { artifacts: Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), digest: "b".repeat(64) })) },
    { artifacts: [...input.artifacts, ...input.artifacts] }, { artifacts: [{ id: "1/../../other", digest: "b".repeat(64) }] },
    { artifacts: [{ id: "1".repeat(21), digest: "b".repeat(64) }] }, { artifacts: [{ id: "1", digest: "sha256:" + "b".repeat(64) }] },
    { artifacts: [{ id: "1", digest: "B".repeat(64) }] }, { artifacts: [{ id: "1", digest: "b".repeat(64), url: "https://other.invalid" }] },
    { endpoint: "https://other.invalid" }]) expect(() => parseNativeWorkflowArtifactInput({ ...input, ...change })).toThrow();
  for (const field of Object.keys(environment)) expect(() => nativeWorkflowArtifactEnvironment({ ...environment, [field]: undefined })).toThrow();
  expect(() => nativeWorkflowArtifactEnvironment({ ...environment, NATIVE_PROCESS_ARTIFACTS: "[invalid" })).toThrow();
});
test("server readback binds exact artifact, repository, source and workflow run", () => {
  expect(admitNativeWorkflowArtifact(server(), input, "1")).toEqual(input.artifacts[0]!);
  for (const change of [{ id: 2 }, { id: "1" }, { id: Number.MAX_SAFE_INTEGER + 1 }, { expired: true },
    { digest: "sha256:" + "c".repeat(64) }, { digest: "b".repeat(64) }, { workflow_run: null }]) {
    expect(() => admitNativeWorkflowArtifact({ ...server(), ...change }, input, "1")).toThrow();
  }
  for (const change of [{ id: 124 }, { id: "123" }, { repository_id: 1 }, { head_repository_id: 1 }, { head_sha: "c".repeat(40) }]) {
    expect(() => admitNativeWorkflowArtifact({ ...server(), workflow_run: { ...server().workflow_run, ...change } }, input, "1")).toThrow();
  }
  expect(() => admitNativeWorkflowArtifact(server(), input, "2")).toThrow();
});
test("the complete request inventory is validated before any network access", async () => {
  const call = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw Error("Unexpected network call"); },
    { preconnect() { throw Error("Unexpected preconnect"); } }));
  try {
    await expect(readNativeWorkflowArtifacts({ ...input, artifacts: [...input.artifacts, { id: "2", digest: "invalid" }] })).rejects.toThrow();
    await expect(readNativeWorkflowArtifacts({ ...input, token: "bad\nheader" })).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(0);
  } finally { call.mockRestore(); }
});
test("readback uses fixed endpoints, bounded aborts and no redirect/retry behavior", async () => {
  const seen: Array<{ url: unknown; options: RequestInit | undefined }> = [];
  const call = spyOn(globalThis, "fetch").mockImplementation(Object.assign((...args: Parameters<typeof fetch>) => {
    const [url, options] = args;
    seen.push({ url, options });
    return Promise.resolve(new Response(JSON.stringify(server(seen.length, seen.length === 1 ? "b".repeat(64) : "c".repeat(64)))));
  }, { preconnect() { throw Error("Unexpected preconnect"); } }));
  try {
    const result = await readNativeWorkflowArtifacts({ ...input, artifacts: [...input.artifacts, { id: "2", digest: "c".repeat(64) }] });
    expect(result).toHaveLength(2); expect(call).toHaveBeenCalledTimes(2);
    expect(seen.map(value => value.url)).toEqual(["https://api.github.com/repos/hraness/oompa/actions/artifacts/1",
      "https://api.github.com/repos/hraness/oompa/actions/artifacts/2"]);
    for (const value of seen) {
      expect(value.options?.redirect).toBe("error"); expect(value.options?.cache).toBe("no-store"); expect(value.options?.method).toBe("GET");
      expect(value.options?.signal?.aborted).toBe(true);
      expect(new Headers(value.options?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    }
  } finally { call.mockRestore(); }
});
test("failed or oversized readback never retries or admits partial success", async () => {
  for (const response of [new Response("denied", { status: 403 }),
    new Response("x".repeat(128 * 1024 + 1)), new Response("{}", { headers: { "content-length": String(128 * 1024 + 1) } }),
    new Response("not JSON"), new Response(JSON.stringify(server(2)))]) {
    const call = spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(readNativeWorkflowArtifacts(input)).rejects.toThrow("NATIVE_PROCESS_WORKFLOW_ARTIFACT_INVALID");
      expect(call).toHaveBeenCalledTimes(1);
    } finally { call.mockRestore(); }
  }
});
