import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";

import { assertOwnedPath, readOwnedFileStable } from "@hraness/local-custody/private-paths";
import { publishPrivateFile } from "@hraness/local-custody/atomic-publish";
import {
  commandEnvelopeSchema,
  commandResponseSchema,
  localCommandPresetContract,
  LOCAL_COMMAND_REQUEST_MAX_BYTES,
  LOCAL_COMMAND_RESPONSE_MAX_BYTES,
  LOCAL_COMMAND_REQUEST_VERSION,
  type CommandResponse,
  type LocalCommand,
} from "../domain/contracts";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths";

const maximumRequestBytes = LOCAL_COMMAND_REQUEST_MAX_BYTES;
const maximumResponseBytes = LOCAL_COMMAND_RESPONSE_MAX_BYTES;
// Cold session creation can spend 10 seconds initializing Codex, 10 seconds on
// launch credential preflight, twice 10 + 40 seconds on credential review and
// capability discovery, and 30 seconds on the provider mutation. The final 30
// seconds lets the adapter settle cancellation and durable effect authority.
export const DEFAULT_LOCAL_REQUEST_DEADLINE_MS =
  10_000 + 10_000 + 2 * (10_000 + 40_000) + 30_000 + 30_000;
// A client must deliver its complete newline-terminated request frame within
// the header timeout. Once the response is queued, it must drain and the
// connection must close within the idle timeout. Neither depends on the request
// deadline above, which bounds handler execution between those two phases.
export const DEFAULT_LOCAL_REQUEST_HEADER_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCAL_CONNECTION_IDLE_TIMEOUT_MS = 10_000;
const maximumTransportTimeoutMs = 3_600_000;
// The 32 connection slots split into 16 ordinary command slots and 16 long-poll
// slots so waiting pollers can never starve `daemon.stop` or `daemon.status`.
// A connection holds a pending slot until its frame is parsed, because the
// closed saturation response must carry the client's own request id.
export const LOCAL_TRANSPORT_COMMAND_SLOTS = 16;
export const LOCAL_TRANSPORT_LONG_POLL_SLOTS = 16;
export const LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT = 32;

type Handler = (command: LocalCommand, context: { requestId: string; signal: AbortSignal; afterResponse(callback: () => void): void }) => Promise<unknown>;

type SlotClass = "command" | "longPoll";

type ConnectionState = {
  admission: SlotClass | "pending";
  idleTimer?: ReturnType<typeof setTimeout>;
};

export type LocalTransportStats = Readonly<{
  commandSlots: Readonly<{ inUse: number; capacity: number }>;
  longPollSlots: Readonly<{ inUse: number; capacity: number }>;
  pendingConnections: Readonly<{ inUse: number; capacity: number }>;
  rejectedSinceStart: Readonly<{ command: number; longPoll: number; pending: number }>;
}>;

// Every command that carries `waitMs` is a bounded long poll when the wait is
// positive; the service parks it on a waiter until events arrive or the wait
// expires. A zero wait is an ordinary read and takes a command slot.
const longPollCommand = (command: LocalCommand): boolean => "waitMs" in command && command.waitMs > 0;

const slotCapacity = (slotClass: SlotClass): number =>
  slotClass === "command" ? LOCAL_TRANSPORT_COMMAND_SLOTS : LOCAL_TRANSPORT_LONG_POLL_SLOTS;

const saturatingIncrement = (value: number): number =>
  value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;

const boundedTimeoutMs = (value: number | undefined, fallback: number): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximumTransportTimeoutMs) {
    throw new Error("Local transport timeouts must be positive integers within one hour.");
  }
  return candidate;
};

async function validateOwnedFile(path: string, kind: "file" | "socket", mode?: number): Promise<void> {
  try {
    await assertOwnedPath(path, { kind, ...(mode === undefined ? {} : { exactMode: mode }) });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`Unsafe local ${kind}: ${path}`, { cause: error });
  }
}

