import { z } from "zod";
import { encodeQualificationCheckpoint } from "./receipt.ts";
import { observeQualification, QUALIFICATION_CLEANUP_ROOTS, QualificationStateError, type QualificationCleanupRoot, type QualificationState, type QualificationResult } from "./state.ts";

/** This closed absence is intentional. No callable native login/status/logout adapter exists here. */
export const LIVE_QUALIFICATION_CAPABILITY = Object.freeze({ status: "unavailable", reason: "native_authentication_transport_and_custody_unimplemented" } as const);
const fixtureMode = (value: unknown): boolean => value === "credential_free_fixture";
export type CredentialFreeFixturePorts = Readonly<{
  mode: "credential_free_fixture";
  persist: (checkpoint: Uint8Array) => Promise<void>;
  revalidate: () => Promise<Readonly<{ bindingTag: string; sourceAndExecutableRevalidated: boolean; privateCustodyRevalidated: boolean; environmentRevalidated: boolean }>>;
  // Fixture facts only. A future real effect port must revalidate at actual
  // launch: persisted dispatch adds an await after the observation above.
  observe: (request: Readonly<{ step: number; attemptId: string }>) => Promise<QualificationResult>;
  observeCleanupRoot?: (request: Readonly<{ root: QualificationCleanupRoot; attemptId: string }>) => Promise<unknown>;
}>;

/** Test-only orchestration. The fixture port reports observations; it has no production adapter. */
export async function driveCredentialFreeFixtureStep(state: QualificationState, key: Uint8Array, attemptId: string, ports: CredentialFreeFixturePorts): Promise<QualificationState> {
  if (!fixtureMode(ports.mode) || state.failure !== null || state.needsRecovery || state.pending !== null || state.step >= 22) throw new QualificationStateError("order_invalid");
  let next = observeQualification(state, { type: "intent", attemptId, step: state.step });
  if (next.failure !== null) return next;
  try {
    await ports.persist(encodeQualificationCheckpoint(next, key));
    next = observeQualification(next, { type: "persisted", attemptId });
    await ports.persist(encodeQualificationCheckpoint(next, key));
    const validation = await ports.revalidate();
    next = observeQualification(next, { type: "dispatch", attemptId, ...validation });
    await ports.persist(encodeQualificationCheckpoint(next, key));
  } catch { return observeQualification(next, { type: "suspend", reason: "persistence_uncertain" }); }
  if (next.failure !== null) return next;
  if (state.step === 21) {
    for (const root of QUALIFICATION_CLEANUP_ROOTS) {
      next = observeQualification(next, { type: "cleanup_root_intent", attemptId, root });
      if (next.failure !== null) return next;
      try { await ports.persist(encodeQualificationCheckpoint(next, key)); }
      catch { return observeQualification(next, { type: "suspend", reason: "persistence_uncertain" }); }
      try {
        if (ports.observeCleanupRoot === undefined) throw new QualificationStateError("observation_invalid");
        z.strictObject({ root: z.literal(root), removalReconciled: z.literal(true) }).parse(await ports.observeCleanupRoot({ root, attemptId }));
      } catch { return observeQualification(next, { type: "suspend", reason: "uncertain_effect" }); }
      next = observeQualification(next, { type: "cleanup_root_removed", attemptId, root });
      if (next.failure !== null) return next;
      try { await ports.persist(encodeQualificationCheckpoint(next, key)); }
      catch { return observeQualification(next, { type: "suspend", reason: "persistence_uncertain" }); }
    }
  }
  try {
    const result = await ports.observe({ step: state.step, attemptId });
    next = observeQualification(next, { type: "settled", attemptId, result });
  } catch { return observeQualification(next, { type: "suspend", reason: "uncertain_effect" }); }
  try { await ports.persist(encodeQualificationCheckpoint(next, key)); }
  catch { return observeQualification(next, { type: "suspend", reason: "persistence_uncertain" }); }
  return next;
}

/** Recovery consumes fresh evidence of the existing attempt. It never calls the effect port. */
export async function reconcileCredentialFreeFixtureAttempt(state: QualificationState, key: Uint8Array, attemptId: string, result: QualificationResult, persist: CredentialFreeFixturePorts["persist"]): Promise<QualificationState> {
  const next = observeQualification(state, { type: "reconciled", attemptId, result });
  try { await persist(encodeQualificationCheckpoint(next, key)); }
  catch { return observeQualification(next, { type: "suspend", reason: "persistence_uncertain" }); }
  return next;
}
