import { z } from "zod";

import type { ClaudeSessionFact } from "../../src/daemon/claude-session-facts";

const uuid = z.string().uuid();
const inputSchema = z.strictObject({ scenario: z.enum(["stream", "approve", "deny", "interrupt", "resumed"]),
  nonce: uuid, providerThreadId: uuid, connectionId: uuid });
export type SessionTurnScenario = z.infer<typeof inputSchema>["scenario"];
export class DarwinSessionQualificationError extends Error {
  constructor(readonly code: "scope_refused" | "observation_refused" | "limit_exceeded" | "deadline" | "aborted" | "recovery_required") {
    super(`DARWIN_SESSION_QUALIFICATION_${code}`); this.name = "DarwinSessionQualificationError";
  }
}
const refuse = (code: DarwinSessionQualificationError["code"] = "observation_refused"): never => { throw new DarwinSessionQualificationError(code); };

/** Closed scenario expectations only. This object grants no provider or process authority. */
export class SessionTurnObservation {
  readonly scenario: SessionTurnScenario;
  readonly prompt: string;
  readonly command: string | null;
  readonly #scope: z.infer<typeof inputSchema>;
  #turnId: string | null = null;
  #returnedTurnId: string | null = null;
  #requestId: string | null = null;
  #requestTaken = false;
  #decisionWritten = false;
  #interruptWritten = false;
  #text = "";
  #deltaCount = 0;
  #deltaBytes = 0;
  #facts = 0;
  #terminal: "completed" | "interrupted" | "failed" | null = null;
  #summaryObserved = false;
  #resultTailObserved = false;
  #failure: Error | null = null;
  readonly #waiters = new Set<() => void>();

  constructor(input: unknown) {
    const parsed = inputSchema.safeParse(input); if (!parsed.success) throw new DarwinSessionQualificationError("scope_refused");
    this.#scope = Object.freeze(parsed.data); this.scenario = parsed.data.scenario;
    this.command = this.scenario === "approve" || this.scenario === "deny" ? `printf '%s' '${parsed.data.nonce}'` : null;
    this.prompt = this.command === null
      ? this.scenario === "interrupt"
        ? "Write the integers from 1 to 10000 in order, one per line. Do not use any tools."
        : `Reply with exactly ${parsed.data.nonce}. Do not use any tools.`
      : `Request the Bash tool exactly once with only the command ${JSON.stringify(this.command)}. Do not use other tools or change this command. After its approval or denial, reply with exactly ${parsed.data.nonce}.`;
  }

