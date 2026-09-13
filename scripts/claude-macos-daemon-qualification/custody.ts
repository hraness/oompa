import type { DaemonIdentity } from "../../src/daemon/daemon-startup";
import type { LocalCommand } from "../../src/domain/contracts";
import { COMMAND_STEPS, commandIntentSchema, snapshotDaemonQualificationCommand, type DaemonQualificationCommandStep } from "./command-intent";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AtomicPrivateJsonReceipt } from "../live-acceptance-private-custody";
import type { DarwinSessionCustody } from "../claude-macos-session-qualification/custody";
import type { SessionAdmission } from "../claude-macos-session-qualification/authentication";
import { daemonQualificationDescriptorSchema, type DaemonQualificationDescriptor, type DaemonQualificationStage } from "./contract";
import { DaemonRestartObservation, type DaemonRestartEvent, type DaemonRestartScope } from "./state";

const recordSchema = z.strictObject({ version: z.literal(1), runId: z.string().uuid(), ownerEpoch: z.string().uuid(),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u), revision: z.number().int().min(0).max(32),
  childIntents: z.array(z.strictObject({ stage: z.enum(["A", "B", "C"]), descriptorTag: z.string().regex(/^[0-9a-f]{64}$/u),
    joined: z.boolean() })).max(3), commandIntents: z.array(commandIntentSchema).max(6), observations: z.array(z.unknown()).max(10), failure: z.boolean() });
type RecordValue = z.infer<typeof recordSchema>;
function refused(): never { throw new Error("DARWIN_DAEMON_JOURNAL_REFUSED"); }

export async function tagDaemonQualificationValue(seed: DarwinSessionCustody,
  domain: "descriptor" | "thread" | "command" | "turn" | "idempotency" | "intent", value: string): Promise<string> {
  return await seed.withProofKey(async (key) => createHmac("sha256", key)
    .update(JSON.stringify(["oompa-darwin-daemon-v1", seed.scope.runId, domain])).update(value).digest("hex"));
}

/** The native owner is retained from authentication through the last child.
 * No deserialized journal can construct or restore this authority. */
