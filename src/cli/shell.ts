import { terminalSafe } from "./render";

export const SHELL_LINE_MAX_BYTES = 64 * 1024;
export const SHELL_TOKEN_MAX_COUNT = 128;

export type ShellSelection = Readonly<{
  account?: string;
  session?: string;
}>;

export type ShellIntent =
  | Readonly<{ kind: "noop" }>
  | Readonly<{ kind: "exit" }>
  | Readonly<{ kind: "help" }>
  | Readonly<{ argv: readonly string[]; kind: "dispatch" }>
  | Readonly<{ kind: "select-account"; selector: string }>
  | Readonly<{ kind: "select-session"; selector: string }>;

export class ShellUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellUsageError";
  }
}

const accountActions = new Set([
  "add",
  "list",
  "show",
  "logout",
  "usage",
  "usage-history",
]);

const sessionActions = new Set([
  "list",
  "show",
  "status",
  "watch",
  "start",
  "send",
  "queue",
  "steer",
  "stop",
  "events",
  "interactions",
  "rename",
  "recover",
  "abandon",
  "note",
  "preset",
  "fast",
  "project",
  "task",
]);

const pluginActions = new Set(["list", "show"]);
const sessionTaskActions = new Set(["list", "show", "create", "edit", "delete"]);

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export const tokenizeShellCommand = (source: string): readonly string[] => {
  if (encodedBytes(source) > SHELL_LINE_MAX_BYTES) {
    throw new ShellUsageError(`Shell input exceeds ${String(SHELL_LINE_MAX_BYTES)} UTF-8 bytes.`);
  }
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;
  let escaped = false;
  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    if (tokens.length > SHELL_TOKEN_MAX_COUNT) {
      throw new ShellUsageError(`Shell commands accept at most ${String(SHELL_TOKEN_MAX_COUNT)} arguments.`);
    }
    token = "";
    tokenStarted = false;
  };

  for (const scalar of source) {
    if (escaped) {
      token += scalar;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (scalar === "'") quote = null;
      else token += scalar;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (scalar === "\"") {
        quote = null;
      } else if (scalar === "\\") {
        escaped = true;
      } else {
        token += scalar;
      }
      tokenStarted = true;
      continue;
    }
    if (scalar === "\\") {
      escaped = true;
      tokenStarted = true;
    } else if (scalar === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (scalar === "\"") {
      quote = "double";
      tokenStarted = true;
    } else if (/\s/u.test(scalar)) {
      finishToken();
    } else {
      token += scalar;
      tokenStarted = true;
    }
  }
  if (escaped) throw new ShellUsageError("Shell command ends with an incomplete escape.");
  if (quote !== null) throw new ShellUsageError("Shell command has an unterminated quote.");
  finishToken();
  return tokens;
};

const selectedSession = (selection: ShellSelection): string => {
  if (selection.session === undefined) {
    throw new ShellUsageError("Select a session with /session <selector> before sending or following it.");
  }
  return selection.session;
};

const slashRemainder = (line: string, command: string): string | null => {
  if (line === command) return "";
  if (!line.startsWith(`${command} `) && !line.startsWith(`${command}\t`)) return null;
  return line.slice(command.length).trimStart();
};