  get turnId(): string { return this.#turnId ?? refuse(); }
  get hasDelta(): boolean { return this.#deltaBytes > 0; }
  get terminal(): boolean { return this.#terminal !== null; }

  observe(fact: ClaudeSessionFact): void {
    try {
      if (this.#failure !== null) throw this.#failure;
      if (++this.#facts > 1024) refuse("limit_exceeded");
      if (fact.providerThreadId !== this.#scope.providerThreadId || fact.connectionId !== this.#scope.connectionId) refuse("scope_refused");
      if (fact.type === "providerDisconnected" || fact.type === "providerError" || fact.type === "sessionBootstrapped") refuse();
      if (fact.type !== "turnStarted" && "turnId" in fact && fact.turnId !== this.#turnId) refuse("scope_refused");
      if (fact.type === "turnStarted") {
        if (this.#turnId !== null || !uuid.safeParse(fact.turnId).success) refuse();
        this.#turnId = fact.turnId;
      } else if (fact.type === "assistantDelta") {
        if (fact.turnId !== this.#turnId || this.#terminal !== null) refuse();
        if (fact.text.length > 16_384) refuse("limit_exceeded");
        const bytes = Buffer.byteLength(fact.text, "utf8");
        if (bytes > 16_384 - this.#deltaBytes) refuse("limit_exceeded");
        this.#deltaBytes += bytes; this.#deltaCount += 1; this.#text += fact.text;
      } else if (fact.type === "interactionRequested") {
        if (this.command === null || this.#requestId !== null || fact.turnId !== this.#turnId || this.#terminal !== null
          || fact.kind !== "command_approval" || fact.request.toolName !== "Bash"
          || Object.keys(fact.request.input).length !== 1 || fact.request.input.command !== this.command
          || fact.requestId.length === 0 || fact.requestId.length > 512) refuse();
        this.#requestId = fact.requestId;
      } else if (fact.type === "turnCompleted") {
        if (fact.turnId !== this.#turnId || this.#terminal !== null) refuse();
        this.#terminal = fact.status;
      } else if (fact.type === "turnSummary") {
        if (this.#terminal === null || this.#summaryObserved || fact.status !== this.#terminal) refuse();
        this.#summaryObserved = true;
      } else if (fact.type === "usageAccountingObserved" || fact.type === "protocolNotice") {
        // This is the production assembler's final result fact. The closed
        // invalid-accounting marker joins delivery, not accounting validity.
        if (!this.#summaryObserved || this.#resultTailObserved
          || (fact.type === "protocolNotice" && fact.event !== "result/accounting_invalid")) refuse();
        this.#resultTailObserved = true;
      } else if (fact.type === "interactionCanceled" && (!this.#decisionWritten || fact.requestId !== this.#requestId)) refuse();
      else if (fact.type === "subagentActivity") refuse();
      this.#wake();
    } catch (error: unknown) {
      this.#failure = error instanceof Error ? error : new DarwinSessionQualificationError("observation_refused");
      this.#wake(); throw this.#failure;
    }
  }

  bindReturnedTurn(turnId: string): void {
    if (this.#returnedTurnId !== null || turnId !== this.#turnId) return refuse();
    this.#returnedTurnId = turnId;
  }
  takeRequest(): string {
    if (this.#requestId === null || this.#requestTaken || this.#terminal !== null) return refuse();
    this.#requestTaken = true; return this.#requestId;
  }
  decisionWritten(): void {
    if (!this.#requestTaken || this.#decisionWritten) return refuse();
    this.#decisionWritten = true;
  }
  interruptWritten(): void {
    if (this.scenario !== "interrupt" || !this.hasDelta || this.#interruptWritten) return refuse();
    this.#interruptWritten = true;
  }

  async wait(kind: "request" | "delta" | "terminal", signal: AbortSignal, deadlineAt: number): Promise<void> {
    const reached = (): boolean => kind === "request" ? this.#requestId !== null : kind === "delta" ? this.hasDelta : this.#resultTailObserved;
    for (;;) {
      if (this.#failure !== null) throw this.#failure;
      if (signal.aborted) return refuse("aborted");
      if (Date.now() >= deadlineAt) return refuse("deadline");
      if (reached()) return;
      if (kind !== "terminal" && this.terminal) return refuse("observation_refused");
      await new Promise<void>((done) => {
        const finish = (): void => { clearTimeout(timer); this.#waiters.delete(finish); signal.removeEventListener("abort", finish); done(); };
        const timer = setTimeout(finish, Math.max(1, deadlineAt - Date.now()));
        this.#waiters.add(finish); signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted || reached() || this.#failure !== null) finish();
      });
    }
  }
  finish(): Readonly<{ deltaCount: number; deltaBytes: number; completed: true; decision: "once" | "decline" | null; interrupted: boolean }> {
    if (this.#failure !== null) throw this.#failure;
    if (!this.#resultTailObserved || this.#returnedTurnId !== this.#turnId || this.#turnId === null || this.#deltaCount < 1 || this.#deltaBytes < 1) return refuse();
    const interrupted = this.scenario === "interrupt";
    if (this.#terminal !== (interrupted ? "interrupted" : "completed") || (interrupted && !this.#interruptWritten)) return refuse();
    if (this.command !== null && !this.#decisionWritten) return refuse();
    if (!interrupted && this.#text.trim() !== this.#scope.nonce) return refuse();
    return Object.freeze({ deltaCount: this.#deltaCount, deltaBytes: this.#deltaBytes, completed: true,
      decision: this.scenario === "approve" ? "once" : this.scenario === "deny" ? "decline" : null, interrupted });
  }
  clear(): void { this.#text = ""; this.#requestId = null; this.#wake(); }
  #wake(): void { for (const done of [...this.#waiters]) done(); }
}