async function removeStaleEndpoint(paths: StatePaths): Promise<void> {
  for (const [path, kind] of [[paths.socket, "socket"], [paths.capability, "file"]] as const) {
    try {
      await validateOwnedFile(path, kind);
      await unlink(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function publishCapability(paths: StatePaths, capability: string): Promise<void> {
  await publishPrivateFile(dirname(paths.capability), basename(paths.capability), `${capability}\n`);
}

const publicFailureCodes = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "AMBIGUOUS",
  "CONFLICT",
  "INTERACTION_REQUIRED",
  "UNAVAILABLE",
  "RECOVERY_REQUIRED",
  "INTERNAL",
] as const;

type PublicFailureCode = typeof publicFailureCodes[number];

export const commandFailureBrand = Symbol("hra.command-failure");

const publicFailureMessages = {
  INVALID_INPUT: "The local command was rejected as invalid.",
  NOT_FOUND: "No matching object was found.",
  AMBIGUOUS: "The selector matches more than one object.",
  CONFLICT: "The local command conflicts with current authority.",
  INTERACTION_REQUIRED: "The local command requires an explicit interaction.",
  UNAVAILABLE: "A required local or provider capability is unavailable.",
  RECOVERY_REQUIRED: "The local command requires recovery before it can continue.",
  INTERNAL: "The local request failed before a safe diagnostic was available.",
} as const satisfies Readonly<Record<PublicFailureCode, string>>;

const closedFailureReasonMessages = {
  codex_authority_stale: {
    code: "UNAVAILABLE",
    message: "The exact Codex process authority changed before the operation finished. Inspect daemon status before starting a fresh attempt.",
  },
  codex_interaction_deadline_expired: {
    code: "CONFLICT",
    message: "The Codex interaction deadline expired before Oompa could apply the response. Refresh pending interactions instead of replaying the expired response.",
  },
  codex_home_mismatch: {
    code: "UNAVAILABLE",
    message: "The Codex home does not match this account's isolated runtime. Run `oompa doctor --json` and repair the reported configuration before retrying.",
  },
  codex_effect_indeterminate: {
    code: "RECOVERY_REQUIRED",
    message: "Codex may have applied the operation, but Oompa could not prove its outcome. Reconcile the recorded attempt before retrying.",
  },
  codex_request_invalid: {
    code: "INVALID_INPUT",
    message: "Codex rejected Oompa's bounded request as invalid. Inspect the command and run `oompa doctor --json` before retrying.",
  },
  codex_process_exited: {
    code: "UNAVAILABLE",
    message: "The pinned Codex process exited before the operation finished. Inspect daemon status before starting a fresh attempt.",
  },
  codex_protocol_error: {
    code: "UNAVAILABLE",
    message: "Codex returned data that violates Oompa's pinned protocol. Run `oompa doctor --json` and repair or update Oompa before retrying.",
  },
  codex_protocol_limit: {
    code: "UNAVAILABLE",
    message: "Codex data exceeded Oompa's bounded protocol limits. Narrow the request where possible or update Oompa before trying again.",
  },
  codex_remote_rejected: {
    code: "UNAVAILABLE",
    message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
  },
  codex_runtime_mismatch: {
    code: "UNAVAILABLE",
    message: "Oompa's pinned Codex runtime is missing or incompatible. Run `oompa doctor --json` and repair or reinstall Oompa before retrying.",
  },
  codex_timeout: {
    code: "UNAVAILABLE",
    message: "Codex did not complete the operation within Oompa's bounded deadline. Inspect current state before deciding whether to start a fresh attempt.",
  },
  codex_capability_unsupported: {
    code: "UNAVAILABLE",
    message: "The pinned Codex runtime does not support a capability required for this operation. Run `oompa doctor --json` and update or reconfigure Oompa before retrying.",
  },
  local_command_slots_exhausted: {
    code: "UNAVAILABLE",
    message: "The local daemon has no free command slot. The command was not started; wait briefly and run the same command again.",
  },
  local_long_poll_slots_exhausted: {
    code: "UNAVAILABLE",
    message: "The local daemon has no free long-poll slot. The poll was not started; wait briefly and poll again from the same cursor.",
  },
} as const satisfies Readonly<Record<string, Readonly<{
  code: PublicFailureCode;
  message: string;
}>>>;

const closedFailureMessage = (
  code: PublicFailureCode,
  details: unknown,
): string => {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return publicFailureMessages[code];
  }
  const reason = "reason" in details ? details.reason : undefined;
  if (typeof reason !== "string" || !Object.hasOwn(closedFailureReasonMessages, reason)) {
    return publicFailureMessages[code];
  }
  const closed = closedFailureReasonMessages[reason as keyof typeof closedFailureReasonMessages];
  return closed.code === code ? closed.message : publicFailureMessages[code];
};

type DeclaredCommandFailure = Error & Readonly<{
  [commandFailureBrand]: true;
  code: PublicFailureCode;
  details?: unknown;
}>;

const declaredCommandFailure = (error: unknown): error is DeclaredCommandFailure =>
  error instanceof Error
  && commandFailureBrand in error
  && error[commandFailureBrand] === true
  && "code" in error
  && publicFailureCodes.includes(error.code as PublicFailureCode);

const safeResponse = (requestId: string, error: unknown): CommandResponse => {
  const publicFailure = declaredCommandFailure(error);
  const code = publicFailure
    ? error.code
    : "INTERNAL";
  return {
    ok: false,
    version: 1,
    requestId,
    error: {
      code,
      message: publicFailure
        ? closedFailureMessage(code, error.details)
        : publicFailureMessages[code],
      ...(publicFailure
        && code !== "INTERNAL"
        && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
  };
};

const slotsExhaustedFailure = (slotClass: SlotClass): DeclaredCommandFailure => Object.assign(
  new Error("The local transport slot pool is exhausted."),
  {
    [commandFailureBrand]: true as const,
    code: "UNAVAILABLE" as const,
    details: {
      reason: slotClass === "command" ? "local_command_slots_exhausted" : "local_long_poll_slots_exhausted",
      requestState: "not_started",
    },
  },
);

type CommandEnvelope = ReturnType<typeof commandEnvelopeSchema.parse>;

type DecodedFrame =
  | Readonly<{ requestId: string; envelope: CommandEnvelope }>
  | Readonly<{ requestId: string; envelope: undefined; error: unknown }>;

const requestIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

// Decoding runs synchronously inside the data listener so the request buffer
// is unreachable once the handler owns the parsed command.
const decodeFrame = (frame: Buffer): DecodedFrame => {
  let requestId: string = randomUUID();
  try {
    const parsedJson = JSON.parse(frame.toString("utf8")) as unknown;
    if (
      typeof parsedJson === "object"
      && parsedJson !== null
      && "requestId" in parsedJson
      && typeof parsedJson.requestId === "string"
      && requestIdPattern.test(parsedJson.requestId)
    ) {
      requestId = parsedJson.requestId;
    }
    const envelope = commandEnvelopeSchema.parse(parsedJson);
    return { requestId: envelope.requestId, envelope };
  } catch (error: unknown) {
    return { requestId, envelope: undefined, error };
  }
};

export class LocalDaemonServer {
  readonly #paths: StatePaths;
  readonly #capability: string;
  readonly #server: Server;
  readonly #handler: Handler;
  readonly #deadlineMs: number;
  readonly #headerTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #sockets = new Set<Socket>();
  readonly #controllers = new Set<AbortController>();
  readonly #slots: Record<SlotClass, number> = { command: 0, longPoll: 0 };
  readonly #rejected: Record<SlotClass | "pending", number> = { command: 0, longPoll: 0, pending: 0 };
  #pending = 0;
  #accepting = true;
  #listenerClosed: Promise<void> | undefined;

  private constructor(
    paths: StatePaths,
    capability: string,
    handler: Handler,
    timeouts: Readonly<{ deadlineMs: number; headerTimeoutMs: number; idleTimeoutMs: number }>,
  ) {
    this.#paths = paths;
    this.#capability = capability;
    this.#handler = handler;
    this.#deadlineMs = timeouts.deadlineMs;
    this.#headerTimeoutMs = timeouts.headerTimeoutMs;
    this.#idleTimeoutMs = timeouts.idleTimeoutMs;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static async start(input: {
    paths: StatePaths;
    handler: Handler;
    deadlineMs?: number;
    headerTimeoutMs?: number;
    idleTimeoutMs?: number;
  }): Promise<LocalDaemonServer> {
    const timeouts = {
      deadlineMs: boundedTimeoutMs(input.deadlineMs, DEFAULT_LOCAL_REQUEST_DEADLINE_MS),
      headerTimeoutMs: boundedTimeoutMs(input.headerTimeoutMs, DEFAULT_LOCAL_REQUEST_HEADER_TIMEOUT_MS),
      idleTimeoutMs: boundedTimeoutMs(input.idleTimeoutMs, DEFAULT_LOCAL_CONNECTION_IDLE_TIMEOUT_MS),
    };
    await ensurePrivateDirectory(input.paths.runtime);
    await removeStaleEndpoint(input.paths);
    const capability = randomBytes(32).toString("base64url");
    await publishCapability(input.paths, capability);
    const owned = new LocalDaemonServer(input.paths, capability, input.handler, timeouts);
    try {
      await new Promise<void>((resolve, reject) => {
        owned.#server.once("error", reject);
        owned.#server.listen(input.paths.socket, () => {
          owned.#server.off("error", reject);
          resolve();
        });
      });
      await chmod(input.paths.socket, 0o600);
      await validateOwnedFile(input.paths.socket, "socket", 0o600);
      return owned;
    } catch (error: unknown) {
      await removeStaleEndpoint(input.paths).catch(() => undefined);
      throw error;
    }
  }

  stats(): LocalTransportStats {
    return {
      commandSlots: { inUse: this.#slots.command, capacity: LOCAL_TRANSPORT_COMMAND_SLOTS },
      longPollSlots: { inUse: this.#slots.longPoll, capacity: LOCAL_TRANSPORT_LONG_POLL_SLOTS },
      pendingConnections: { inUse: this.#pending, capacity: LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT },
      rejectedSinceStart: {
        command: this.#rejected.command,
        longPoll: this.#rejected.longPoll,
        pending: this.#rejected.pending,
      },
    };
  }

  #accept(socket: Socket): void {
    if (!this.#accepting) {
      socket.destroy();
      return;
    }
    if (this.#pending >= LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT) {
      // No request id exists yet, so no bound envelope can be written. The
      // client observes a pre-response close; every earlier pending connection
      // still settles within the header timeout.
      this.#rejected.pending = saturatingIncrement(this.#rejected.pending);
      socket.destroy();
      return;
    }
    this.#pending += 1;
    const connection: ConnectionState = { admission: "pending" };
    this.#sockets.add(socket);
    const controller = new AbortController();
    this.#controllers.add(controller);
    let received = Buffer.alloc(0);
    let handled = false;
    const deadline = setTimeout(() => {
      controller.abort(new Error("Local request deadline exceeded."));
      socket.destroy();
    }, this.#deadlineMs);
    deadline.unref();
    const headerTimer = setTimeout(() => {
      controller.abort(new Error("Local request header timeout exceeded."));
      socket.destroy();
    }, this.#headerTimeoutMs);
    headerTimer.unref();
    const settleSocket = () => {
      clearTimeout(deadline);
      clearTimeout(headerTimer);
      if (connection.idleTimer !== undefined) clearTimeout(connection.idleTimer);
      controller.abort(new Error("Local client disconnected."));
      this.#release(connection);
      this.#sockets.delete(socket);
      this.#controllers.delete(controller);
    };
    socket.once("close", settleSocket);
    socket.once("end", () => {
      controller.abort(new Error("Local client disconnected."));
      if (!socket.destroyed) socket.destroy();
    });
    socket.on("data", (chunk) => {
      if (!this.#accepting) {
        socket.destroy();
        return;
      }
      if (handled) {
        const trailing = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
          socket.destroy(new Error("Local connection must carry exactly one request."));
        }
        return;
      }
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.byteLength > maximumRequestBytes) {
        received = Buffer.alloc(0);
        socket.destroy(new Error("Local request exceeds the byte limit."));
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      clearTimeout(headerTimer);
      const trailing = received.subarray(newline + 1);
      if (trailing.some((byte) => byte !== 0x0a && byte !== 0x0d && byte !== 0x20 && byte !== 0x09)) {
        received = Buffer.alloc(0);
        socket.destroy(new Error("Local connection must carry exactly one request."));
        return;
      }
      const decoded = decodeFrame(received.subarray(0, newline));
      received = Buffer.alloc(0);
      const task = this.#handleFrame(socket, decoded, controller.signal, connection);
      this.#inFlight.add(task);
      void task.then(
        () => this.#inFlight.delete(task),
        () => this.#inFlight.delete(task),
      );
    });
  }

  #admit(connection: ConnectionState, command: LocalCommand): void {
    const slotClass: SlotClass = longPollCommand(command) ? "longPoll" : "command";
    if (this.#slots[slotClass] >= slotCapacity(slotClass)) {
      this.#rejected[slotClass] = saturatingIncrement(this.#rejected[slotClass]);
      throw slotsExhaustedFailure(slotClass);
    }
    this.#pending -= 1;
    this.#slots[slotClass] += 1;
    connection.admission = slotClass;
  }

  #release(connection: ConnectionState): void {
    if (connection.admission === "pending") this.#pending -= 1;
    else this.#slots[connection.admission] -= 1;
  }

  // Only the transport knows its own slot occupancy, so it appends that
  // snapshot to the `daemon.status` payload instead of routing it through the
  // service. The field is additive and free of paths, ids, and credentials.
  #withTransportStats(data: unknown): unknown {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
    return { ...data, transport: this.stats() };
  }

  async #handleFrame(socket: Socket, decoded: DecodedFrame, signal: AbortSignal, connection: ConnectionState): Promise<void> {
    const requestId = decoded.requestId;
    let response: CommandResponse;
    const afterResponse: Array<() => void> = [];
    let afterResponseFinished = false;
    const finishAfterResponse = (): void => {
      if (afterResponseFinished) return;
      afterResponseFinished = true;
      for (const callback of afterResponse) callback();
    };
    if (decoded.envelope === undefined) {
      response = safeResponse(requestId, decoded.error);
    } else {
      const envelope = decoded.envelope;
      try {
        const expected = Buffer.from(this.#capability);
        const provided = Buffer.from(envelope.capability);
        if (expected.byteLength !== provided.byteLength || !timingSafeEqual(expected, provided)) {
          throw new Error("Local capability was rejected.");
        }
        this.#admit(connection, envelope.command);
        const data = await this.#handler(envelope.command, { requestId, signal, afterResponse: (callback) => afterResponse.push(callback) });
        response = {
          ok: true,
          version: 1,
          requestId,
          data: envelope.command.kind === "daemon.status" ? this.#withTransportStats(data) : data,
        };
      } catch (error: unknown) {
        response = safeResponse(requestId, error);
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (bytes.byteLength > maximumResponseBytes) {
      response = safeResponse(requestId, new Error("Local response exceeds the byte limit."));
    }
    if (socket.destroyed) {
      // The response can no longer be delivered, so no response boundary remains
      // to defer. Security and shutdown callbacks must still run exactly once.
      finishAfterResponse();
      return;
    }
    socket.once("close", finishAfterResponse);
    socket.end(`${JSON.stringify(response)}\n`, () => {
      socket.off("close", finishAfterResponse);
      finishAfterResponse();
    });
    // The response is queued. A client that stops reading would otherwise hold
    // the slot and the response buffer until the request deadline.
    if (!this.#sockets.has(socket)) return;
    connection.idleTimer = setTimeout(() => {
      socket.destroy();
    }, this.#idleTimeoutMs);
    connection.idleTimer.unref();
  }

  beginShutdown(reason: Error = new Error("Local daemon transport is closing.")): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#listenerClosed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    for (const controller of this.#controllers) controller.abort(reason);
    for (const socket of this.#sockets) socket.destroy();
  }

  async close(input: { deadlineMs?: number } = {}): Promise<void> {
    this.beginShutdown();
    const deadlineMs = input.deadlineMs ?? 5_000;
    const listenerClosed = this.#listenerClosed ?? Promise.resolve();
    const settled = Promise.all([listenerClosed, Promise.allSettled([...this.#inFlight])]).then(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settleError: Error | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new LocalDaemonShutdownTimeoutError(deadlineMs)), deadlineMs);
        }),
      ]);
    } catch (error: unknown) {
      settleError = error instanceof Error ? error : new Error("Local daemon transport settled with a non-Error failure.");
    }
    if (deadline !== undefined) clearTimeout(deadline);
    let endpointError: Error | undefined;
    try { await removeStaleEndpoint(this.#paths); } catch (error: unknown) {
      endpointError = error instanceof Error ? error : new Error("Local daemon endpoint cleanup failed with a non-Error value.");
    }
    if (settleError !== undefined) throw settleError;
    if (endpointError !== undefined) throw endpointError;
  }
}

export class LocalDaemonShutdownTimeoutError extends Error {
  readonly code = "LOCAL_DAEMON_SHUTDOWN_TIMEOUT" as const;

  constructor(deadlineMs: number) {
    super(`The local daemon transport did not settle within ${deadlineMs}ms.`);
    this.name = "LocalDaemonShutdownTimeoutError";
  }
}

async function readCapability(path: string): Promise<string> {
  await validateOwnedFile(path, "file", 0o600);
  const bytes = (await readOwnedFileStable(path, 128)).bytes;
  const value = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Local capability file is malformed.");
  return value;
}

const throwIfClientAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException("The local daemon request was aborted.", "AbortError");
  }
};

export async function callLocalDaemon(input: {
  paths: StatePaths;
  command: LocalCommand;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<CommandResponse> {
  throwIfClientAborted(input.signal);
  let capability: string;
  try {
    capability = await readCapability(input.paths.capability);
    await validateOwnedFile(input.paths.socket, "socket", 0o600);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalDaemonUnavailableError("The local daemon endpoint is absent.", error);
    throw error;
  }
  throwIfClientAborted(input.signal);
  const requestId = randomUUID();
  const presetContract = localCommandPresetContract(input.command);
  const request = `${JSON.stringify({
    version: LOCAL_COMMAND_REQUEST_VERSION,
    capability,
    requestId,
    ...(presetContract === undefined ? {} : { presetContract }),
    command: input.command,
  })}\n`;
  return await new Promise<CommandResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let connected = false;
    let received = Buffer.alloc(0);
    const socket = createConnection(input.paths.socket);
    const destroyImmediately = (): void => {
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const deadline = setTimeout(() => {
      settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The Oompa daemon did not respond before the deadline.")
        : new LocalDaemonUnavailableError("The Oompa daemon was unavailable before the request deadline.")));
      destroyImmediately();
    }, input.deadlineMs ?? DEFAULT_LOCAL_REQUEST_DEADLINE_MS);
    deadline.unref();
    const onAbort = () => {
      settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The local daemon request was aborted after dispatch became possible.", input.signal?.reason)
        : input.signal?.reason ?? new DOMException("The local daemon request was aborted.", "AbortError")));
      destroyImmediately();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    socket.once("connect", () => {
      if (settled) {
        socket.destroy();
        return;
      }
      connected = true;
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (received.byteLength > maximumResponseBytes) {
        settle(() => rejectPromise(new LocalDaemonIndeterminateError("The Oompa daemon returned an oversized response.")));
        socket.destroy();
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = commandResponseSchema.parse(JSON.parse(received.subarray(0, newline).toString("utf8")) as unknown);
        if (response.requestId !== requestId) {
          throw new Error("LOCAL_DAEMON_RESPONSE_REQUEST_ID_MISMATCH");
        }
        settle(() => resolvePromise(response));
      } catch (error: unknown) {
        settle(() => rejectPromise(new LocalDaemonIndeterminateError("The Oompa daemon returned an invalid response.", error)));
      } finally {
        socket.end();
      }
    });
    socket.once("error", (error) => settle(() => {
      if (!connected && ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        rejectPromise(new LocalDaemonUnavailableError("The local daemon was unavailable before request dispatch.", error));
        return;
      }
      rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The local daemon connection failed after request dispatch became possible.", error)
        : error);
    }));
    socket.once("close", () => {
      if (!settled) settle(() => rejectPromise(connected
        ? new LocalDaemonIndeterminateError("The Oompa daemon closed the connection without a response.")
        : new LocalDaemonUnavailableError("The local daemon connection closed before request dispatch.")));
    });
  });
}

export class LocalDaemonUnavailableError extends Error {
  readonly code = "LOCAL_DAEMON_UNAVAILABLE" as const;
  readonly phase = "pre_connect" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalDaemonUnavailableError";
  }
}

export class LocalDaemonIndeterminateError extends Error {
  readonly code = "LOCAL_DAEMON_INDETERMINATE" as const;
  readonly phase = "after_connect" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalDaemonIndeterminateError";
  }
}

export function isLocalDaemonUnavailable(error: unknown): error is LocalDaemonUnavailableError {
  return error instanceof LocalDaemonUnavailableError;
}

export async function callWithSafeAutostart<T>(attempt: () => Promise<T>, start: () => Promise<void>): Promise<T> {
  try {
    return await attempt();
  } catch (error: unknown) {
    if (!isLocalDaemonUnavailable(error)) throw error;
    await start();
    return await attempt();
  }
}
