export type ClaudeFailureCode =
  | "AUTHORITY_STALE"
  | "CONFIG_DIR_MISMATCH"
  | "DEADLINE_EXPIRED"
  | "INDETERMINATE_EFFECT"
  | "INVALID_INPUT"
  | "NOT_AUTHENTICATED"
  | "PRESET_UNSUPPORTED"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "PROTOCOL_LIMIT"
  | "RUNTIME_MISMATCH"
  | "TIMEOUT"
  | "UNSUPPORTED_CAPABILITY";

/** Never carries provider payload text. Callers add only bounded, safe detail. */
export class ClaudeError extends Error {
  readonly code: ClaudeFailureCode;

  constructor(code: ClaudeFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeError";
    this.code = code;
  }
}

export type ClaudeEffectOperation =
  | "write"
  | "turn/start"
  | "turn/steer"
  | "turn/interrupt"
  | "session/compact"
  | "interaction/resolve";

/** Local dispatch uncertainty, never a provider rejection or permission to replay. */
export class IndeterminateClaudeEffectError extends ClaudeError {
  constructor(readonly operation: ClaudeEffectOperation, cause?: unknown) {
    super(
      "INDETERMINATE_EFFECT",
      "A Claude operation may have reached the runtime; reconcile it before another attempt.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "IndeterminateClaudeEffectError";
  }
}
