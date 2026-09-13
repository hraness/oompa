import { describe, expect, test } from "bun:test";

import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
} from "./bounded-process";
import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  executeHostedStatus,
  parseHostedStatusArguments,
  parseHostedReleaseAttestation,
  readHostedStatus,
} from "./hosted-status";
import {
  OOMPA_CONVEX_PROJECT_ID,
  OOMPA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID,
  teamId: OOMPA_CONVEX_TEAM_ID,
};

const targetArguments = [
  "--deployment", target.deploymentName,
  "--team-id", String(target.teamId),
  "--project-id", String(target.projectId),
  "--deployment-id", String(target.deploymentId),
  "--deployment-url", target.deploymentUrl,
] as const;
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const statusArguments = ["--source-commit", sourceCommit, ...targetArguments] as const;

const requiredEnvironmentNames = [
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "OOMPA_AUTH_HMAC_SECRET",
  "OOMPA_RESEND_API_KEY",
  "OOMPA_AUTH_EMAIL_REPLY_TO",
  "OOMPA_ATTENTION_RESEND_API_KEY",
] as const;

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const statusRunner = (
  results: readonly Readonly<{ exitCode: number; stderr: string; stdout: string }>[],
  requests: CommandRequest[] = [],
): CommandRunner => {
  let index = 0;
  return async (request) => {
    requests.push(request);
    const result = results[index];
    index += 1;
    if (result === undefined) throw new Error("unexpected command");
    return result;
  };
};

const exactTargetVerifier = (calls: ConvexTarget[]): ConvexTargetVerifier => async (value) => {
  calls.push(value);
  expect(value).toEqual(target);
};

const readyBootstrap = JSON.stringify({
  occupiedTableCount: 3,
  serviceControlCount: 1,
  state: "ready",
});

const acceptedBootstrap = JSON.stringify({
  occupiedTableCount: 18,
  serviceControlCount: 1,
  state: "accepted",
});

const inactiveAttention = {
  generation: 0,
  globalState: "absent",
  outboxOccupancy: 0,
  safetyFaultOccupancy: 0,
} as const;
const attentionKeyName = "OOMPA_ATTENTION_RESEND_API_KEY";

const observeMissingAttentionKey = async (options: Readonly<{
  admission?: string;
  attention?: unknown;
  bootstrap?: string;
  dedicatedKeyReady?: boolean;
  missingNames?: readonly string[];
  requireInactive?: boolean;
  runtimeSourceCommit?: string;
}> = {}) => {
  const requests: CommandRequest[] = [];
  const verifications: ConvexTarget[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const missingNames = options.missingNames ?? [attentionKeyName];
  const requireInactive = options.requireInactive ?? true;
  const exitCode = await executeHostedStatus({
    arguments: [
      ...statusArguments,
      "--require-passed",
      ...(requireInactive ? ["--require-attention-inactive"] : []),
      ...(options.dedicatedKeyReady === undefined ? [] : ["--require-attention-key-ready"]),
    ],
    readAttestation: async () => ({
      runtimeSourceCommit: options.runtimeSourceCommit ?? sourceCommit,
      state: "bound",
    }),
    runner: statusRunner([
      {
        exitCode: 0,
        stderr: "",
        stdout: requiredEnvironmentNames.filter((name) => !missingNames.includes(name)).join("\n"),
      },
      { exitCode: 0, stderr: "", stdout: options.bootstrap ?? acceptedBootstrap },
      {
        exitCode: 0,
        stderr: "",
        stdout: options.admission ?? '{"generation":2,"state":"open","updatedAt":1}',
      },
      ...(requireInactive ? [{
        exitCode: 0, stderr: "", stdout: JSON.stringify(options.attention ?? inactiveAttention),
      }] : []),
      ...(options.dedicatedKeyReady === undefined ? [] : [{
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ dedicatedKeyReady: options.dedicatedKeyReady }),
      }]),
    ], requests),
    stderr: outputWriter(stderr),
    stdout: outputWriter(stdout),
    verifyTarget: exactTargetVerifier(verifications),
  });
  return { exitCode, requests, stderr, stdout, verifications };
};

