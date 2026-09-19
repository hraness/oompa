import { chmod, unlink } from "node:fs/promises";
import { assertOwnedPath } from "@hraness/local-custody/private-paths";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";

import type {
  ClaudeHostToolBindingAuthority,
  ClaudeHostToolCallbackHandler,
} from "../claude/index.ts";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths.ts";
import { localCustodyEngine } from "./custody-engine.ts";

const CALLBACK_SOCKET_NAME = "claude-host-tools.sock";
const CALLBACK_REQUEST_MAX_BYTES = 4 * 1_024 * 1_024;
const CALLBACK_RESPONSE_MAX_BYTES = 512 * 1_024;
const CALLBACK_CONNECTION_LIMIT = 8;
const CALLBACK_DEADLINE_MS = 45_000;

export class ClaudeHostToolTransportShutdownTimeoutError extends Error {
  constructor() {
    super("Claude host-tool callback transport did not settle before its shutdown deadline.");
    this.name = "ClaudeHostToolTransportShutdownTimeoutError";
  }
}

export const claudeHostToolCallbackSocketPath = (paths: StatePaths): string =>
  join(paths.runtime, CALLBACK_SOCKET_NAME);

// The socket was just bound and chmodded, so a missing path is not a distinct
// outcome here; the custody engine's Rust sidecar owns this re-validation.
const assertPrivateSocket = async (path: string): Promise<void> => {
  const custody = await localCustodyEngine();
  await custody.assertOwnedPath(path, { kind: "socket", exactMode: 0o600 });
};

// A missing endpoint must surface as a raw `ENOENT` `ErrnoException` so the
// stale-socket path is skipped; the custody engine reports a missing path as
// a `CustodyError` domain failure (sidecar code `stat`), so this check keeps
// the direct TypeScript import.
const removeStaleSocket = async (path: string): Promise<void> => {
  try {
    await assertOwnedPath(path, { kind: "socket" });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Refusing to replace an unsafe Claude host-tool endpoint.", { cause: error });
  }
  await unlink(path);
};

/**
 * The daemon-owned endpoint for Claude's narrow stdio MCP bridge. The socket
 * grants no general daemon command authority: every decoded value goes
 * directly through the session binding authority and its closed callback
 * handler. File mode is attribution within the current OS user, not hostile
 * same-user process isolation.
 */
export class ClaudeHostToolCallbackServer {
  readonly #server: Server;
  readonly #authority: ClaudeHostToolBindingAuthority;
  readonly #handler: ClaudeHostToolCallbackHandler;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  readonly #path: string;
  readonly #sockets = new Set<Socket>();
  readonly #inFlight = new Set<Promise<void>>();
  #accepting = true;
  #listenerClosed: Promise<void> | undefined;

  private constructor(input: {
    path: string;
    authority: ClaudeHostToolBindingAuthority;
    handler: ClaudeHostToolCallbackHandler;
    onFatalError?: (error: Error) => void;
    serverFactory?: (accept: (socket: Socket) => void) => Server;
  }) {
    this.#path = input.path;
    this.#authority = input.authority;
    this.#handler = input.handler;
    this.#onFatalError = input.onFatalError;
    this.#server = (input.serverFactory ?? createServer)((socket) => this.#accept(socket));
    // A listening server can still emit an asynchronous error. Retain an
    // owner for that event for the server's whole lifetime so it can never
    // escape as an uncaught EventEmitter error after the startup listener is
    // removed.
    this.#server.on("error", (error) => {
      if (!this.#accepting) return;
      this.beginShutdown();
      this.#onFatalError?.(error);
    });
  }

  static async start(input: {
    paths: StatePaths;
    authority: ClaudeHostToolBindingAuthority;
    handler: ClaudeHostToolCallbackHandler;
    onFatalError?: (error: Error) => void;
    serverFactory?: (accept: (socket: Socket) => void) => Server;
  }): Promise<ClaudeHostToolCallbackServer> {
    const privateRoot = await ensurePrivateDirectory(input.paths.runtime);
    const path = claudeHostToolCallbackSocketPath({
      ...input.paths,
      runtime: privateRoot,
    });
    if (resolve(path) !== path || !path.startsWith(`${privateRoot}/`)) {
      throw new Error("Claude host-tool callback endpoint escaped its private runtime root.");
    }
    await removeStaleSocket(path);
    const owned = new ClaudeHostToolCallbackServer({
      path,
      authority: input.authority,
      handler: input.handler,
      ...(input.onFatalError === undefined ? {} : { onFatalError: input.onFatalError }),
      ...(input.serverFactory === undefined ? {} : { serverFactory: input.serverFactory }),
    });
    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        owned.#server.once("error", rejectStart);
        owned.#server.listen(path, () => {
          owned.#server.off("error", rejectStart);
          resolveStart();
        });
      });
      await chmod(path, 0o600);
      await assertPrivateSocket(path);
      return owned;
    } catch (error: unknown) {
      owned.beginShutdown();
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  get path(): string {
    return this.#path;
  }

  #accept(socket: Socket): void {
    if (!this.#accepting || this.#sockets.size >= CALLBACK_CONNECTION_LIMIT) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    let received = Buffer.alloc(0);
    let handled = false;
    const deadline = setTimeout(() => socket.destroy(), CALLBACK_DEADLINE_MS);
    deadline.unref();
    const release = (): void => {
      clearTimeout(deadline);
      this.#sockets.delete(socket);
    };
    socket.once("close", release);
    socket.once("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (!this.#accepting) {
        socket.destroy();
        return;
      }
      if (handled) {
        if (chunk.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
          socket.destroy();
        }
        return;
      }
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > CALLBACK_REQUEST_MAX_BYTES) {
        received = Buffer.alloc(0);
        socket.destroy();
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      const trailing = received.subarray(newline + 1);
      if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
        received = Buffer.alloc(0);
        socket.destroy();
        return;
      }
      const frame = received.subarray(0, newline);
      received = Buffer.alloc(0);
      const task = this.#handle(socket, frame);
      this.#inFlight.add(task);
      void task.finally(() => this.#inFlight.delete(task));
    });
  }

  async #handle(socket: Socket, frame: Buffer): Promise<void> {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      const response = await this.#authority.handleCallback(
        JSON.parse(text) as unknown,
        this.#handler,
      );
      if (!this.#accepting || socket.destroyed) return;
      const line = `${JSON.stringify(response)}\n`;
      if (Buffer.byteLength(line, "utf8") > CALLBACK_RESPONSE_MAX_BYTES) {
        socket.destroy();
        return;
      }
      socket.end(line);
    } catch {
      // Authentication and parse failures expose no capability, actor, path,
      // input, or host error. The MCP side reports one generic failed call.
      socket.destroy();
    }
  }

  beginShutdown(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#listenerClosed = new Promise<void>((resolveClose) => {
      this.#server.close(() => resolveClose());
    });
    for (const socket of this.#sockets) socket.destroy();
  }

  async close(deadlineMs = 5_000): Promise<void> {
    this.beginShutdown();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          this.#listenerClosed ?? Promise.resolve(),
          Promise.allSettled([...this.#inFlight]),
        ]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new ClaudeHostToolTransportShutdownTimeoutError()),
            deadlineMs,
          );
          deadline.unref();
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await unlink(this.#path).catch(() => undefined);
    }
  }
}
