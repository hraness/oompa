/** Trusted host process boundary. This is an in-memory adapter contract, not a
 * wire protocol, launch API, runtime qualification or authority to signal PIDs.
 * The host owns artifact admission, launch policy and durable account custody. */
export type ProviderProcessBinding = Readonly<{
  version: 1;
  nonce: string;
  scope: "posix-process-group" | "windows-job";
}>;

export type ProviderProcessWriteResult = Readonly<{
  outcome: "accepted-full" | "refused-before-write" | "partial-known" | "indeterminate";
  acceptedBytes: number;
}>;

export type ProviderProcessSettlement = Readonly<{
  kind: "joined" | "not-started";
  binding: ProviderProcessBinding;
}>;

export interface ProviderProcessPort {
  /** Resolves only after runtime readiness and the host's durable Ready commit. */
  readonly ready: Promise<unknown>;
  /** Root observation only. Neither root exit nor a rejected launch proves join. */
  readonly rootExited: Promise<unknown>;
  /** The trusted owner resolves this only after exact scope, native stream EOF,
   * supervisor and control work join, or exact proof that launch never started.
   * Operation or JavaScript delivery failure does not invalidate that proof. */
  readonly joined: Promise<ProviderProcessSettlement>;
  /** Operation result, separate from custody. Success includes consumer drain;
   * rejection may precede physical join and must never be reinterpreted as it. */
  readonly transportCompleted: Promise<void>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Makes its admission decision synchronously when called, with no queue
   * behind an outstanding provider write. It never retries uncertain bytes. */
  write(bytes: Uint8Array): Promise<ProviderProcessWriteResult>;
  closeInput(): Promise<void>;
  /** Both calls revoke new writes synchronously and retain observation. Stop
   * uses the exact owned handle, including a launch that is not ready yet. */
  requestStop(): void;
  forceStop(): void;
}

export function snapshotProviderProcessBinding(value: unknown): ProviderProcessBinding {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("nonce" in value) || typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(value.nonce)
    || !("scope" in value) || (value.scope !== "posix-process-group" && value.scope !== "windows-job")) {
    throw Error("PROVIDER_PROCESS_BINDING_INVALID");
  }
  return Object.freeze({ version: 1, nonce: value.nonce, scope: value.scope });
}

/** Compare validated version-1 values. Parse foreign inputs with the snapshot
 * validator before this typed comparison. */
export function sameProviderProcessBinding(a: ProviderProcessBinding, b: ProviderProcessBinding): boolean {
  return a.nonce === b.nonce && a.scope === b.scope;
}

/** Validate byte acceptance without treating a successful write as a successful
 * RPC. Extra host receipt fields stay outside this product adapter. */
export function providerProcessWriteResult(value: unknown, byteLength: number): ProviderProcessWriteResult {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(byteLength) || byteLength < 1
    || !("acceptedBytes" in value) || typeof value.acceptedBytes !== "number"
    || !Number.isSafeInteger(value.acceptedBytes) || value.acceptedBytes < 0 || value.acceptedBytes > byteLength
    || !("outcome" in value) || !(value.outcome === "accepted-full" && value.acceptedBytes === byteLength
      || value.outcome === "refused-before-write" && value.acceptedBytes === 0
      || value.outcome === "partial-known" && value.acceptedBytes > 0 && value.acceptedBytes < byteLength
      || value.outcome === "indeterminate")) throw Error("PROVIDER_PROCESS_WRITE_RESULT_INVALID");
  return Object.freeze({ outcome: value.outcome, acceptedBytes: value.acceptedBytes });
}