describe("hosted preflight status operator", () => {
  test("admits the sole absent sending key only at the exact inactive checkpoint", async () => {
    for (const control of [
      { generation: 0, globalState: "absent" },
      { generation: 1, globalState: "disabled" },
      { generation: 1, globalState: "enabled" },
    ]) {
      for (const outboxOccupancy of [0, 1]) {
        for (const safetyFaultOccupancy of [0, 1]) {
          const result = await observeMissingAttentionKey({
            attention: { ...control, outboxOccupancy, safetyFaultOccupancy },
          });
          const inactive = control.globalState === "absent"
            && outboxOccupancy === 0 && safetyFaultOccupancy === 0;
          expect(result.exitCode).toBe(inactive ? 0 : 1);
          expect(result.stderr).toEqual([]);
          expect(result.requests).toHaveLength(4);
          expect(result.verifications).toHaveLength(10);
          expect(JSON.parse(result.stdout.join(""))).toMatchObject({
            attentionNotifications: { state: inactive ? "inactive" : "not_inactive" },
            environment: { missingRequiredNames: [attentionKeyName], requiredNamesPresent: false },
            status: inactive ? "live" : "preflight_incomplete",
            version: 1,
          });
          expect(JSON.parse(result.stdout.join(""))).not.toHaveProperty("attentionSending");
        }
      }
    }
  });

  test("keeps every core environment name mandatory even with exact inactive proof", async () => {
    for (const name of requiredEnvironmentNames.filter((value) => value !== attentionKeyName)) {
      for (const missingNames of [[name], [name, attentionKeyName]]) {
        const result = await observeMissingAttentionKey({ missingNames });
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout.join(""))).toMatchObject({
          environment: { missingRequiredNames: missingNames, requiredNamesPresent: false },
          nextAction: "configure_hosted_sync",
          status: "preflight_incomplete",
        });
      }
    }
  });

  test("does not waive a missing sending key without the requested inactive observation", async () => {
    const result = await observeMissingAttentionKey({ requireInactive: false });
    expect(result.exitCode).toBe(1);
    expect(result.requests).toHaveLength(3);
    expect(JSON.parse(result.stdout.join(""))).toMatchObject({
      nextAction: "configure_hosted_sync",
      status: "preflight_incomplete",
    });
    expect(JSON.parse(result.stdout.join(""))).not.toHaveProperty("attentionNotifications");
  });

  test("combined passed and sending-key gates require the name and credential result", async () => {
    for (const dedicatedKeyReady of [false, true]) {
      const result = await observeMissingAttentionKey({ dedicatedKeyReady });
      expect(result.exitCode).toBe(1);
      expect(result.requests).toHaveLength(5);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        attentionNotifications: { state: "inactive" },
        attentionSending: { dedicatedKeyReady },
        environment: { missingRequiredNames: [attentionKeyName], requiredNamesPresent: false },
        status: "preflight_incomplete",
      });
    }
  });

  test("preserves bootstrap, source and admission gates when an inactive key is absent", async () => {
    for (const scenario of [
      {
        options: { bootstrap: readyBootstrap, admission: '{"generation":0,"state":"open","updatedAt":1}' },
        exitCode: 0, status: "preflight_passed", nextAction: "run_live_acceptance",
      },
      {
        options: { admission: '{"generation":2,"state":"frozen","updatedAt":1}' },
        exitCode: 1, status: "preflight_incomplete", nextAction: "resume_admissions",
      },
      {
        options: { runtimeSourceCommit: "f".repeat(40) },
        exitCode: 1, status: "preflight_incomplete", nextAction: "inspect_release_attestation",
      },
      {
        options: { bootstrap: readyBootstrap, admission: '{"generation":1,"state":"open","updatedAt":1}' },
        exitCode: 1, status: "preflight_inconsistent", nextAction: "inspect_preflight",
      },
    ]) {
      const result = await observeMissingAttentionKey(scenario.options);
      expect(result.exitCode).toBe(scenario.exitCode);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        status: scenario.status, nextAction: scenario.nextAction,
      });
    }
  });

  test("reports an accepted deployment with open admission as live", async () => {
    for (const scenario of [
      {
        admission: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
        expected: {
          admission: { generation: 2, newIdentityAdmissions: "open", state: "open" },
          nextAction: "operate_hosted_sync",
          status: "live",
        },
        exitCode: 0,
      },
      {
        // A deployment that predates the control reports no value: invite_only.
        admission: '{"generation":1,"state":"frozen","updatedAt":1}',
        expected: {
          admission: { generation: 1, newIdentityAdmissions: "invite_only", state: "frozen" },
          nextAction: "resume_admissions",
          status: "preflight_incomplete",
        },
        exitCode: 1,
      },
    ] as const) {
      const runner = statusRunner([
        { exitCode: 0, stderr: "", stdout: `${requiredEnvironmentNames.join("\n")}\n` },
        { exitCode: 0, stderr: "", stdout: `${acceptedBootstrap}\n` },
        { exitCode: 0, stderr: "", stdout: `${scenario.admission}\n` },
      ]);
      const stdout: string[] = [];
      const exitCode = await executeHostedStatus({
        arguments: [...targetArguments, "--source-commit", sourceCommit, "--require-passed"],
        readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
        runner,
        stderr: { write: () => true },
        stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
        verifyTarget: exactTargetVerifier([]),
      });
      expect(exitCode).toBe(scenario.exitCode);
      expect(JSON.parse(stdout.join(""))).toEqual({
        ...scenario.expected,
        bootstrap: { occupiedTableCount: 18, state: "accepted" },
        environment: { requiredNamesPresent: true, missingRequiredNames: [] },
        releaseAttestation: { state: "current" },
        version: 1,
      });
    }
  });

  test("requires exactly one complete fixed Convex target tuple", () => {
    expect(parseHostedStatusArguments(statusArguments)).toEqual({
      requireAttentionInactive: false,
      requireAttentionKeyReady: false,
      requirePassed: false,
      sourceCommit,
      target,
    });
    expect(parseHostedStatusArguments([
      ...statusArguments,
      "--require-attention-inactive",
    ])).toEqual({
      requireAttentionInactive: true,
      requireAttentionKeyReady: false,
      requirePassed: false,
      sourceCommit,
      target,
    });
    expect(parseHostedStatusArguments([
      ...statusArguments,
      "--require-attention-key-ready",
    ])).toEqual({
      requireAttentionInactive: false,
      requireAttentionKeyReady: true,
      requirePassed: false,
      sourceCommit,
      target,
    });
    expect(() => parseHostedStatusArguments([
      ...statusArguments,
      "--deployment", target.deploymentName,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments([
      "status",
      ...statusArguments,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments(targetArguments)).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments([
      ...statusArguments,
      "--require-attention-inactive",
      "--require-attention-inactive",
    ])).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments([
      ...statusArguments,
      "--require-attention-key-ready",
      "--require-attention-key-ready",
    ])).toThrow("usage_invalid");
  });

  test("proves the deployed attention runtime is inactive through one bounded named read", async () => {
    const requests: CommandRequest[] = [];
    const verifications: ConvexTarget[] = [];
    const stdout: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: [
        ...statusArguments,
        "--require-passed",
        "--require-attention-inactive",
      ],
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        { exitCode: 0, stderr: "", stdout: acceptedBootstrap },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
        },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"generation":0,"globalState":"absent","outboxOccupancy":0,"safetyFaultOccupancy":0}',
        },
      ], requests),
      stderr: { write: () => true },
      stdout: outputWriter(stdout),
      verifyTarget: exactTargetVerifier(verifications),
    });

    expect(exitCode).toBe(0);
    expect(verifications).toHaveLength(10);
    expect(requests).toHaveLength(4);
    expect(requests[3]?.phase).toBe("hosted-status-attention-inactive-read");
    expect(requests[3]?.arguments.slice(1)).toEqual([
      "run",
      "attentionNotificationControl:inactiveDeploymentStatus",
      "{}",
      "--deployment",
      target.deploymentName,
    ]);
    expect(requests[3]?.containment).toBe("authority");
    expect(requests[3]?.stdin).toBe("");
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      attentionNotifications: {
        generation: 0,
        globalState: "absent",
        outboxOccupancy: 0,
        safetyFaultOccupancy: 0,
        state: "inactive",
      },
      status: "live",
    });
    expect(JSON.parse(stdout.join(""))).not.toHaveProperty("attentionSending");
  });

  test("checks dedicated credential readiness separately from names and inactive generation zero", async () => {
    for (const dedicatedKeyReady of [false, true]) {
      const requests: CommandRequest[] = [];
      const stdout: string[] = [];
      const verifications: ConvexTarget[] = [];
      const exitCode = await executeHostedStatus({
        arguments: [
          ...statusArguments,
          "--require-passed",
          "--require-attention-inactive",
          "--require-attention-key-ready",
        ],
        readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
        runner: statusRunner([
          { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
          { exitCode: 0, stderr: "", stdout: acceptedBootstrap },
          {
            exitCode: 0,
            stderr: "",
            stdout: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
          },
          {
            exitCode: 0,
            stderr: "",
            stdout: '{"generation":0,"globalState":"absent","outboxOccupancy":0,"safetyFaultOccupancy":0}',
          },
          { exitCode: 0, stderr: "provider-secret", stdout: JSON.stringify({ dedicatedKeyReady }) },
        ], requests),
        stderr: { write: () => true },
        stdout: outputWriter(stdout),
        verifyTarget: exactTargetVerifier(verifications),
      });

      expect(exitCode).toBe(dedicatedKeyReady ? 0 : 1);
      expect(requests).toHaveLength(5);
      expect(verifications).toHaveLength(12);
      expect(requests[4]?.arguments.slice(1)).toEqual([
        "run", "attentionNotificationControl:sendingKeyReadiness", "{}",
        "--deployment", target.deploymentName,
      ]);
      expect(requests[4]?.phase).toBe("hosted-status-attention-key-read");
      expect(requests[4]?.containment).toBe("authority");
      expect(requests[4]?.stdin).toBe("");
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        attentionNotifications: { generation: 0, state: "inactive" },
        attentionSending: { dedicatedKeyReady },
        environment: { requiredNamesPresent: true },
        status: "live",
      });
      expect(stdout.join("")).not.toContain("provider-secret");
    }
  });

  test("refuses malformed or unavailable credential readiness without exposing provider values", async () => {
    for (const result of [
      { exitCode: 1, stderr: "provider-secret", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "{}" },
      { exitCode: 0, stderr: "", stdout: '{"dedicatedKeyReady":"true"}' },
      { exitCode: 0, stderr: "", stdout: '{"dedicatedKeyReady":true,"key":"provider-secret"}' },
      { exitCode: 0, stderr: "", stdout: "x".repeat((64 * 1024) + 1) },
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await executeHostedStatus({
        arguments: [...statusArguments, "--require-attention-key-ready"],
        readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
        runner: statusRunner([
          { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
          { exitCode: 0, stderr: "", stdout: acceptedBootstrap },
          { exitCode: 0, stderr: "", stdout: '{"generation":1,"state":"open","updatedAt":1}' },
          result,
        ]),
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        verifyTarget: async () => undefined,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      expect(JSON.parse(stderr.join(""))).toEqual({
        code: "attention_sending_status_invalid",
        schemaVersion: 1,
        status: "refused",
      });
      expect(stderr.join("")).not.toContain("provider-secret");
    }
  });

  test("fails the inactive requirement on any hosted occupancy", async () => {
    const stdout: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: [...statusArguments, "--require-attention-inactive"],
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        { exitCode: 0, stderr: "", stdout: acceptedBootstrap },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
        },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"generation":0,"globalState":"absent","outboxOccupancy":1,"safetyFaultOccupancy":0}',
        },
      ]),
      stderr: { write: () => true },
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      attentionNotifications: { outboxOccupancy: 1, state: "not_inactive" },
    });
  });

  test("refuses an incoherent attention readback", async () => {
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: [...statusArguments, "--require-attention-inactive"],
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        { exitCode: 0, stderr: "", stdout: acceptedBootstrap },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
        },
        {
          exitCode: 0,
          stderr: "provider-secret",
          stdout: '{"generation":1,"globalState":"absent","outboxOccupancy":0,"safetyFaultOccupancy":0}',
        },
      ]),
      stderr: outputWriter(stderr),
      stdout: { write: () => true },
      verifyTarget: async () => undefined,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "attention_status_invalid",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("provider-secret");
  });

  test("reports only bounded preflight facts after authority-contained reads", async () => {
    const requests: CommandRequest[] = [];
    const verifications: ConvexTarget[] = [];
    const trace: string[] = [];
    const runner = statusRunner([
      {
        exitCode: 0,
        stderr: "provider-secret",
        stdout: `CONVEX_SITE_URL\nUNRELATED_PROVIDER_NAME\n${requiredEnvironmentNames.join("\n")}\n`,
      },
      { exitCode: 0, stderr: "provider-secret", stdout: `${readyBootstrap}\n` },
      { exitCode: 0, stderr: "provider-secret", stdout: '{"generation":0,"state":"open","updatedAt":1}\n' },
    ], requests);
    const status = await readHostedStatus({
      environment: {
        CONVEX_DEPLOY_KEY: "provider-secret",
        HOME: "/safe/operator",
        PATH: "/safe/bin",
      },
      readAttestation: async (value) => {
        expect(value).toEqual(target);
        return { runtimeSourceCommit: sourceCommit, state: "bound" };
      },
      runner: async (request) => {
        trace.push(request.phase);
        return await runner(request);
      },
      sourceCommit,
      target,
      verifyTarget: async (value) => {
        trace.push("verify");
        await exactTargetVerifier(verifications)(value);
      },
    });

    expect(status).toEqual({
      admission: {
        generation: 0,
        newIdentityAdmissions: "invite_only",
        state: "open",
      },
      bootstrap: { occupiedTableCount: 3, state: "ready" },
      environment: { requiredNamesPresent: true, missingRequiredNames: [] },
      nextAction: "run_live_acceptance",
      releaseAttestation: { state: "current" },
      status: "preflight_passed",
    });
    expect(verifications).toHaveLength(8);
    expect(trace).toEqual([
      "verify", "verify",
      "verify", "hosted-status-environment-read", "verify",
      "verify", "hosted-status-bootstrap-read", "verify",
      "verify", "hosted-status-admission-read", "verify",
    ]);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.containment === "authority")).toBe(true);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(requests[0]?.arguments.slice(1)).toEqual([
      "env", "list", "--names-only", "--deployment", target.deploymentName,
    ]);
    expect(requests[1]?.arguments.slice(1)).toEqual([
      "run", "quota:hostedBootstrapStatus", "{}", "--deployment", target.deploymentName,
    ]);
    expect(requests[2]?.arguments.slice(1)).toEqual([
      "run", "admissionControl:status", "{}", "--deployment", target.deploymentName,
    ]);
    expect(JSON.stringify(requests)).not.toContain("provider-secret");
  });

  test("writes a machine-readable incomplete observation as a successful read", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "provider-secret", stdout: "SITE_URL\nUNRELATED_PROVIDER_NAME\n" },
        {
          exitCode: 0,
          stderr: "provider-secret",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}\n',
        },
      ]),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      admission: { state: "uninitialized" },
      bootstrap: { occupiedTableCount: 0, state: "uninitialized" },
      environment: {
        requiredNamesPresent: false,
        missingRequiredNames: requiredEnvironmentNames.slice(1),
      },
      nextAction: "inspect_release_attestation",
      releaseAttestation: { state: "unbound" },
      status: "preflight_incomplete",
      version: 1,
    });
    expect(stdout.join("")).not.toContain("UNRELATED_PROVIDER_NAME");
    expect(stdout.join("")).not.toContain("CONVEX_SITE_URL");
    expect(stdout.join("")).not.toContain("provider-secret");
  });

  test("never passes a bound runtime attested to a different source commit", async () => {
    const status = await readHostedStatus({
      readAttestation: async () => ({
        runtimeSourceCommit: "fedcba98765432100123456789abcdef01234567",
        state: "bound",
      }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        { exitCode: 0, stderr: "", stdout: readyBootstrap },
        { exitCode: 0, stderr: "", stdout: '{"generation":0,"state":"open","updatedAt":1}' },
      ]),
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    });

    expect(status).toMatchObject({
      nextAction: "inspect_release_attestation",
      releaseAttestation: { state: "other" },
      status: "preflight_incomplete",
    });
  });

  test("makes a valid non-passed observation fail only when explicitly requested", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: [...statusArguments, "--require-passed"],
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}',
        },
      ]),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "preflight_incomplete" });
  });

  test("refuses malformed observations without exposing provider output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => ({
        exitCode: 0,
        stderr: "provider-secret",
        stdout: "SITE_URL=provider-secret\n",
      }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "environment_status_invalid",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("provider-secret");
  });

  test("does not infer an unbound runtime from a malformed release response", () => {
    expect(() => parseHostedReleaseAttestation({ bound: false })).toThrow(
      "release_attestation_invalid",
    );
    expect(parseHostedReleaseAttestation({
      bound: false,
      schemaIdentity: "hra-release-attestation-v1",
      schemaVersion: 1,
    })).toEqual({ state: "unbound" });
  });

  test("preserves authority custody uncertainty as recovery-required", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => {
        throw new BoundedProcessCleanupUnprovenError(42_001, "hosted-status-environment-read");
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(75);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "process_cleanup_unproven",
      phase: "hosted-status-environment-read",
      status: "recovery_required",
    });
  });

  test("refuses before target postflight when authority containment is unavailable", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => {
        throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => { verifications += 1; },
    });

    expect(exitCode).toBe(1);
    expect(verifications).toBe(3);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
  });

  test("uses the named bounded bootstrap projection rather than an inline provider program", async () => {
    const requests: CommandRequest[] = [];
    await readHostedStatus({
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: "" },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}',
        },
      ], requests),
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    });
    expect(requests.map((request) => request.arguments)).not.toContainEqual(
      expect.arrayContaining(["--inline-query"]),
    );
    expect(requests[1]?.arguments).toContain("quota:hostedBootstrapStatus");
  });
});
