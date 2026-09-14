import { expect, test } from "bun:test";
import {
  daemonQualificationDescriptorSchema, daemonQualificationIdempotencyKey, daemonQualificationPaths,
  daemonQualificationChildResultSchema,
  daemonQualificationPrompt,
} from "./contract";
import { snapshotDaemonQualificationCommand } from "./command-intent";
import { runNativeDarwinDaemonQualification } from "./run";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const descriptor = {
  version: 1, purpose: "authenticated_personal_daemon_restart", runId: id(1), ownerEpoch: id(2), stage: "A",
  repositoryRoot: "/fixture/repository", sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40),
  executablePath: "/fixture/claude", executableSha256: "c".repeat(64), ownerHome: "/fixture/home",
  runRoot: "/private/tmp/oompa-md-ABC123", providerThreadId: id(3), normalNonceA: id(4), normalNonceB: id(5), acknowledgmentLossNonce: id(6),
  directories: Object.fromEntries(["root", "profile", "temporary", "project", "state"].map((name, index) => [name, { device: 1, inode: index + 1, owner: 501 }])),
};

test("the daemon child descriptor admits only its own fixed family and distinct prompt identities", () => {
  expect(daemonQualificationDescriptorSchema.parse(descriptor).stage).toBe("A");
  for (const patch of [{ runRoot: "/private/tmp/oompa-ms-ABC123" }, { stage: "D" }, { sourceCommit: "main" },
    { acknowledgmentLossNonce: id(4) }, { processFactory: "unadmitted" }, { runRoot: "/private/tmp/oompa-md-ABC123/child" }]) {
    expect(daemonQualificationDescriptorSchema.safeParse({ ...descriptor, ...patch }).success).toBeFalse();
  }
  expect(daemonQualificationPaths(descriptor.runRoot).state).toBe("/private/tmp/oompa-md-ABC123/state");
  expect(() => daemonQualificationPaths("/private/tmp/oompa-ms-ABC123")).toThrow();
});

test("the retained ambiguous request uses one exact valid UUID and fixed no-tool prompt", () => {
  const parsed = daemonQualificationDescriptorSchema.parse(descriptor);
  expect(daemonQualificationIdempotencyKey(parsed)).toBe(id(6));
  expect(daemonQualificationPrompt(id(6))).toBe(`Oompa's authorized isolated daemon restart test. Reply with exactly OOMPA_DAEMON_${id(6)}. Do not invoke any tool or modify any file.`);
  expect(() => daemonQualificationPrompt("injected\ncommand")).toThrow();
});

test("malformed or injected native invocations refuse before acquiring any owner", async () => {
  for (const input of [null, {}, { ...descriptor, processFactory: () => {} },
    { repositoryRoot: "/fixture/repository", sourceCommit: "a".repeat(40), executablePath: "/fixture/claude",
      environment: {}, signal: new AbortController().signal, operation: "send" }]) {
    await expect(runNativeDarwinDaemonQualification(input)).rejects.toThrow("QUALIFICATION_REFUSED");
  }
});


test("command intents bind exact stage, daemon identity and fixed message before asynchronous persistence", () => {
  const identity = { generation: 2, nonce: id(9) };
  const request = { kind: "session.send" as const, session: "session-one",
    message: daemonQualificationPrompt(id(5)), idempotencyKey: id(5) };
  const result = snapshotDaemonQualificationCommand("normal_B", { ...descriptor, stage: "B" }, identity, request);
  request.message = "changed after snapshot"; identity.generation = 77;
  expect(result.command.kind).toBe("session.send");
  expect("message" in result.command && result.command.message).toBe(daemonQualificationPrompt(id(5)));
  expect(result.binding).toEqual({ step: "normal_B", stage: "B", daemonGeneration: 2, daemonNonce: id(9) });
  expect(Object.isFrozen(result.command)).toBeTrue();
  expect(() => snapshotDaemonQualificationCommand("normal_B", descriptor, identity, request)).toThrow();
  expect(() => snapshotDaemonQualificationCommand("lost_B", { ...descriptor, stage: "B" }, identity, request)).toThrow();
  expect(() => snapshotDaemonQualificationCommand("adoption_A", descriptor, identity,
    { kind: "session.adoption.set", provider: "claude", enabled: false, account: "account-one" })).toThrow();
  const retry = snapshotDaemonQualificationCommand("retry_C", { ...descriptor, stage: "C" }, identity,
    { kind: "session.send", session: "session-one", message: daemonQualificationPrompt(id(6)), idempotencyKey: id(6) });
  expect(retry.binding.stage).toBe("C");
});


test("child settlement cannot substitute foreign scope or partial collection for joined evidence", () => {
  const process = { version: 1, runId: id(1), stage: "C", daemonGeneration: 3,
    userWriteAttempts: 0, acceptedUserWrites: 0, acknowledgmentWithheld: false, runtimeRequestAttempts: 0,
    providerLaunchAttempts: 0, observationViolation: false, providerIdentity: null,
    providerRootCollected: true, providerStdoutEof: true, providerStderrEof: true,
    runtimeObserversJoined: true, identityInspectorsJoined: true, operationFailure: false, collection: "joined" };
  const outcome = { version: 1, purpose: "authenticated_personal_daemon_restart", runId: id(1), stage: "C", outcome: "stopped", process };
  expect(daemonQualificationChildResultSchema.safeParse(outcome).success).toBeTrue();
  for (const patch of [{ runId: id(8) }, { stage: "A" }, { providerStdoutEof: false }, { identityInspectorsJoined: false },
    { acceptedUserWrites: 1 }, { acknowledgmentWithheld: true }, { observationViolation: true }]) {
    expect(daemonQualificationChildResultSchema.safeParse({ ...outcome, process: { ...process, ...patch } }).success).toBeFalse();
  }
});