export const compileShellLine = (line: string, selection: ShellSelection = {}): ShellIntent => {
  if (encodedBytes(line) > SHELL_LINE_MAX_BYTES) {
    throw new ShellUsageError(`Shell input exceeds ${String(SHELL_LINE_MAX_BYTES)} UTF-8 bytes.`);
  }
  if (line.trim().length === 0) return { kind: "noop" };
  if (!line.startsWith("/")) {
    return {
      argv: ["session", "send", selectedSession(selection), "--", line],
      kind: "dispatch",
    };
  }
  if (line.startsWith("//")) {
    return {
      argv: ["session", "send", selectedSession(selection), "--", line.slice(1)],
      kind: "dispatch",
    };
  }

  const send = slashRemainder(line, "/send");
  if (send !== null) {
    if (send.length === 0) throw new ShellUsageError("/send requires a message.");
    return {
      argv: ["session", "send", selectedSession(selection), "--", send],
      kind: "dispatch",
    };
  }
  const tokens = tokenizeShellCommand(line.slice(1));
  const name = tokens[0];
  const rest = tokens.slice(1);
  if (name === undefined) return { kind: "noop" };
  if (name === "exit" || name === "quit") {
    if (rest.length !== 0) throw new ShellUsageError(`/${name} does not accept arguments.`);
    return { kind: "exit" };
  }
  if (name === "help" || name === "?") {
    if (rest.length !== 0) throw new ShellUsageError(`/${name} does not accept arguments.`);
    return { kind: "help" };
  }
  if (name === "account") {
    if (rest.length === 0) return { argv: ["account", "list"], kind: "dispatch" };
    const first = rest[0];
    if (first === "login") {
      throw new ShellUsageError(
        "Account login is a dedicated one-shot command. Exit the shell, then run `oompa account login <profile> [--device-code]`.",
      );
    }
    if (first !== undefined && accountActions.has(first)) {
      return { argv: ["account", ...rest], kind: "dispatch" };
    }
    if (rest.length !== 1 || first === undefined) {
      throw new ShellUsageError("Use /account <selector> or /account <action>.");
    }
    return { kind: "select-account", selector: first };
  }
  if (name === "session") {
    if (rest.length === 0) {
      return {
        argv: ["session", "list", ...(selection.account === undefined ? [] : ["--account", selection.account])],
        kind: "dispatch",
      };
    }
    const first = rest[0];
    if (first !== undefined && sessionActions.has(first)) {
      return { argv: ["session", ...rest], kind: "dispatch" };
    }
    if (rest.length !== 1 || first === undefined) {
      throw new ShellUsageError("Use /session <selector> or /session <action>.");
    }
    return { kind: "select-session", selector: first };
  }
  if (name === "plugin") {
    if (selection.account === undefined) {
      throw new ShellUsageError("Select an account with /account <selector> before inspecting plugins.");
    }
    if (rest.length === 0) {
      return { argv: ["plugin", "list", selection.account], kind: "dispatch" };
    }
    const action = rest[0];
    if (action === undefined || !pluginActions.has(action)) {
      throw new ShellUsageError("Use /plugin list or /plugin show <plugin>.");
    }
    return {
      argv: ["plugin", action, selection.account, ...rest.slice(1)],
      kind: "dispatch",
    };
  }
  if (name === "events") {
    return { argv: ["session", "events", selectedSession(selection), ...rest], kind: "dispatch" };
  }
  if (name === "watch") {
    return {
      argv: ["session", "watch", selectedSession(selection), ...rest],
      kind: "dispatch",
    };
  }
  if (name === "interactions") {
    return {
      argv: ["session", "interactions", selectedSession(selection), ...(rest.includes("--pending") ? [] : ["--pending"]), ...rest],
      kind: "dispatch",
    };
  }
  if (name === "task") {
    const action = rest[0];
    if (
      action === undefined
      || !sessionTaskActions.has(action)
    ) {
      throw new ShellUsageError("Use /task list|show|create|edit|delete for the selected session.");
    }
    return {
      argv: ["session", "task", action, selectedSession(selection), ...rest.slice(1)],
      kind: "dispatch",
    };
  }
  if (name === "interrupt") {
    if (rest.length !== 0) throw new ShellUsageError("/interrupt does not accept arguments.");
    return { argv: ["session", "stop", selectedSession(selection)], kind: "dispatch" };
  }
  if (name === "approve") {
    return {
      argv: ["interaction", "decide", ...rest, ...(rest.includes("--decision") ? [] : ["--decision", "once"])],
      kind: "dispatch",
    };
  }
  if (name === "inspect") {
    return { argv: ["interaction", "inspect", ...rest], kind: "dispatch" };
  }
  if (name === "decline") {
    return { argv: ["interaction", "decide", ...rest, "--decision", "decline"], kind: "dispatch" };
  }
  if (name === "answer") {
    return { argv: ["interaction", "answer", ...rest, "--input-stdin"], kind: "dispatch" };
  }
  if (name === "grant") {
    return { argv: ["interaction", "grant", ...rest, "--input-stdin"], kind: "dispatch" };
  }
  if (name === "submit") {
    const actionIndex = rest.indexOf("--action");
    const acceptsContent = actionIndex >= 0 && rest[actionIndex + 1] === "accept";
    return {
      argv: ["interaction", "submit", ...rest, ...(acceptsContent ? ["--input-stdin"] : [])],
      kind: "dispatch",
    };
  }
  if (name === "auth" && rest[0] === "login") {
    return {
      argv: ["auth", "login", ...rest.slice(1), "--input-stdin"],
      kind: "dispatch",
    };
  }
  if (name === "init") {
    throw new ShellUsageError("Initialization is a one-shot maintenance command. Exit the shell, then run `oompa init --yes`.");
  }
  return { argv: [name, ...rest], kind: "dispatch" };
};

const promptLabel = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const safe = terminalSafe(value).replaceAll(/\s+/gu, " ").trim();
  const bounded = safe.length <= 32 ? safe : `${safe.slice(0, 29)}...`;
  return bounded.replaceAll("[", "\\[").replaceAll("]", "\\]");
};

export const formatShellPrompt = (selection: ShellSelection = {}): string => {
  const account = promptLabel(selection.account);
  const session = promptLabel(selection.session);
  const context = [account, session].filter((value): value is string => value !== null).join("/");
  return context.length === 0 ? "oompa> " : `oompa[${context}]> `;
};

export const shellHelp = `Shell commands

  /account [selector]       List or select an account
  /account usage-history ACCOUNT [--limit N]
                            Page the retained source-ordered usage ledger
  /session [selector]       List or select a session
  /plugin                   List plugins for the selected account
  /plugin show PLUGIN       Inspect one exact or unambiguous plugin
  /events                   Read the selected session's next event page
  /watch [--jsonl]          Watch the selected session; JSONL is opt-in
  /interactions             List pending interactions for the selected session
  /task list                List conversation-bound tasks for the selected session
  /task show ID             Show one exact conversation-bound task
  /task create|edit|delete  Manage tasks without creating another conversation
  /interaction show ID      Show one interaction's questions, choices, or form fields
  /inspect ID --revision N  Show exact live approval authority in the protected terminal
  /approve ID --revision N  Approve once unless --decision is supplied
  /decline ID --revision N  Decline an interaction
  /answer ID --revision N   Read protected answers without terminal echo
  /grant ID --revision N    Read a protected permission grant
  /submit ID --revision N   Resolve an MCP elicitation
  /auth login               Read protected cloud credentials without terminal echo
  /auth delete --acknowledge-erasure
                            Permanently erase the hosted Oompa identity
  /interrupt                Interrupt the selected session
  /send MESSAGE             Send MESSAGE; // sends a leading slash
  /help                     Show this help
  /exit                     Leave the shell; the daemon keeps running

Selecting a session starts concise safe live updates in the background.`;