export class DaemonQualificationCustody {
  readonly #seed: DarwinSessionCustody;
  readonly #admission: SessionAdmission;
  readonly #observation: DaemonRestartObservation;
  readonly #scope: DaemonRestartScope;
  #receipt: AtomicPrivateJsonReceipt<RecordValue> | null = null;
  #value: RecordValue;
  #failed = false;
  #busy = false;
  #reserving = false;
  #descriptor: DaemonQualificationDescriptor | null = null;
  private constructor(seed: DarwinSessionCustody, admission: SessionAdmission, scope: DaemonRestartScope) {
    this.#seed = seed; this.#admission = admission; this.#scope = scope;
    this.#observation = new DaemonRestartObservation(scope);
    this.#value = { version: 1, runId: seed.scope.runId, ownerEpoch: seed.scope.ownerEpoch,
      sourceSha: admission.source.sourceSha, revision: 0, childIntents: [], commandIntents: [], observations: [], failure: false };
  }
  static async create(seed: DarwinSessionCustody, admission: SessionAdmission, scope: DaemonRestartScope): Promise<DaemonQualificationCustody> {
    seed.assertDaemonOwnerCurrent(); admission.assertCurrent();
    if (scope.sourceSha !== admission.source.sourceSha || scope.runId !== seed.scope.runId) refused();
    const owner = new DaemonQualificationCustody(seed, admission, scope);
    owner.#receipt = await AtomicPrivateJsonReceipt.create(owner.#value, {
      path: () => join(seed.scope.runRoot, "daemon-restart.json"), maximumBytes: 32768,
      invalid: () => new Error("DARWIN_DAEMON_JOURNAL_REFUSED"),
      parse: (value) => {
        const parsed = recordSchema.parse(value);
        if (parsed.runId !== seed.scope.runId || parsed.ownerEpoch !== seed.scope.ownerEpoch || parsed.sourceSha !== scope.sourceSha) refused();
        return parsed;
      },
      assertRuntime: async () => { seed.assertDaemonOwnerCurrent(); admission.assertCurrent(); },
      createdIdentityMatches: (before, after) => before.revision + 1 === after.revision && !before.failure,
    });
    owner.assertCurrent(); return owner;
  }
  assertCurrent(): void {
    if (this.#failed || this.#receipt === null) refused();
    this.#seed.assertDaemonOwnerCurrent(); this.#admission.assertCurrent(); this.#receipt.assertVerifiedIdentity();
  }
  async #persist(update: (value: RecordValue) => RecordValue): Promise<void> {
    this.assertCurrent(); if (this.#busy) refused(); this.#busy = true;
    try {
      const next = recordSchema.parse(update(structuredClone(this.#value)));
      if (this.#receipt === null) refused();
      await this.#receipt.update(() => next); this.#value = next; this.assertCurrent();
    } catch (error: unknown) { this.#failed = true; throw error; }
    finally { this.#busy = false; }
  }
  #reserve(): void {
    this.assertCurrent(); if (this.#reserving || this.#busy) { this.#failed = true; refused(); } this.#reserving = true;
  }
  async childIntent(input: DaemonQualificationDescriptor): Promise<void> {
    this.#reserve();
    try {
      const descriptor = daemonQualificationDescriptorSchema.parse(input);
      const expected = (["A", "B", "C"] as const)[this.#value.childIntents.length];
      if (descriptor.runId !== this.#seed.scope.runId || descriptor.ownerEpoch !== this.#seed.scope.ownerEpoch
        || descriptor.runRoot !== this.#seed.scope.runRoot || descriptor.sourceCommit !== this.#scope.sourceSha
        || descriptor.stage !== expected || this.#value.childIntents.some((child) => !child.joined)) refused();
      const descriptorTag = await this.tag("descriptor", JSON.stringify(descriptor));
      await this.#persist((value) => ({ ...value, revision: value.revision + 1,
        childIntents: [...value.childIntents, { stage: descriptor.stage, descriptorTag, joined: false }] }));
      this.#descriptor = descriptor;
    } catch (error: unknown) { this.#failed = true; throw error; }
    finally { this.#reserving = false; }
  }
  async commandIntent(step: DaemonQualificationCommandStep, identity: DaemonIdentity, command: LocalCommand): Promise<LocalCommand> {
    // Reserve and snapshot before the first await. A rejected/unknown prefix is
    // retained; this owner has no replay or automatic receipt restoration path.
    this.#reserve();
    try {
      if (COMMAND_STEPS[this.#value.commandIntents.length] !== step || this.#descriptor === null) refused();
      const captured = snapshotDaemonQualificationCommand(step, this.#descriptor, identity, command);
      const child = this.#value.childIntents.at(-1);
      const ready = this.#value.observations.findLast((event) => {
        const parsed = event as { type?: unknown; generationStage?: unknown };
        return parsed.type === "ready" && parsed.generationStage === captured.binding.stage;
      }) as { daemonGeneration?: unknown; daemonNonce?: unknown } | undefined;
      if (child?.stage !== captured.binding.stage || child.joined
        || ready?.daemonGeneration !== identity.generation || ready.daemonNonce !== identity.nonce) refused();
      const commandTag = await this.tag("command", JSON.stringify([captured.binding, captured.command]));
      await this.#persist((value) => ({ ...value, revision: value.revision + 1,
        commandIntents: [...value.commandIntents, { ...captured.binding, commandTag }] }));
      this.assertCurrent(); return captured.command;
    } catch (error: unknown) { this.#failed = true; throw error; }
    finally { this.#reserving = false; }
  }
  async observe(input: DaemonRestartEvent): Promise<void> {
    if (this.#reserving || this.#busy) { this.#failed = true; refused(); }
    const event = structuredClone(input);
    this.#observation.observe(event);
    await this.#persist((value) => {
      const current = value.childIntents.at(-1);
      if (current?.stage !== event.generationStage || current.joined) refused();
      if (event.type === "joined") current.joined = true;
      return { ...value, revision: value.revision + 1, observations: [...value.observations, event] };
    });
  }
  async tag(domain: "descriptor" | "thread" | "command" | "turn" | "idempotency" | "intent", value: string): Promise<string> {
    return await tagDaemonQualificationValue(this.#seed, domain, value);
  }
  finish() { this.assertCurrent(); if (this.#reserving || this.#value.commandIntents.length !== COMMAND_STEPS.length || this.#value.childIntents.length !== 3 || this.#value.childIntents.some((child) => !child.joined)) refused(); return this.#observation.finish(); }
  currentStage(): DaemonQualificationStage | null { return this.#value.childIntents.at(-1)?.stage ?? null; }
}
