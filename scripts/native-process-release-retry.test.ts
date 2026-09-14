import { expect, spyOn, test } from "bun:test";
import { NATIVE_PROCESS_RELEASE_TAG, type NativeProcessReleaseRun } from "./native-process-release-policy.ts";
import { priorNativeAttemptProvesNoReleaseCreation, proveNoPriorNativeReleaseCreation } from "./native-process-release-retry.ts";

const run: NativeProcessReleaseRun = { id: "70000000001", attempt: 2, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40),
  workflowRef: `hraness/oompa/.github/workflows/native-process-release.yml@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}` };
const token = "synthetic-token";
const mutation = (conclusion: string | null = "skipped", status = "completed") => ({
  name: "Publish and verify immutable native package", conclusion, status,
});
const job = (changes: Readonly<Record<string, unknown>> = {}) => ({
  id: 901, run_id: Number(run.id), run_url: `https://api.github.com/repos/hraness/oompa/actions/runs/${run.id}`,
  workflow_name: "Native process release", head_sha: run.sourceSha, run_attempt: 1,
  name: "Publish immutable native package", status: "completed", conclusion: "failure", steps: [mutation()], ...changes,
});
const response = (...jobs: readonly unknown[]) => ({ jobs, total_count: jobs.length });
const admits = (value: unknown) => priorNativeAttemptProvesNoReleaseCreation(value, { run, attempt: 1 });

test("only exact completed skipped jobs or mutation steps prove no dispatch", () => {
  expect(admits(response(job({ conclusion: "skipped", steps: [] })))).toBe(true);
  for (const conclusion of ["failure", "cancelled", "timed_out"]) expect(admits(response(job({ conclusion })))).toBe(true);
  // Raw REST metadata is accepted without supplying evidence of its own.
  expect(admits({ ...response(job({ url: "ignored", steps: [{ ...mutation(), number: 4 }] })), unrelated: 1 })).toBe(true);
  for (const conclusion of ["success", "neutral", "action_required", null]) expect(admits(response(job({ conclusion })))).toBe(false);
  for (const conclusion of ["success", "failure", "cancelled", "timed_out", null]) {
    expect(admits(response(job({ steps: [mutation(conclusion)] })))).toBe(false);
  }
  expect(admits(response(job({ steps: [mutation("skipped", "in_progress")] })))).toBe(false);
});
test("missing, duplicated, incomplete or foreign history cannot prove absence", () => {
  for (const value of [response(), { jobs: [job()], total_count: 2 }, response(job(), job()),
    response(job(), job({ id: 902 })), response(job({ steps: [] })), response(job({ steps: [mutation(), mutation()] })),
    response(job({ conclusion: "skipped", steps: [mutation()] })), response(job({ status: "in_progress" })),
    response(job(), job({ id: 902, name: "Other job", status: "queued" })),
    response(job({ id: 0 })), response(job({ run_id: "70000000001" })), response(job({ run_id: 1 })),
    response(job({ run_url: "https://api.github.com/repos/other/oompa/actions/runs/70000000001" })),
    response(job({ workflow_name: "Release" })), response(job({ head_sha: "b".repeat(40) })), response(job({ run_attempt: 2 })),
    response(job({ name: "Publish package" })), response(job({ steps: [{ ...mutation(), name: "Wrong mutation" }] })),
    response(job({ steps: Array.from({ length: 101 }, () => mutation()) })),
    response(...Array.from({ length: 101 }, (_, index) => job({ id: index + 1 })))]) expect(() => admits(value)).toThrow("NATIVE_PROCESS_RELEASE_RETRY_INVALID");
  const hundred = [job(), ...Array.from({ length: 99 }, (_, index) => job({ id: index + 1, name: "Other job" }))];
  expect(admits(response(...hundred))).toBe(true);
  expect(() => admits({ jobs: hundred, total_count: 101 })).toThrow();
});
test("invalid requests and first attempts make no HTTP calls", async () => {
  const call = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw Error("Unexpected network call"); },
    { preconnect() { throw Error("Unexpected preconnect"); } }));
  try {
    expect(await proveNoPriorNativeReleaseCreation({ token, run: { ...run, attempt: 1 } })).toBe(true);
    for (const changes of [{ attempt: 52 }, { attempt: 0 }, { attempt: 1.5 }, { id: "01" }, { id: "1/other" },
      { workflowSha: "b".repeat(40) }, { sourceSha: "A".repeat(40) }, { workflowRef: "other" }]) {
      await expect(proveNoPriorNativeReleaseCreation({ token, run: { ...run, ...changes } })).rejects.toThrow();
    }
    for (const invalidToken of ["", "x".repeat(8193), "token\nheader", "token\u0000header"]) {
      await expect(proveNoPriorNativeReleaseCreation({ token: invalidToken, run })).rejects.toThrow();
    }
    expect(call).toHaveBeenCalledTimes(0);
  } finally { call.mockRestore(); }
  for (const attempt of [0, 2, 51]) expect(() => priorNativeAttemptProvesNoReleaseCreation(response(job()), { run, attempt })).toThrow();
});
test("fixed bounded GETs inspect every prior attempt once and snapshot current input", async () => {
  const seen: Array<{ url: unknown; options: RequestInit | undefined }> = [];
  const selected = { ...run, attempt: 4 };
  const call = spyOn(globalThis, "fetch").mockImplementation(Object.assign((...args: Parameters<typeof fetch>) => {
    const [url, options] = args; seen.push({ url, options }); selected.attempt = 1;
    return Promise.resolve(new Response(JSON.stringify(response(job({ run_attempt: seen.length })))));
  }, { preconnect() { throw Error("Unexpected preconnect"); } }));
  try {
    expect(await proveNoPriorNativeReleaseCreation({ token, run: selected })).toBe(true);
    expect(seen.map(item => item.url)).toEqual([1, 2, 3].map(attempt =>
      `https://api.github.com/repos/hraness/oompa/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=1`));
    for (const item of seen) {
      expect(item.options?.method).toBe("GET"); expect(item.options?.redirect).toBe("error"); expect(item.options?.cache).toBe("no-store");
      expect(item.options?.signal?.aborted).toBe(true);
      expect(new Headers(item.options?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    }
  } finally { call.mockRestore(); }
});
test("a prior dispatch short circuits later history and never authorizes CREATE", async () => {
  let count = 0;
  const call = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => {
    count += 1;
    return Promise.resolve(new Response(JSON.stringify(response(job({ run_attempt: count, steps: [mutation(count === 2 ? "failure" : "skipped")] })))));
  }, { preconnect() { throw Error("Unexpected preconnect"); } }));
  try {
    expect(await proveNoPriorNativeReleaseCreation({ token, run: { ...run, attempt: 4 } })).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
  } finally { call.mockRestore(); }
});
test("HTTP, malformed and oversized history failures do not retry", async () => {
  for (const result of [new Response("denied", { status: 403 }), new Response("moved", { status: 302 }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)), new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    new Response("not JSON"), new Response(JSON.stringify(response(job({ run_attempt: 2 }))))]) {
    const call = spyOn(globalThis, "fetch").mockResolvedValue(result);
    try {
      await expect(proveNoPriorNativeReleaseCreation({ token, run })).rejects.toThrow("NATIVE_PROCESS_RELEASE_RETRY_INVALID");
      expect(call).toHaveBeenCalledTimes(1);
    } finally { call.mockRestore(); }
  }
});
