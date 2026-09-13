import type { ClaudeProcessIdentity } from "../../src/claude/process";
import type { DarwinSessionScope, JournalAttempt, SessionDispatchTicket } from "./custody";

/** Internal script composition only; native entrypoints never accept this port. */
export type QualificationSessionCustody = Readonly<{
  scope: DarwinSessionScope;
  assertCurrent(): Promise<void>;
  prepareDispatch(attempt: JournalAttempt, input: Readonly<{ kind: "process" | "frame"; frame?: Uint8Array }>): Promise<SessionDispatchTicket>;
  acknowledgeDispatch(attempt: JournalAttempt, dispatchId: string): Promise<void>;
  recordChild(attempt: JournalAttempt, identity: ClaudeProcessIdentity): Promise<void>;
  withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T>;
}>;
