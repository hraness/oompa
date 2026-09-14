import { z } from "zod";
import { readBoundedJsonResponse } from "./bounded-json-response.ts";

const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({ id: identifier, digest }).strict();
const inputSchema = z.object({
  token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u), runId: identifier,
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u), artifacts: z.array(artifactSchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  if (new Set(value.artifacts.map(artifact => artifact.id)).size !== value.artifacts.length) {
    context.addIssue({ code: "custom", message: "Native workflow artifact IDs must be unique." });
  }
});
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serverSchema = z.object({ id: integer, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), expired: z.literal(false),
  workflow_run: z.object({ id: integer, repository_id: z.literal(1343008607), head_repository_id: z.literal(1343008607),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/u) }),
});
function refuse(): never { throw Error("NATIVE_PROCESS_WORKFLOW_ARTIFACT_INVALID"); }
export type NativeWorkflowArtifactInput = z.infer<typeof inputSchema>;

/** Complete validation precedes the first HTTP request, including later items. */
export function parseNativeWorkflowArtifactInput(value: unknown): NativeWorkflowArtifactInput {
  try { return inputSchema.parse(value); } catch { return refuse(); }
}
export function nativeWorkflowArtifactEnvironment(environment: Readonly<Record<string, string | undefined>>): NativeWorkflowArtifactInput {
  try {
    const text = environment.NATIVE_PROCESS_ARTIFACTS;
    if (text === undefined || Buffer.byteLength(text) < 2 || Buffer.byteLength(text) > 4096) refuse();
    return parseNativeWorkflowArtifactInput({ artifacts: JSON.parse(text) as unknown, token: environment.GITHUB_TOKEN,
      sourceSha: environment.NATIVE_PROCESS_SOURCE_SHA, runId: environment.GITHUB_RUN_ID });
  } catch { return refuse(); }
}

/** Identity readback only. Exact downloaded archive/receipt content hashes are
 * checked downstream; JSON or a ZIP server digest alone is not qualification. */
export function admitNativeWorkflowArtifact(value: unknown, expected: NativeWorkflowArtifactInput, id: string) {
  try {
    const input = parseNativeWorkflowArtifactInput(expected), artifact = input.artifacts.find(item => item.id === id);
    if (artifact === undefined) refuse();
    const server = serverSchema.parse(value);
    if (String(server.id) !== artifact.id || server.digest !== "sha256:" + artifact.digest
      || String(server.workflow_run.id) !== input.runId || server.workflow_run.head_sha !== input.sourceSha) refuse();
    return Object.freeze({ id: artifact.id, digest: artifact.digest });
  } catch { return refuse(); }
}

export async function readNativeWorkflowArtifacts(value: unknown): Promise<readonly Readonly<{ id: string; digest: string }>[]> {
  const input = parseNativeWorkflowArtifactInput(value);
  const admitted: Readonly<{ id: string; digest: string }>[] = [];
  for (const artifact of input.artifacts) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`https://api.github.com/repos/hraness/oompa/actions/artifacts/${artifact.id}`, {
        method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + input.token,
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "oompa-native-workflow-artifact-readback" },
      });
      if (response.status !== 200) refuse();
      admitted.push(admitNativeWorkflowArtifact(await readBoundedJsonResponse(response, "native workflow artifact", 128 * 1024), input, artifact.id));
    } catch { refuse(); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze(admitted);
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 2) refuse();
    await readNativeWorkflowArtifacts(nativeWorkflowArtifactEnvironment(process.env));
    console.log("Native workflow artifact identities admitted.");
  } catch { console.error("Native workflow artifact identity admission failed."); process.exitCode = 1; }
}
