const PULSE_USER_AGENT =
  "hraness-pr-pulse/1.0 (+https://hraness.com/pr; public emergency signal aggregation)";

export const PULSE_MAX_BYTES = 2 * 1024 * 1024;
export const PULSE_FETCH_TIMEOUT_MS = 15_000;

export class PulseFetchError extends Error {}

const readBoundedBody = async (
  response: Response,
  label: string,
  maximumBytes: number,
  lossy: boolean,
): Promise<string> => {
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) throw new PulseFetchError(`${label} exceeds its declared byte bound.`);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new PulseFetchError(`${label} has no body.`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximumBytes) {
        throw new PulseFetchError(`${label} exceeds its byte bound.`);
      }
      chunks.push(item.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The closed response stays authoritative either way.
    }
    reader.releaseLock();
  }
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: !lossy }).decode(payload);
  } catch {
    throw new PulseFetchError(`${label} returned malformed text.`);
  }
};

export interface PulseFetchOptions {
  readonly accept?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly label?: string;
  /** Tolerate non-UTF-8 feeds (ISO-8859-1 wire bytes become U+FFFD). */
  readonly lossy?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export type PulseFetch = (
  url: string,
  options?: PulseFetchOptions,
) => Promise<string>;

const httpsOnly = (url: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PulseFetchError("Source URL is malformed.");
  }
  if (parsed.protocol !== "https:") {
    throw new PulseFetchError("Source URL must use https.");
  }
  return parsed;
};

const attempt = async (url: string, options: PulseFetchOptions): Promise<string> => {
  const label = options.label ?? httpsOnly(url).hostname;
  const response = await fetch(url, {
    headers: {
      "accept": options.accept ?? "*/*",
      "user-agent": PULSE_USER_AGENT,
      ...options.headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? PULSE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new PulseFetchError(`${label} responded ${response.status.toString()}.`);
  }
  return readBoundedBody(response, label, options.maxBytes ?? PULSE_MAX_BYTES, options.lossy ?? false);
};

/** One network retry for transient failures; everything else is bounded. */
export const pulseFetchText: PulseFetch = async (url, options = {}) => {
  httpsOnly(url);
  try {
    return await attempt(url, options);
  } catch (error) {
    if (error instanceof PulseFetchError && /\b(?:4[0-9]{2})\b/u.test(error.message)) {
      throw error;
    }
    return attempt(url, options);
  }
};

export const pulseFetchJson = async (
  url: string,
  options: PulseFetchOptions = {},
): Promise<unknown> => {
  const label = options.label ?? httpsOnly(url).hostname;
  const text = await pulseFetchText(url, { ...options, accept: "application/json, */*" });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PulseFetchError(`${label} returned malformed JSON.`);
  }
};
