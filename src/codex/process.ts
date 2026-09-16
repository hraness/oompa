import { CodexError } from "./errors.ts";

export interface CodexProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  write(bytes: Uint8Array): Promise<void>;
  terminate(): void;
  forceTerminate(): void;
}

export interface SpawnCodexProcessOptions {
  readonly argv: readonly [string, ...string[]];
  readonly codexHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export const SAFE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "HRANESS_SUPPORT",
  "HRANESS_SUPPORT_AUDIENCE",
  "HRANESS_SUPPORT_EMAIL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);

// Every child Oompa spawns receives this allowlist plus the caller's named
// extra keys. Nothing else from the parent environment crosses the boundary.
export function allowlistedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  extraKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(environment)) {
    if ((SAFE_ENVIRONMENT_KEYS.has(key) || extraKeys.has(key)) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function spawnBunCodexProcess(options: SpawnCodexProcessOptions): CodexProcess {
  const env = allowlistedEnvironment(options.environment ?? process.env);
  env.CODEX_HOME = options.codexHome;
  env.NO_COLOR = "1";

  const child = Bun.spawn([...options.argv], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (typeof child.stdin === "number") {
    child.kill();
    throw new CodexError("PROCESS_EXITED", "Codex did not expose a writable stdin pipe");
  }

  const stdin = child.stdin;
  return {
    stdout: readableStreamChunks(child.stdout),
    stderr: readableStreamChunks(child.stderr),
    exited: child.exited,
    async write(bytes: Uint8Array): Promise<void> {
      const written = stdin.write(bytes);
      const count = written instanceof Promise ? await written : written;
      if (count !== bytes.byteLength) {
        throw new CodexError("PROCESS_EXITED", "Codex stdin accepted a partial frame");
      }
      const flushed = stdin.flush();
      if (flushed instanceof Promise) await flushed;
    },
    terminate(): void {
      child.kill("SIGTERM");
    },
    forceTerminate(): void {
      child.kill("SIGKILL");
    },
  };
}

async function* readableStreamChunks(
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (result.value.byteLength > 0) yield result.value;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}
