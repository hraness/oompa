import {
  loadLocalCustodyRustEngine,
  type LocalCustodyRustEngine,
} from "@hraness/local-custody/custody-rust";

let enginePromise: Promise<LocalCustodyRustEngine> | undefined;

/**
 * The one process-wide local-custody engine. The loader probes the packaged
 * Rust sidecar once; each delegated operation then prefers the sidecar and
 * falls back to the TypeScript implementation operation by operation, with a
 * bounded `local-custody-rust-fallback` stderr notice when it does.
 *
 * Only operations whose observable contract survives the engine qualify here:
 * the sidecar reports a missing path as a `CustodyError` domain failure with
 * a `stat`/`open` code, never an `ENOENT` `ErrnoException`, so custody checks
 * whose callers branch on `error.code === "ENOENT"` keep the direct
 * `@hraness/local-custody` imports instead of routing through this engine.
 */
export function localCustodyEngine(): Promise<LocalCustodyRustEngine> {
  enginePromise ??= loadLocalCustodyRustEngine();
  return enginePromise;
}
