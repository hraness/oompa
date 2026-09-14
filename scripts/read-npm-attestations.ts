import { readBoundedJsonResponse } from "./bounded-json-response";
import { publicPackageAttestationName } from "./release-distribution-policy";

type AttestationReaderRuntime = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutSignal: (milliseconds: number) => AbortSignal;
}>;

const runtime: AttestationReaderRuntime = {
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
};

const maximumAttempts = 60;
const maximumElapsedMs = 180_000;
const retryDelayMs = 3_000;

function visibilityExpired(): Error {
  return new Error("npm Sigstore attestations did not become readable within the visibility budget.");
}

async function withinSignal<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as unknown);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Reads evidence only; a readable response is not provenance admission. */
export async function readNpmAttestations(
  version: unknown,
  dependencies: AttestationReaderRuntime = runtime,
): Promise<unknown> {
  if (
    typeof version !== "string" || version.length > 64
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)
  ) throw new Error("npm attestations require an exact stable release version.");
  const startedAt = dependencies.now();
  let lastObservedAt = startedAt;
  function remainingMs(): number {
    const now = dependencies.now();
    if (!Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(now) || now < lastObservedAt) {
      throw new Error("npm attestation visibility requires a monotonic clock.");
    }
    lastObservedAt = now;
    const remaining = Math.floor(maximumElapsedMs - (now - startedAt));
    if (remaining <= 0) throw visibilityExpired();
    return remaining;
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    // Keep one signal across headers, body consumption, and parser cleanup.
    const signal = dependencies.timeoutSignal(Math.min(20_000, remainingMs()));
    const response = await withinSignal(signal, () => dependencies.fetch(
      `https://registry.npmjs.org/-/npm/v1/attestations/${publicPackageAttestationName}@${version}`,
      {
        cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        method: "GET",
        redirect: "error",
        signal,
      },
    ));
    try {
      remainingMs();
      if (response.status === 200) {
        const value = await withinSignal(signal, () =>
          readBoundedJsonResponse(response, "npm Sigstore attestations", 512 * 1024));
        remainingMs();
        return value;
      }
      if (response.status !== 404) {
        throw new Error(`npm Sigstore attestations returned HTTP ${String(response.status)}.`);
      }
    } finally {
      // Discard error bodies without reading them or awaiting unbounded cleanup.
      void response.body?.cancel().catch(() => undefined);
    }
    if (attempt + 1 === maximumAttempts || remainingMs() <= retryDelayMs) throw visibilityExpired();
    await dependencies.sleep(retryDelayMs);
  }
  throw visibilityExpired();
}
