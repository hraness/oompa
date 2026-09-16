export type DevinFailureCode =
  | "INVALID_INPUT"
  | "PROCESS_EXITED"
  | "PROTOCOL_LIMIT"
  | "RUNTIME_MISMATCH"
  | "TIMEOUT";

/** Never carries provider output text. Callers add only bounded, safe detail. */
export class DevinError extends Error {
  readonly code: DevinFailureCode;

  constructor(code: DevinFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DevinError";
    this.code = code;
  }
}
