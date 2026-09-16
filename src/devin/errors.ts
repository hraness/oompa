export type DevinFailureCode =
  | "AUTHORITY_STALE"
  | "DEADLINE_EXPIRED"
  | "INVALID_INPUT"
  | "NOT_AUTHENTICATED"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "PROTOCOL_LIMIT"
  | "RUNTIME_MISMATCH"
  | "TIMEOUT"
  | "UNSUPPORTED_CAPABILITY";

/** Never carries provider output text. Callers add only bounded, safe detail. */
export class DevinError extends Error {
  readonly code: DevinFailureCode;

  constructor(code: DevinFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DevinError";
    this.code = code;
  }
}
