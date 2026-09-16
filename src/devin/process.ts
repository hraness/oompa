import { isAbsolute, normalize } from "node:path";

import { DevinError } from "./errors.ts";
import { devinEnvironment } from "./runtime.ts";

/**
 * The isolated home a managed Devin profile runs in. Every directory is owned
 * by the profile root, so the provider's credentials, caches and state never
 * touch the operator's personal Devin home.
 */
export interface DevinDirectories {
  /** The whole HOME seen by Devin. */
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly cacheHome: string;
  readonly stateHome: string;
}

export interface DevinAcpProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  terminate(): void;
  forceTerminate(): void;
}

export interface SpawnDevinAcpProcessOptions {
  readonly argv: readonly [string, ...string[]];
  readonly directories: DevinDirectories;
  readonly projectRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type DevinAcpProcessFactory = (
  options: SpawnDevinAcpProcessOptions,
) => DevinAcpProcess;

const assertAbsoluteNormalized = (value: string, label: string): string => {
  if (
    new TextEncoder().encode(value).byteLength > 4 * 1024
    || value.includes("\0")
    || !isAbsolute(value)
    || normalize(value) !== value
  ) {
    throw new DevinError("INVALID_INPUT", `${label} must be an absolute normalized path`);
  }
  return value;
};

export function validateDevinDirectories(input: DevinDirectories): DevinDirectories {
  const directories: DevinDirectories = {
    home: assertAbsoluteNormalized(input.home, "Devin HOME"),
    configHome: assertAbsoluteNormalized(input.configHome, "Devin XDG_CONFIG_HOME"),
    dataHome: assertAbsoluteNormalized(input.dataHome, "Devin XDG_DATA_HOME"),
    cacheHome: assertAbsoluteNormalized(input.cacheHome, "Devin XDG_CACHE_HOME"),
    stateHome: assertAbsoluteNormalized(input.stateHome, "Devin XDG_STATE_HOME"),
  };
  if (new Set(Object.values(directories)).size !== 5) {
    throw new DevinError("INVALID_INPUT", "Devin HOME and XDG directories must be distinct");
  }
  return Object.freeze(directories);
}

/**
 * The allowlisted ambient environment with every home-resolving variable
 * replaced by the profile's isolated directories. Ambient provider
 * credentials, proxies and configuration paths never cross the allowlist in
 * `runtime.ts`; the operator's own HOME and XDG values are overridden here so
 * a managed child cannot reach the personal Devin credentials file.
 */
export function isolatedDevinEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: DevinDirectories,
): Record<string, string> {
  const directories = validateDevinDirectories(input);
  const result = devinEnvironment(environment);
  for (const [key, value] of Object.entries(result)) {
    if (value.includes("\0") || new TextEncoder().encode(value).byteLength > 64 * 1024) {
      throw new DevinError("INVALID_INPUT", `Devin environment value for ${key} is invalid`);
    }
  }
  result.HOME = directories.home;
  result.XDG_CONFIG_HOME = directories.configHome;
  result.XDG_DATA_HOME = directories.dataHome;
  result.XDG_CACHE_HOME = directories.cacheHome;
  result.XDG_STATE_HOME = directories.stateHome;
  result.NO_COLOR = "1";
  return result;
}

const readableStreamChunks = async function* (
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let next = await reader.read();
    while (!next.done) {
      if (next.value.byteLength > 0) yield next.value;
      next = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
};

export const spawnBunDevinAcpProcess: DevinAcpProcessFactory = (options) => {
  if (!isAbsolute(options.argv[0])) {
    throw new DevinError("INVALID_INPUT", "the Devin executable path must be absolute");
  }
  if (options.projectRoot !== undefined) {
    assertAbsoluteNormalized(options.projectRoot, "Devin project root");
  }
  const child = Bun.spawn([...options.argv], {
    env: isolatedDevinEnvironment(options.environment ?? process.env, options.directories),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.projectRoot === undefined ? {} : { cwd: options.projectRoot }),
  });
  if (
    typeof child.stdin === "number"
    || typeof child.stdout === "number"
  ) {
    child.kill("SIGKILL");
    throw new DevinError("PROCESS_EXITED", "Devin did not expose the required ACP pipes");
  }
  const sink = child.stdin;
  let ended = false;
  const stdin = new WritableStream<Uint8Array>({
    async write(bytes) {
      if (ended) throw new DevinError("PROCESS_EXITED", "Devin stdin is closed");
      const written = sink.write(bytes);
      const count = written instanceof Promise ? await written : written;
      if (count !== bytes.byteLength) {
        throw new DevinError("PROCESS_EXITED", "Devin stdin accepted a partial frame");
      }
      const flushed = sink.flush();
      if (flushed instanceof Promise) await flushed;
    },
    async close() {
      if (ended) return;
      ended = true;
      await sink.end();
    },
    async abort() {
      if (ended) return;
      ended = true;
      await sink.end();
    },
  });
  return {
    exited: child.exited,
    forceTerminate: () => { child.kill("SIGKILL"); },
    stderr: readableStreamChunks(child.stderr),
    stdin,
    stdout: child.stdout,
    terminate: () => { child.kill("SIGTERM"); },
  };
};
