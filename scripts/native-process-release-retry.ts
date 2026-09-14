import { z } from "zod";
import { readBoundedJsonResponse } from "./bounded-json-response.ts";
import { nativeReleaseCoordinateSchema, type NativeProcessReleaseRun } from "./native-process-release-policy.ts";

const publisherName = "Publish immutable native package";
const publicationName = "Publish and verify immutable native package";
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(1024);
const conclusion = z.string().min(1).max(128).nullable();
const runSchema = nativeReleaseCoordinateSchema.shape.run.refine(run => run.attempt <= 51 && run.workflowSha === run.sourceSha);
const historyInputSchema = z.object({ run: runSchema, attempt: integer.max(50) }).strict()
  .refine(input => input.attempt < input.run.attempt);
const inputSchema = z.object({
  token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u), run: runSchema,
}).strict();
// These are raw GitHub REST objects: unrelated server fields are ignored, while
// every field used as no-dispatch evidence is parsed and bound below.
const stepSchema = z.object({ name: text, status: text, conclusion });
const jobSchema = z.object({ id: integer, run_id: integer, run_url: text, workflow_name: text,
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u), run_attempt: integer, name: text,
  status: z.literal("completed"), conclusion, steps: z.array(stepSchema).max(100),
});
const jobsSchema = z.object({ total_count: z.number().int().min(0).max(100), jobs: z.array(jobSchema).max(100) });
function refuse(): never { throw Error("NATIVE_PROCESS_RELEASE_RETRY_INVALID"); }

/** Pure interpretation of one complete authenticated prior-attempt response.
 * The parser itself supplies no GitHub authority. Missing evidence is never
 * proof that CREATE was not dispatched, and any actual dispatch remains unknown. */
export function priorNativeAttemptProvesNoReleaseCreation(
  value: unknown, expected: Readonly<{ run: NativeProcessReleaseRun; attempt: number }>,
): boolean {
  try {
    const input = historyInputSchema.parse(expected), response = jobsSchema.parse(value);
    if (response.total_count !== response.jobs.length
      || new Set(response.jobs.map(job => job.id)).size !== response.jobs.length) refuse();
    const runUrl = `https://api.github.com/repos/hraness/oompa/actions/runs/${input.run.id}`;
    for (const job of response.jobs) {
      if (String(job.run_id) !== input.run.id || job.run_url !== runUrl || job.run_attempt !== input.attempt
        || job.workflow_name !== "Native process release" || job.head_sha !== input.run.sourceSha) refuse();
    }
    const writers = response.jobs.filter(job => job.name === publisherName), writer = writers[0];
    if (writers.length !== 1 || writer === undefined) refuse();
    // GitHub emits no steps for an entirely skipped job. This is the same
    // no-dispatch case as an explicitly skipped mutation step in a failed job.
    if (writer.conclusion === "skipped") {
      if (writer.steps.length !== 0) refuse();
      return true;
    }
    if (!["failure", "cancelled", "timed_out"].includes(writer.conclusion ?? "")) return false;
    const mutations = writer.steps.filter(step => step.name === publicationName), mutation = mutations[0];
    if (mutations.length !== 1 || mutation === undefined) refuse();
    return mutation.status === "completed" && mutation.conclusion === "skipped";
  } catch { return refuse(); }
}

/** Fixed read-only history inspection, independent of fresh write authority.
 * At most 50 complete prior attempts are read once (15 seconds / 2 MiB each).
 * A caller must still acquire and consume fresh exact authority before CREATE. */
export async function proveNoPriorNativeReleaseCreation(value: unknown): Promise<boolean> {
  try {
    const input = inputSchema.parse(value);
    for (let attempt = 1; attempt < input.run.attempt; attempt += 1) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`https://api.github.com/repos/hraness/oompa/actions/runs/${input.run.id}/attempts/${attempt}/jobs?per_page=100&page=1`, {
          method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + input.token,
            "Cache-Control": "no-cache", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "oompa-native-release-retry" },
        });
        if (response.status !== 200) refuse();
        if (!priorNativeAttemptProvesNoReleaseCreation(await readBoundedJsonResponse(response, "native release retry history", 2 * 1024 * 1024),
          { run: input.run, attempt })) return false;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    return true;
  } catch { return refuse(); }
}
