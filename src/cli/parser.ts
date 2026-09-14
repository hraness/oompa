import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { CODEX_PIN } from "../codex/pin";
import { ATTACHMENT_MAX_COUNT } from "../domain/attachments";
import type { LocalCommand } from "../domain/contracts";
import { localCommandSchema } from "../domain/contracts";
import { canonicalizeNotificationTimeZone } from "../domain/notification-hours";
import {
  adoptableProviderSchema,
  DEFAULT_PROVIDER,
  defaultPresetForProvider,
  isReboundCodexPreset,
  providerSwitchRequiresPresetContract,
  sharedActiveCodexPresetContract,
  type AdoptableProvider,
  supportedPresetSchema,
  supportedProviderSchema,
  type PresetContract,
  type SupportedPreset,
  type SupportedProvider,
} from "../domain/presets";
import { ACCOUNT_USAGE_HISTORY_PAGE_LIMIT } from "../domain/usage-metrics";
import { usageProviderSchema } from "../domain/provider-usage";
import { createCloudUuidV7, isUuidV7 } from "../domain/uuid-v7";
import { parseAuthCredentials } from "../cloud/authCredentials";
import {
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
} from "../domain/work";
import { workProtocolQuerySchema } from "../domain/work-protocol";
import {
  SESSION_TASK_MAX_INTERVAL_MINUTES,
  SESSION_TASK_MIN_INTERVAL_MINUTES,
} from "../domain/session-tasks";

type InteractionRequiredInvocation = Readonly<{
  error: Readonly<{
    code: "INTERACTION_REQUIRED";
    details: Readonly<{
      acknowledgementRequired: "--acknowledge-gap";
      idempotencyKey: string;
      nextCommand: string;
    }>;
    message: string;
  }>;
  json: boolean;
  kind: "interaction-required";
}>;

export type ProjectionRecoveryCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "sync.projection-recover" }>;
  json: boolean;
  kind: "sync.projection-recover";
  replayCommand: string;
}>;

export type ProtectedInputSource =
  | Readonly<{ kind: "stdin" }>
  | Readonly<{ fd: number; kind: "fd" }>;

export type ProtectedInteractionCliInvocation = Readonly<{
  expectedRevision: number;
  input: ProtectedInputSource;
  interaction: string;
  json: boolean;
  kind: "interaction.resolve-protected";
  resolution:
    | Readonly<{ kind: "permission_grant"; scope: "turn" | "session" | null }>
    | Readonly<{ kind: "user_answers" }>
    | Readonly<{ action: "accept"; kind: "mcp_submission" }>;
}>;

export type ProtectedInteractionInspectCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "interaction.inspect" }>;
  handoffFile?: string;
  json: boolean;
  kind: "interaction.inspect-protected";
}>;

export type ProtectedAuthLoginCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: boolean;
  kind: "auth.login-protected";
}>;

/**
 * `oompa session send|queue|steer --attach <path>`. The parser hands back the
 * exact command plus the paths it was given; the composition entry reads,
 * sniffs, bounds, and stores each file, then reissues the command with the
 * resulting digest references.
 */
export type SessionAttachmentCliInvocation = Readonly<{
  attach: readonly string[];
  command: Extract<LocalCommand, {
    kind: "session.send" | "session.queue" | "session.steer";
  }>;
  json: boolean;
  kind: "session.attach";
  legacyAttachmentReplay: boolean;
}>;

export type SessionEventFollowCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "session.events" }>;
  jsonl: true;
  kind: "session.events.follow";
}>;

export type SessionEventWatchCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "session.events" }>;
  jsonl: boolean;
  kind: "session.events.watch";
}>;

/**
 * `oompa session export` reads the provider-neutral transcript's latest bounded
 * retained tail in one local command and writes one document. Older retained
 * records omitted by that tail remain represented by its exact omission count.
 */
export type SessionExportCliInvocation = Readonly<{
  format: "trajectory" | "json";
  json: boolean;
  kind: "session.export";
  out?: string;
  session: string;
}>;

export type WorkApplyCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: true;
  kind: "work.apply-input";
}>;

export type WorkEventFollowCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "work.events" }>;
  jsonl: true;
  kind: "work.events.follow";
}>;

export type AccountLoginCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "account.login" }> & Readonly<{
    idempotencyKey: string;
  }>;
  handoffFile?: string;
  json: boolean;
  kind: "account.login-handoff";
  replayCommand: string;
}>;

/** Claude owns the foreground interaction; the daemon owns its durable attempt. */
export type ClaudeAccountAuthCliInvocation = Readonly<{
  browserMode: "provider_default" | "owner_manual";
  command: Extract<LocalCommand, { kind: "account.claude-login.prepare" }>;
  json: boolean;
  kind: "account.claude-login";
  replayCommand: string;
}>;

export type InteractionResolveCommand = Extract<LocalCommand, { kind: "interaction.resolve" }>;

export type CliInvocation =
  | { group?: string; json: boolean; kind: "help"; leaf?: string }
  | { json: boolean; kind: "version" }
  | { kind: "status"; json: boolean }
  | { kind: "init"; yes: boolean; json: boolean }
  | { kind: "daemon.start"; json: boolean }
  | { kind: "daemon.run" }
  | { kind: "menubar"; json: boolean }
  | { kind: "remote"; command: RemoteCliCommand; idempotencyKey?: string; json: boolean }
  | ProtectedAuthLoginCliInvocation
  | ProtectedInteractionCliInvocation
  | ProtectedInteractionInspectCliInvocation
  | AccountLoginCliInvocation
  | ClaudeAccountAuthCliInvocation
  | SessionAttachmentCliInvocation
  | SessionEventFollowCliInvocation
  | SessionEventWatchCliInvocation
  | SessionExportCliInvocation
  | WorkApplyCliInvocation
  | WorkEventFollowCliInvocation
  | InteractionRequiredInvocation
  | ProjectionRecoveryCliInvocation
  | GatewayKeySetCliInvocation
  | { kind: "command"; command: LocalCommand; json: boolean };

/*
 * `oompa autorespond gateway set` never accepts the key as an argument. The
 * parser only names the descriptor to read; the value is read once, sent to
 * the daemon, and never rendered.
 */
export type GatewayKeySetCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: boolean;
  kind: "autorespond.gateway-set";
}>;

export type RemoteCliCommand =
  | Readonly<{ kind: "remote.list"; limit: number }>
  | Readonly<{ kind: "remote.show"; session: string }>
  | Readonly<{ commandPublicId: string; kind: "remote.command" }>
  | Readonly<{ kind: "remote.send" | "remote.queue" | "remote.steer"; message: string; orSteer?: boolean; session: string }>
  | Readonly<{
      decision: "once" | "decline";
      interaction: string;
      kind: "remote.resolve";
      revision: number;
      session: string;
    }>
  | Readonly<{ kind: "remote.stop"; session: string }>
  | Readonly<{ kind: "remote.preset"; preset: SupportedPreset; session: string }>
  | Readonly<{
      kind: "remote.provider";
      preset?: SupportedPreset;
      provider: SupportedProvider;
      session: string;
    }>
  | Readonly<{ enabled: boolean; kind: "remote.fast"; session: string }>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const usage = `Oompa

Usage:
  oompa
  oompa help [<group> [<command>]]
  oompa status [--json]
  oompa init [--yes] [--json]
  oompa doctor [--offline] [--json]
  oompa daemon start|status|stop|run
  oompa menubar [--json]
  oompa account add|list|show|login|login-cancel|logout|usage|usage-history|switch|switch-recover
  oompa account list --provider codex|claude
  oompa usage auto status|on|off|inherit
  oompa plugin list <account> [--project <project>] [--refresh]
  oompa plugin show <account> <plugin> [--project <project>] [--refresh]
  oompa project add|list|use
  oompa memory status|list|get|search|explain|remember|share|hosted
  oompa session list|show|status|watch|start|send|queue|steer|stop|peer-policy
  oompa session adoption status [--provider codex|claude]
  oompa session adoption enable <account> --provider codex|claude
  oompa session adoption disable --provider codex|claude
  oompa session discover [--provider codex|claude]
  oompa session task list|show|create|edit|delete
  oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  oompa session watch <session> [--cursor <cursor>] [--jsonl]
  oompa session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]
  oompa session rename|recover|abandon|archive|unarchive|note|preset|fast|project
  oompa notification-hours status|set
  oompa notification-email status|enable|disable
  oompa autorespond-after-hours status|enable|disable
  oompa work protocol|apply|snapshot|task|poll|events|watch
  oompa interaction list|show|inspect|decide|grant|answer|submit
  oompa remote list|show|command|send|queue|steer|stop|resolve|preset|fast|allow|deny|policy
  oompa turn inspect
  oompa auth login --input-stdin|--input-fd <fd>
  oompa auth status|logout
  oompa auth delete --acknowledge-erasure
  oompa device list|pair|approve|revoke|key-loss
  oompa sync status|now
  oompa sync projection recover <local-session> --acknowledge-gap

Output:
  --json                    Emit one versioned JSON result for supported commands.
  --jsonl                   Watch session events as versioned JSON Lines.
  --follow                  Follow session or work events as JSON Lines.

Interactive:
  Run bare \`oompa\` in a TTY to start the persistent agent-and-human shell.

Mutation safety:
  --idempotency-key <uuid>  Reuse after a lost response; changed reuse fails closed.
  --preset-contract <1|2>   Replay a source-sensitive Codex session start or provider switch.

Platform:
  Codex provider commands run on macOS and Linux. Claude login, status,
  sessions, and provider switches require Linux; macOS refuses before launching Claude.

Recommended profiles:
  low         Luna Max        (codex)
  high        Astra Max       (codex)
  ultra       Astra Ultra     (codex)
  fable-max   Claude Fable    (claude)

Run \`oompa <group> --help\` or \`oompa help <group> [<command>]\` for command examples.`;

const groupUsage = {
  usage: `Oompa usage

Usage:
  oompa usage auto status [codex|claude] [--json]
  oompa usage auto on|off [codex|claude] --revision <n> --idempotency-key <uuid> [--json]
  oompa usage auto inherit <codex|claude> --revision <n> --idempotency-key <uuid> [--json]

Notes:
  Without a provider, on/off changes the inherited default, not a global kill switch.
  A provider override of on can remain enabled when the inherited default is off.
  inherit requires a provider and removes that provider's override.
  Mutations require both --revision from status and a caller-owned --idempotency-key.
  Reuse the same key and revision after a lost response. A replay returns the saved
  receipt, not the current policy head; run status to read the current configuration.
  status accepts no mutation flags. Only Codex and Claude have usage-auto policy.

Examples:
  oompa usage auto status --json
  oompa usage auto off --revision 1 --idempotency-key 11111111-1111-4111-8111-111111111111
  oompa usage auto on codex --revision 2 --idempotency-key 22222222-2222-4222-8222-222222222222
  oompa usage auto inherit claude --revision 3 --idempotency-key 33333333-3333-4333-8333-333333333333`,
  status: `Oompa status

Usage:
  oompa status [--json]

Examples:
  oompa status
  oompa status --json`,
  init: `Oompa init

Usage:
  oompa init [--yes] [--json]

Examples:
  oompa init
  oompa init --yes --json`,
  doctor: `Oompa doctor

Usage:
  oompa doctor [--offline] [--json]

Examples:
  oompa doctor --offline
  oompa doctor --json`,
  daemon: `Oompa daemon

Usage:
  oompa daemon start [--json]
  oompa daemon status|stop [--json]
  oompa daemon run

Examples:
  oompa daemon start
  oompa daemon status --json`,
  menubar: `Oompa menu bar

Usage:
  oompa menubar [--json]

Launches the detached menu-bar companion, which shows daemon status and live
sessions in the macOS status item. Build it once with
\`cargo build --release --manifest-path desktop/Cargo.toml\`.

Examples:
  oompa menubar`,
  account: `Oompa account

Usage:
  oompa account add <label>
  oompa account login <profile> [--provider <codex|claude>] [--device-code] [--manual-browser] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]
  oompa account login-cancel <profile> [--provider codex]
  oompa account login-cancel <profile> --provider claude --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited
  oompa account login-cancel <profile> --provider devin --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited
    Retired-provider cleanup only; does not launch, stop, or authenticate Devin.
  oompa account logout <profile>
  oompa account list [--provider <codex|claude>] [--json]
  oompa account show <profile> [--provider <codex|claude>]
  oompa account show <profile> --provider devin  (retired local history and cleanup only)
  oompa account usage [profile] [--refresh]
  oompa account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1..100>] [--cursor <cursor>]

Provider listing:
  --provider lists cached readiness, ordering, and the active pointer for Codex
  or Claude. Readiness is last observed state, not current usage or quota.
  This read does not refresh providers, sign in, or change the active account.
  Without --provider, account list keeps the existing profile listing.

Claude browser selection:
  --manual-browser leaves Claude's link in the terminal for you to copy unchanged
  into a fresh private browser session. Close all prior private windows first,
  keep normal sessions unchanged, and choose the intended account. Claude only.

Platform:
  Codex account commands run on macOS and Linux. Claude login and status
  require Linux; macOS refuses before launching Claude.

Examples:
  oompa account add personal
  oompa account login personal --device-code --handoff-file /private/path/login.json
  oompa account login personal --provider claude --manual-browser
  oompa account list --provider codex
  oompa account list --provider claude --json
  oompa account show personal --provider claude
  oompa account login-cancel personal
  oompa account usage personal --refresh
  oompa account usage-history personal --from 2026-08-23T12:00:00Z --json`,
  plugin: `Oompa plugin

Usage:
  oompa plugin list <account> [--project <project>] [--refresh]
  oompa plugin show <account> <plugin> [--project <project>] [--refresh]

Plugin commands are discovery-only. Installation, enablement, and OAuth stay in Codex.

Examples:
  oompa plugin list personal --refresh
  oompa plugin show personal github --project jungle`,
  project: `Oompa project

Usage:
  oompa project add --path <directory> [--name <name>]
  oompa project list
  oompa project use <project>

Examples:
  oompa project add --path . --name jungle
  oompa project use jungle`,
  "notification-hours": `Oompa notification hours

Usage:
  oompa notification-hours status [--json]
  oompa notification-hours set --start <HH:MM> --end <HH:MM> --timezone <IANA-zone> --revision <n> [--json]

Examples:
  oompa notification-hours status
  oompa notification-hours set --start 10:00 --end 22:00 --timezone America/Puerto_Rico --revision 1`,
  "notification-email": `Oompa attention email notifications

Usage:
  oompa notification-email status [--json]
  oompa notification-email enable|disable --revision <n> [--json]

The setting is local to this machine. Status and enable report only bounded
hosted observations. Disable commits locally first, then reports whether hosted
invalidation was acknowledged, remains pending under a returned receipt, or was
not observed; it never claims recall of a delivery that already started.

Examples:
  oompa notification-email status
  oompa notification-email enable --revision 1
  oompa notification-email disable --revision 2`,
  memory: `Oompa memory

Memory is selected by an Oompa session. Reads combine that session's working
lane with its current project's shared canonical lane by default. Add
--working-only to read the session lane without opening canonical custody.
Writes never accept a store path, authority, head, rule, or purge capability.

Usage:
  oompa memory status <session> [--json]
  oompa memory list <session> [--working-only] [--continuation <token>] [--json]
  oompa memory get <session> <key> [--working-only] [--continuation <token>] [--json]
  oompa memory search <session> [--working-only] [--continuation <token>] <text> [--json]
  oompa memory explain <session> <query-id> <row> [--json]
  oompa memory remember <session> <key> --title <title> --summary <summary> [--language <tag>] [--idempotency-key <uuid>] [--json] -- <body>
  oompa memory share <session> <key> --reason <reason> [--idempotency-key <uuid>] [--json]
  oompa memory hosted list [--json]
  oompa memory hosted create <project> [--idempotency-key <uuid>] [--json]
  oompa memory hosted attach <project> <hosted-space-id> [--json]
  oompa memory hosted detach <project> --generation <n> [--json]
  oompa memory hosted sync <project> [--json]

The remember command changes only the selected session's expiring working lane.
The share command explicitly nominates its exact attested working page for
conflict-checked adoption into the current project's canonical lane. Reuse the
printed idempotency key after a lost mutation response.

Examples:
  oompa memory status my-session
  oompa memory list my-session --json
  oompa memory get my-session architecture.boundary
  oompa memory search my-session -- "authority boundary"
  oompa memory explain my-session memq_0123456789abcdef0123456789abcdef 0
  oompa memory remember my-session preferences.review --title "Review style" --summary "Prefer adversarial review." -- "Challenge implementation plans before execution."
  oompa memory share my-session preferences.review --reason "Reusable project convention"
  oompa memory hosted create jungle
  oompa memory hosted list`,
  "autorespond-after-hours": `Oompa after-hours automatic approval budgets

Usage:
  oompa autorespond-after-hours status [--json]
  oompa autorespond-after-hours enable|disable --revision <n> [--json]

This machine-local setting is separate consent from notification email and
notification hours. When enabled, eligible protocol approvals outside notification
hours may use limits of 6 consecutive, 20 per hour, and 80 per day with proven
history. Otherwise the limits are 3 consecutive, 10 per hour, and 40 per day.
Prose always keeps 3/10/40. Existing approval categories and session approval
modes still apply. Policy changes never reset counters or refund reservations.

Examples:
  oompa autorespond-after-hours status
  Only if you choose to consent, use the revision returned by status:
  oompa autorespond-after-hours enable --revision <current-revision>
  To withdraw consent, use the revision returned by status:
  oompa autorespond-after-hours disable --revision <current-revision>`,
  session: `Oompa session
Session tasks always return to the selected conversation. They never create a standalone task or a new conversation.

Usage:
  oompa session list [--account <profile>] [--archived] [--limit <1..100>] [--cursor <cursor>]
  oompa session show <session> [--detail]
  oompa session status <session> [--json]
  oompa session state <session> [--json]
  oompa session peer-policy get <session> [--json]
  oompa session peer-policy set <session> <off|inspect|coordinate> --revision <n> [--json]
  oompa autorespond on|workspace|off|default|status [--session <session>] [--json]
  oompa autorespond gateway set [--from-fd <fd>] [--json]
  oompa autorespond gateway clear [--json]
  oompa session watch <session> [--cursor <cursor>] [--jsonl]
  oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  oompa session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]
  oompa session start <account> [--project <project>] [--provider <codex|claude>] [--preset <low|high|ultra|fable-max>] [--fast] [--idempotency-key <uuid> [--preset-contract <1|2>]]
  oompa session send|queue|steer <session> [--attach <path>]... <message>
  oompa session stop|recover|abandon <session>
  oompa session archive|unarchive <session>
  oompa session adoption status [--provider <codex|claude>]
  oompa session adoption enable <account> --provider <codex|claude>
  oompa session adoption disable --provider <codex|claude>
  oompa session discover [--provider <codex|claude>]
  oompa session rename <session> <name>
  oompa session note get|edit|clear <session>
  oompa session note set <session> <note>
  oompa session preset <session> <low|high|ultra|fable-max>
  oompa session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>] [--idempotency-key <uuid> [--preset-contract <1|2>]]
  oompa session export <session> [--format <trajectory|json>] [--out <path>]
  oompa session fast <session> <on|off>
  oompa session project <session> <project>
  oompa session task list <session>
  oompa session task show <session> <task-id>
  oompa session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>
  oompa session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]
  oompa session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]

Examples:
  oompa session start personal --project jungle
  oompa session start personal --provider claude --preset fable-max
  oompa session adoption enable personal --provider codex
  oompa session discover --provider codex
  oompa session switch my-session --provider claude
  oompa session export my-session --format trajectory --out ./trajectory.json
  oompa session watch my-session
  oompa session watch my-session --jsonl
  oompa session events my-session --wait-ms 30000 --jsonl
  oompa session send my-session -- "run --help exactly"
  oompa session send my-session --attach diagram.png --attach notes.md "what changed here?"
  oompa session peer-policy get my-session
  oompa session peer-policy set my-session inspect --revision 1
  oompa session task create my-session --name daily-review --every-minutes 1440 -- "review the release queue"`,
  work: `Oompa work

Usage:
  oompa work protocol [--operation <kind>|--type <name>|--topic <topic>]
  oompa work apply --input-stdin|--input-fd <fd>
  oompa work snapshot <work> [--actor <session>]
  oompa work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]
  oompa work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]
  oompa work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  oompa work watch <work> [--cursor <cursor>]

Work commands are agent-only and always emit compact JSON. Mutation documents are strict, bounded, and carry their own idempotency key. Watch emits JSON Lines.

Examples:
  oompa work protocol
  oompa work apply --input-stdin < request.json
  oompa work poll work_0123456789abcdef0123456789abcdef --wait-ms 30000
  oompa work watch work_0123456789abcdef0123456789abcdef`,
  interaction: `Oompa interaction

Usage:
  oompa interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]
  oompa interaction show <interaction-id>
  oompa interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
  oompa interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>
  oompa interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>
  oompa interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]

Protected values are accepted only through stdin or an explicit file descriptor.
Use \`interaction inspect\` to read complete live command or permission authority through a protected terminal or caller-owned file.
File-change callbacks without exact affected paths or change detail are rejected before admission.
Permission approvals accept an exact grant or decline; their provider callback does not represent cancel.
Permission grant document: {"permissions":["<requested-name>"]}
Question answer document: {"answers":{"<question-id>":{"answers":["<answer>"]}}}

Examples:
  oompa interaction decide <id> --revision 1 --decision once
  oompa interaction answer <id> --revision 1 --input-stdin`,
  remote: `Oompa remote

Usage:
  oompa remote list [--limit <1..100>]
  oompa remote show <cloud-session>
  oompa remote command <uuidv7>
  oompa remote send|queue|steer <cloud-session> <message>
  oompa remote stop <cloud-session>
  oompa remote resolve <cloud-session> --interaction <uuid> --revision <n> --decision <decline>
  oompa remote preset <cloud-session> <low|high|ultra|fable-max>
  oompa remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]
  oompa remote fast <cloud-session> <on|off>
  oompa remote allow|deny <device-commands|account-linking>
  oompa remote policy

Examples:
  oompa remote list
  oompa remote send synced-session -- "continue the migration"
  oompa remote deny device-commands
  oompa remote allow account-linking
  oompa remote command <uuidv7>`,
  turn: `Oompa turn

Usage:
  oompa turn inspect <session> <turn> [--json]

Example:
  oompa turn inspect my-session turn_123 --json`,
  auth: `Oompa auth

Usage:
  oompa auth login --input-stdin|--input-fd <fd>
  oompa auth status|logout
  oompa auth delete --acknowledge-erasure

Examples:
  oompa auth login --input-stdin
  oompa auth status --json`,
  device: `Oompa device

Usage:
  oompa device list
  oompa device pair
  oompa device key-loss --acknowledge-no-key-holders
  oompa device approve <device-id-or-prefix> --fingerprint <value> [--idempotency-key <uuidv7>] [--json]
  oompa device revoke <device-id-or-prefix> [--idempotency-key <uuidv7>] [--json]

Examples:
  oompa device pair
  oompa device key-loss --acknowledge-no-key-holders
  oompa device approve <pending-device-prefix> --fingerprint <value>`,
  sync: `Oompa sync

Usage:
  oompa sync status|now
  oompa sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]

Examples:
  oompa sync status
  oompa sync projection recover my-session --acknowledge-gap`,
} as const satisfies Readonly<Record<string, string>>;

export const helpGroupNames: readonly string[] = Object.keys(groupUsage);

export type ResolvedUsage = Readonly<{ group?: string; leaf?: string; usage: string }>;

const helpSectionSeparator = "\n\n";
const usageSectionHeading = "Usage:";
const exampleSectionHeadings: ReadonlySet<string> = new Set(["Examples:", "Example:"]);

const commandLineNamesLeaf = (line: string, group: string, leaf: string): boolean => {
  const tokens = line.trim().split(/\s+/u);
  return tokens[0] === "oompa"
    && tokens[1] === group
    && (tokens[2]?.split("|").includes(leaf) ?? false);
};

// Leaf help is carved from the group text until the command descriptor replaces both.
// It keeps the leaf's usage and example lines and every shared note section of the group.
const leafUsage = (group: string, groupText: string, leaf: string): string | undefined => {
  const sections = groupText.split(helpSectionSeparator);
  const usageSection = sections.find((section) => section.startsWith(`${usageSectionHeading}\n`));
  if (usageSection === undefined) return undefined;
  const usageLines = usageSection.split("\n").slice(1)
    .filter((line) => commandLineNamesLeaf(line, group, leaf));
  if (usageLines.length === 0) return undefined;
  const parts = [`Oompa ${group} ${leaf}`, [usageSectionHeading, ...usageLines].join("\n")];
  for (const section of sections.slice(1)) {
    const [heading = "", ...lines] = section.split("\n");
    if (heading === usageSectionHeading) continue;
    if (exampleSectionHeadings.has(heading)) {
      const examples = lines.filter((line) => commandLineNamesLeaf(line, group, leaf));
      if (examples.length > 0) parts.push([heading, ...examples].join("\n"));
      continue;
    }
    parts.push(section);
  }
  return parts.join(helpSectionSeparator);
};

export function resolveUsage(group: string | undefined, leaf?: string): ResolvedUsage {
  if (group === undefined) return { usage };
  const selected: string | undefined = (
    groupUsage as Readonly<Partial<Record<string, string>>>
  )[group];
  if (selected === undefined) return { usage };
  if (leaf === undefined) return { group, usage: selected };
  const leafText = leafUsage(group, selected, leaf);
  return leafText === undefined
    ? { group, usage: selected }
    : { group, leaf, usage: leafText };
}

export function usageForGroup(group: string | undefined, leaf?: string): string {
  return resolveUsage(group, leaf).usage;
}

const outputModeCommandArguments = (argv: readonly string[]): readonly string[] => {
  const delimiter = argv.indexOf("--");
  const regular = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const commandArguments: string[] = [];
  for (let index = 0; index < regular.length; index += 1) {
    const value = regular[index];
    if (value === undefined) continue;
    if (value === "--idempotency-key" || value === "--preset-contract") {
      index += 1;
      continue;
    }
    if (
      value === "--json"
      || value === "--jsonl"
      || value === "--help"
      || value === "-h"
      || value === "--version"
      || value === "-v"
    ) continue;
    commandArguments.push(value);
  }
  return commandArguments;
};

export function requestsJsonOutput(argv: readonly string[]): boolean {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const command = outputModeCommandArguments(argv)[0];
  return options.includes("--json") || command === "work";
}

export function requestsJsonlOutput(argv: readonly string[]): boolean {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const commandArguments = outputModeCommandArguments(argv);
  return options.includes("--jsonl")
    || options.includes("--follow")
    || (commandArguments[0] === "work" && commandArguments[1] === "watch");
}

export function requestsWorkApplyProtocol(argv: readonly string[]): boolean {
  const commandArguments = outputModeCommandArguments(argv);
  return commandArguments[0] === "work" && commandArguments[1] === "apply";
}

type Cursor = { values: string[]; literalDelimiter: boolean };
const literalPrefix = "\u0000";
const uuidV7KeyLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const uuidV7KeyFutureSkewMs = 5 * 60 * 1_000;
const idempotentCommandKinds = new Set<LocalCommand["kind"]>([
  "account.login",
  "account.claude-login.abandon",
  "account.devin-login.abandon",
  "account.logout",
  "session.start",
  "session.send",
  "session.queue",
  "session.steer",
  "session.stop",
  "session.rename",
  "session.switch",
  "session.task.create",
  "session.task.edit",
  "session.task.delete",
  "memory.remember",
  "memory.share",
  "memory.hosted.create",
  "device.approve",
  "device.revoke",
]);
const literal = (value: string): string => `${literalPrefix}${value}`;
const decode = (value: string): string => value.startsWith(literalPrefix) ? value.slice(literalPrefix.length) : value;
const isOption = (value: string): boolean => !value.startsWith(literalPrefix) && value.startsWith("--");

const deviceKeyFingerprintPattern = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/u;

const isCurrentUuidV7 = (value: string, now = Date.now()): boolean => {
  if (!isUuidV7(value) || !Number.isSafeInteger(now) || now < 0) return false;
  const timestamp = Number.parseInt(`${value.slice(0, 8)}${value.slice(9, 13)}`, 16);
  return Number.isSafeInteger(timestamp)
    && timestamp >= now - uuidV7KeyLifetimeMs
    && timestamp <= now + uuidV7KeyFutureSkewMs;
};

const take = (cursor: Cursor, label: string): string => {
  const value = cursor.values.shift();
  if (value === undefined || isOption(value)) throw new CliUsageError(`Missing ${label}.`);
  return decode(value);
};

const takeBeforeLiteralDelimiter = (cursor: Cursor, label: string): string => {
  const value = cursor.values.shift();
  if (value === undefined || isOption(value) || value.startsWith(literalPrefix)) {
    throw new CliUsageError(`Missing ${label}.`);
  }
  return value;
};

const takeOptional = (cursor: Cursor): string | undefined => {
  const value = cursor.values[0];
  if (value === undefined || isOption(value)) return undefined;
  cursor.values.shift();
  return decode(value);
};

const flag = (cursor: Cursor, name: string): boolean => {
  const index = cursor.values.indexOf(name);
  if (index < 0) return false;
  cursor.values.splice(index, 1);
  return true;
};

const option = (cursor: Cursor, name: string): string | undefined => {
  const index = cursor.values.indexOf(name);
  if (index < 0) return undefined;
  const value = cursor.values[index + 1];
  if (value === undefined || isOption(value)) throw new CliUsageError(`Missing value for ${name}.`);
  cursor.values.splice(index, 2);
  return decode(value);
};

/*
 * A repeatable option. Every occurrence is consumed before the positional
 * words are read, so `--attach` may appear anywhere ahead of the message and
 * the message itself still reaches `remainder` unchanged. A literal word after
 * `--` carries the literal prefix and can never be mistaken for the option.
 */
const repeatedOption = (cursor: Cursor, name: string, limit: number): readonly string[] => {
  const values: string[] = [];
  for (;;) {
    const index = cursor.values.indexOf(name);
    if (index < 0) return values;
    const value = cursor.values[index + 1];
    if (value === undefined || isOption(value)) {
      throw new CliUsageError(`Missing value for ${name}.`);
    }
    if (values.length >= limit) {
      throw new CliUsageError(`At most ${String(limit)} ${name} values are accepted.`);
    }
    cursor.values.splice(index, 2);
    values.push(decode(value));
  }
};

const selectedProvider = (value: string | undefined): SupportedProvider => {
  if (value === undefined) throw new CliUsageError("Missing value for --provider.");
  const parsed = supportedProviderSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(`Provider must be one of: ${supportedProviderSchema.options.map((entry) => `\`${entry}\``).join(", ")}.`);
  }
  return parsed.data;
};

const selectedAdoptableProvider = (value: string | undefined): AdoptableProvider => {
  if (value === undefined) throw new CliUsageError("Missing value for --provider.");
  const parsed = adoptableProviderSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(
      `Provider must be one of: ${adoptableProviderSchema.options.map((entry) => `\`${entry}\``).join(", ")}.`,
    );
  }
  return parsed.data;
};

const selectedPreset = (value: string): SupportedPreset => {
  const parsed = supportedPresetSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(`Preset must be one of: ${supportedPresetSchema.options.map((entry) => `\`${entry}\``).join(", ")}.`);
  }
  return parsed.data;
};

const selectedPresetContract = (value: string | undefined): PresetContract | undefined => {
  if (value === undefined) return undefined;
  if (value !== "1" && value !== "2") {
    throw new CliUsageError("--preset-contract must be exactly `1` or `2`.");
  }
  return Number(value) as PresetContract;
};

const boundedDecimal = (
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number => {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliUsageError(`Missing ${label}.`);
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new CliUsageError(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
};

const notificationClockMinute = (
  value: string | undefined,
  optionName: "--start" | "--end",
): number => {
  if (value === undefined) throw new CliUsageError(`Missing notification-hours ${optionName}.`);
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (
    match === null
    || !Number.isInteger(hour)
    || hour < 0
    || hour > 23
    || !Number.isInteger(minute)
    || minute < 0
    || minute > 59
  ) {
    throw new CliUsageError(`Notification-hours ${optionName} must use 24-hour HH:MM from 00:00 through 23:59.`);
  }
  return hour * 60 + minute;
};

const notificationTimeZone = (value: string | undefined): string => {
  if (value === undefined) throw new CliUsageError("Missing notification-hours --timezone.");
  try {
    return canonicalizeNotificationTimeZone(value);
  } catch {
    throw new CliUsageError(
      "Notification-hours --timezone must be a supported explicit IANA time zone.",
    );
  }
};

const utcRfc3339Milliseconds = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) {
    throw new CliUsageError(`${label} must be a UTC RFC3339 timestamp such as 2026-08-23T12:00:00Z.`);
  }
  const milliseconds = Date.parse(value);
  const fraction = (match[2] ?? "0").padEnd(3, "0");
  const canonical = `${match[1]}.${fraction}Z`;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || new Date(milliseconds).toISOString() !== canonical
  ) {
    throw new CliUsageError(`${label} must be a valid nonnegative UTC RFC3339 timestamp.`);
  }
  return milliseconds;
};

const protectedInput = (cursor: Cursor, required: boolean): ProtectedInputSource | undefined => {
  const stdin = flag(cursor, "--input-stdin");
  const descriptor = option(cursor, "--input-fd");
  if (stdin && descriptor !== undefined) {
    throw new CliUsageError("Use exactly one protected input source: --input-stdin or --input-fd.");
  }
  if (stdin) return { kind: "stdin" };
  if (descriptor !== undefined) {
    const fd = boundedDecimal(descriptor, "input file descriptor", 0, 1_048_575);
    if (fd === 1 || fd === 2) throw new CliUsageError("Protected input cannot read from stdout or stderr.");
    return { fd, kind: "fd" };
  }
  if (required) {
    throw new CliUsageError("This interaction requires --input-stdin or --input-fd. Secret values are not accepted as arguments.");
  }
  return undefined;
};

const remainder = (cursor: Cursor, label: string): string => {
  if (cursor.values.length === 0) throw new CliUsageError(`Missing ${label}.`);
  const unknown = cursor.values.find(isOption);
  if (unknown !== undefined) throw new CliUsageError("Unknown option. Run `oompa --help` for the supported command shape.");
  return cursor.values.splice(0).map(decode).join(" ");
};

const taskPrompt = (
  cursor: Cursor,
  label: "prompt" | "replacement prompt",
  required: boolean,
): string | undefined => {
  if (!cursor.literalDelimiter) {
    if (required || cursor.values.length > 0) {
      throw new CliUsageError(`Session task ${label} must follow the literal \`--\` delimiter.`);
    }
    return undefined;
  }
  if (cursor.values.length === 0) {
    throw new CliUsageError(`Missing session task ${label} after \`--\`.`);
  }
  if (cursor.values.some((value) => !value.startsWith(literalPrefix))) {
    throw new CliUsageError(`Session task ${label} must follow the literal \`--\` delimiter.`);
  }
  return cursor.values.splice(0).map(decode).join(" ");
};

const finish = (cursor: Cursor): void => {
  const unexpected = cursor.values[0];
  if (unexpected !== undefined) throw new CliUsageError("Unexpected argument. Run `oompa --help` for the supported command shape.");
};

const finishWithoutTaskPrompt = (cursor: Cursor): void => {
  finish(cursor);
  if (cursor.literalDelimiter) {
    throw new CliUsageError("This session task command does not accept a prompt delimiter.");
  }
};

const shellArgument = (value: string): string => {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

export const projectionRecoveryReplayCommand = (
  session: string,
  idempotencyKey: string,
  json: boolean,
): string => [
  "oompa sync projection recover",
  shellArgument(session),
  "--acknowledge-gap",
  "--idempotency-key",
  idempotencyKey,
  ...(json ? ["--json"] : []),
].join(" ");

export const accountLoginReplayCommand = (
  command: Extract<LocalCommand, { kind: "account.login" }> & Readonly<{
    idempotencyKey: string;
  }>,
  handoffFile: string | undefined,
  json: boolean,
): string => [
  "oompa account login",
  shellArgument(command.account),
  ...(command.deviceCode ? ["--device-code"] : []),
  "--idempotency-key",
  command.idempotencyKey,
  ...(handoffFile === undefined ? [] : ["--handoff-file", shellArgument(handoffFile)]),
  ...(json ? ["--json"] : []),
].join(" ");

export const accountLoginCancelCommand = (account: string): string =>
  `oompa account login-cancel ${shellArgument(account)}`;

export const claudeAccountLoginCommand = (
  account: string,
  idempotencyKey?: string,
  browserMode: ClaudeAccountAuthCliInvocation["browserMode"] = "provider_default",
): string => [
  "oompa account login",
  shellArgument(account),
  "--provider claude",
  ...(browserMode === "owner_manual" ? ["--manual-browser"] : []),
  ...(idempotencyKey === undefined ? [] : ["--idempotency-key", idempotencyKey]),
].join(" ");

export const claudeAccountLoginAbandonCommand = (
  account: string,
  attemptId: string,
  idempotencyKey: string,
  providerGeneration: number,
): string => [
  "oompa account login-cancel",
  shellArgument(account),
  "--provider claude",
  "--attempt-id",
  shellArgument(attemptId),
  "--provider-generation",
  String(providerGeneration),
  "--idempotency-key",
  idempotencyKey,
  "--acknowledge-child-exited",
].join(" ");

export const devinAccountLoginAbandonCommand = (
  account: string,
  attemptId: string,
  idempotencyKey: string,
  providerGeneration: number,
): string => [
  "oompa account login-cancel",
  shellArgument(account),
  "--provider devin",
  "--attempt-id",
  shellArgument(attemptId),
  "--provider-generation",
  String(providerGeneration),
  "--idempotency-key",
  idempotencyKey,
  "--acknowledge-child-exited",
].join(" ");

export const deviceMutationReplayCommand = (
  command: Extract<LocalCommand, { kind: "device.approve" | "device.revoke" }>,
  json: boolean,
): string => [
  `oompa device ${command.kind === "device.approve" ? "approve" : "revoke"}`,
  shellArgument(command.device),
  ...(command.kind === "device.approve" ? ["--fingerprint", command.fingerprint] : []),
  "--idempotency-key",
  command.idempotencyKey,
  ...(json ? ["--json"] : []),
].join(" ");

const command = (value: unknown): LocalCommand => {
  const parsed = localCommandSchema.safeParse(value);
  if (!parsed.success) throw new CliUsageError(parsed.error.issues[0]?.message ?? "Invalid command.");
  return parsed.data;
};

const exactProtectedField = (document: unknown, field: string): unknown => {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new CliUsageError(`Protected interaction input must be a JSON object containing only ${field}.`);
  }
  const record = document as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== field) {
    throw new CliUsageError(`Protected interaction input must contain exactly one ${field} field.`);
  }
  return record[field];
};

export const completeProtectedInteraction = (
  invocation: ProtectedInteractionCliInvocation,
  document: unknown,
): InteractionResolveCommand => {
  const resolution = invocation.resolution.kind === "permission_grant"
    ? {
      kind: "permission_grant" as const,
      permissions: exactProtectedField(document, "permissions"),
      scope: invocation.resolution.scope,
    }
    : invocation.resolution.kind === "user_answers"
      ? {
        kind: "user_answers" as const,
        answers: exactProtectedField(document, "answers"),
      }
      : {
        action: invocation.resolution.action,
        content: exactProtectedField(document, "content"),
        kind: "mcp_submission" as const,
      };
  const parsed = command({
    kind: "interaction.resolve",
    interaction: invocation.interaction,
    expectedRevision: invocation.expectedRevision,
    resolution,
  });
  if (parsed.kind !== "interaction.resolve") throw new CliUsageError("Protected interaction command is invalid.");
  return parsed;
};

export const completeProtectedAuthLogin = (
  invocation: ProtectedAuthLoginCliInvocation,
  document: unknown,
): Extract<LocalCommand, { kind: "auth.login" }> => {
  const credentials = parseAuthCredentials(document);
  if (credentials.kind === "rejected") {
    throw new CliUsageError(
      "Protected auth input must be exactly {email}, {email, invite}, or {email, code} with canonical values.",
    );
  }
  const parsed = command({
    kind: "auth.login",
    email: credentials.email,
    ...(credentials.kind === "verify_code"
      ? { code: credentials.code }
      : credentials.invite === undefined
        ? {}
        : { invite: credentials.invite }),
  });
  if (parsed.kind !== "auth.login") throw new CliUsageError("Protected auth command is invalid.");
  return parsed;
};

const parseAccount = (
  cursor: Cursor,
  idempotencyKey: string | undefined,
  json: boolean,
): LocalCommand | AccountLoginCliInvocation | ClaudeAccountAuthCliInvocation => {
  const action = take(cursor, "account action");
  switch (action) {
    case "list": {
      const provider = option(cursor, "--provider");
      finish(cursor);
      if (provider === undefined) return { kind: "account.list" };
      if (cursor.literalDelimiter) throw new CliUsageError("Provider account listing does not accept literal arguments.");
      return command({ kind: "account.list", provider });
    }
    case "add": { const label = remainder(cursor, "account label"); return command({ kind: "account.add", label }); }
    case "show": {
      const requestedProvider = option(cursor, "--provider") ?? "codex";
      // Retired-provider inspection exposes local history and pending cleanup only.
      const provider = requestedProvider === "devin" ? "devin" : selectedProvider(requestedProvider);
      const account = take(cursor, "account");
      finish(cursor);
      if (provider !== "codex") {
        if (idempotencyKey !== undefined) {
          throw new CliUsageError("--idempotency-key is not supported by provider account status.");
        }
        return command({ kind: "account.show", account, provider });
      }
      return { kind: "account.show", account };
    }
    case "login": {
      const manualBrowser = flag(cursor, "--manual-browser");
      const deviceCode = flag(cursor, "--device-code");
      const handoffFile = option(cursor, "--handoff-file");
      const provider = selectedProvider(option(cursor, "--provider") ?? "codex");
      const account = take(cursor, "account");
      finish(cursor);
      if (provider === "claude") {
        const browserMode = manualBrowser ? "owner_manual" : "provider_default";
        if (deviceCode) {
          throw new CliUsageError("Claude Code does not expose a device-code login. Run the foreground Claude login without --device-code.");
        }
        if (handoffFile !== undefined) {
          throw new CliUsageError("Claude login is a foreground terminal flow and does not accept --handoff-file.");
        }
        const parsed = command({
          kind: "account.claude-login.prepare",
          account,
          idempotencyKey: idempotencyKey ?? randomUUID(),
        });
        if (parsed.kind !== "account.claude-login.prepare") {
          throw new CliUsageError("Claude account login command is invalid.");
        }
        return {
          browserMode,
          command: parsed,
          json,
          kind: "account.claude-login",
          replayCommand: claudeAccountLoginCommand(parsed.account, parsed.idempotencyKey, browserMode),
        };
      }
      if (manualBrowser) throw new CliUsageError("--manual-browser is supported only for foreground Claude login.");
      if (handoffFile !== undefined && (!isAbsolute(handoffFile) || resolve(handoffFile) !== handoffFile)) {
        throw new CliUsageError("--handoff-file must be an absolute normalized path to an existing protected file.");
      }
      const parsed = command({
        kind: "account.login",
        account,
        deviceCode,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      });
      if (parsed.kind !== "account.login" || parsed.idempotencyKey === undefined) {
        throw new CliUsageError("Account login command is invalid.");
      }
      const exact = { ...parsed, idempotencyKey: parsed.idempotencyKey };
      return {
        command: exact,
        ...(handoffFile === undefined ? {} : { handoffFile }),
        json,
        kind: "account.login-handoff",
        replayCommand: accountLoginReplayCommand(
          exact,
          handoffFile ?? "/absolute/path/to/empty-protected-login.json",
          json,
        ),
      };
    }
    case "login-cancel": {
      const requestedProvider = option(cursor, "--provider") ?? "codex";
      // The sole retired-provider mutation acknowledges an existing child has exited.
      const provider = requestedProvider === "devin" ? "devin" : selectedProvider(requestedProvider);
      if (provider !== "codex") {
        const acknowledgeChildExited = flag(cursor, "--acknowledge-child-exited");
        const attemptId = option(cursor, "--attempt-id");
        const providerGeneration = boundedDecimal(
          option(cursor, "--provider-generation"),
          `${provider === "claude" ? "Claude" : "Devin"} provider generation`,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const account = take(cursor, "account");
        finish(cursor);
        if (!acknowledgeChildExited) {
          throw new CliUsageError(`${provider === "claude" ? "Claude" : "Devin"} login recovery requires --acknowledge-child-exited after you have confirmed its original foreground child exited.`);
        }
        if (attemptId === undefined) throw new CliUsageError(`${provider === "claude" ? "Claude" : "Devin"} login recovery requires --attempt-id from account status.`);
        if (idempotencyKey === undefined) throw new CliUsageError(`${provider === "claude" ? "Claude" : "Devin"} login recovery requires the exact --idempotency-key from account status.`);
        return provider === "claude"
          ? command({
              kind: "account.claude-login.abandon",
              account,
              attemptId,
              idempotencyKey,
              providerGeneration,
              acknowledgeChildExited: true,
            })
          : command({
              kind: "account.devin-login.abandon",
              account,
              attemptId,
              idempotencyKey,
              providerGeneration,
              acknowledgeChildExited: true,
            });
      }
      const account = take(cursor, "account");
      finish(cursor);
      return { kind: "account.login-cancel", account };
    }
    case "logout": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.logout", account }; }
    case "usage": { const refresh = flag(cursor, "--refresh"); const account = takeOptional(cursor); finish(cursor); return command({ kind: "account.usage", account, refresh }); }
    case "usage-history": {
      const fromObservedAt = utcRfc3339Milliseconds(option(cursor, "--from"), "Usage history --from");
      const throughObservedAt = utcRfc3339Milliseconds(option(cursor, "--through"), "Usage history --through");
      const limit = boundedDecimal(
        option(cursor, "--limit"),
        "usage history limit",
        1,
        ACCOUNT_USAGE_HISTORY_PAGE_LIMIT,
        50,
      );
      const historyCursor = option(cursor, "--cursor");
      const account = take(cursor, "account");
      finish(cursor);
      return command({
        kind: "account.usage-history",
        account,
        limit,
        ...(fromObservedAt === undefined ? {} : { fromObservedAt }),
        ...(throughObservedAt === undefined ? {} : { throughObservedAt }),
        ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
      });
    }
    default: throw new CliUsageError("Unknown account action. Run `oompa account --help` for supported actions.");
  }
};

const parsePlugin = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "plugin action");
  const refresh = flag(cursor, "--refresh");
  const project = option(cursor, "--project");
  if (action === "list") {
    const account = take(cursor, "account");
    finish(cursor);
    return command({ kind: "plugin.list", account, project, refresh });
  }
  if (action === "show") {
    const account = take(cursor, "account");
    const plugin = take(cursor, "plugin");
    finish(cursor);
    return command({ kind: "plugin.show", account, plugin, project, refresh });
  }
  if (
    action === "install"
    || action === "enable"
    || action === "disable"
    || action === "oauth"
    || action === "authorize"
  ) {
    throw new CliUsageError(
      `Pinned Codex ${CODEX_PIN} has no safe separated plugin lifecycle effect. Use \`plugin list\` or \`plugin show\` to inspect the exact boundary.`,
    );
  }
  throw new CliUsageError("Unknown plugin action. Run `oompa plugin --help` for supported actions.");
};

const parseProject = (cursor: Cursor, cwd: string): LocalCommand => {
  const action = take(cursor, "project action");
  switch (action) {
    case "list": finish(cursor); return { kind: "project.list" };
    case "add": { const requestedPath = option(cursor, "--path") ?? take(cursor, "project directory"); const label = option(cursor, "--name") ?? takeOptional(cursor) ?? requestedPath.split("/").filter(Boolean).at(-1) ?? "Project"; finish(cursor); return command({ kind: "project.add", label, path: resolve(cwd, requestedPath) }); }
    case "use": { const project = take(cursor, "project"); finish(cursor); return { kind: "project.use", project }; }
    default: throw new CliUsageError("Unknown project action. Run `oompa project --help` for supported actions.");
  }
};

const parseMemory = (
  cursor: Cursor,
  idempotencyKey: string | undefined,
): LocalCommand => {
  const action = take(cursor, "memory action");
  const continuation = option(cursor, "--continuation");
  const workingOnly = flag(cursor, "--working-only");
  if (action === "hosted") {
    if (continuation !== undefined || workingOnly) {
      throw new CliUsageError("Memory hosted commands do not accept query continuation or working-only scope.");
    }
    const hostedAction = take(cursor, "hosted memory action");
    if (hostedAction === "list") {
      finish(cursor);
      return { kind: "memory.hosted.list" };
    }
    if (hostedAction === "create") {
      const project = take(cursor, "project");
      finish(cursor);
      return command({
        kind: "memory.hosted.create",
        project,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      });
    }
    if (hostedAction === "attach") {
      const project = take(cursor, "project");
      const hostedSpaceId = take(cursor, "hosted memory space ID");
      finish(cursor);
      return command({ kind: "memory.hosted.attach", project, hostedSpaceId });
    }
    if (hostedAction === "detach") {
      const generation = option(cursor, "--generation");
      const project = take(cursor, "project");
      finish(cursor);
      if (generation === undefined) {
        throw new CliUsageError("Memory hosted detach requires --generation <n>.");
      }
      return command({
        kind: "memory.hosted.detach",
        project,
        expectedGeneration: boundedDecimal(
          generation,
          "hosted memory attachment generation",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
      });
    }
    if (hostedAction === "sync") {
      const project = take(cursor, "project");
      finish(cursor);
      return { kind: "memory.hosted.sync", project };
    }
    throw new CliUsageError(
      "Unknown hosted memory action. Run `oompa memory --help` for supported actions.",
    );
  }
  if (action === "status") {
    if (continuation !== undefined) {
      throw new CliUsageError("--continuation is not supported by memory status.");
    }
    if (workingOnly) throw new CliUsageError("--working-only is supported only by memory list, get, and search.");
    const session = take(cursor, "session");
    finish(cursor);
    return { kind: "memory.status", session };
  }
  if (action === "list") {
    const session = take(cursor, "session");
    finish(cursor);
    return command({
      kind: "memory.query",
      session,
      value: {
        mode: "list",
        ...(workingOnly ? { scope: "working" as const } : {}),
        ...(continuation === undefined ? {} : { continuation }),
      },
    });
  }
  if (action === "get") {
    const session = take(cursor, "session");
    const key = take(cursor, "memory key");
    finish(cursor);
    return command({
      kind: "memory.query",
      session,
      value: {
        mode: "get",
        key,
        ...(workingOnly ? { scope: "working" as const } : {}),
        ...(continuation === undefined ? {} : { continuation }),
      },
    });
  }
  if (action === "search") {
    const session = take(cursor, "session");
    return command({
      kind: "memory.query",
      session,
      value: {
        mode: "search",
        text: remainder(cursor, "search text"),
        ...(workingOnly ? { scope: "working" as const } : {}),
        ...(continuation === undefined ? {} : { continuation }),
      },
    });
  }
  if (continuation !== undefined) {
    throw new CliUsageError(`--continuation is not supported by memory ${action}.`);
  }
  if (workingOnly) {
    throw new CliUsageError("--working-only is supported only by memory list, get, and search.");
  }
  if (action === "explain") {
    const session = take(cursor, "session");
    const queryId = take(cursor, "memory query ID");
    const row = boundedDecimal(take(cursor, "memory row"), "memory row", 0, 255);
    finish(cursor);
    return command({ kind: "memory.explain", session, value: { queryId, row } });
  }
  if (action === "remember") {
    const title = option(cursor, "--title");
    const summary = option(cursor, "--summary");
    const language = option(cursor, "--language");
    const session = take(cursor, "session");
    const key = take(cursor, "memory key");
    if (title === undefined) throw new CliUsageError("Memory remember requires --title <title>.");
    if (summary === undefined) throw new CliUsageError("Memory remember requires --summary <summary>.");
    const body = remainder(cursor, "memory body");
    return command({
      kind: "memory.remember",
      session,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      value: {
        body,
        key,
        ...(language === undefined ? {} : { language }),
        summary,
        title,
      },
    });
  }
  if (action === "share") {
    const reason = option(cursor, "--reason");
    const session = take(cursor, "session");
    const key = take(cursor, "memory key");
    finish(cursor);
    if (reason === undefined) throw new CliUsageError("Memory share requires --reason <reason>.");
    return command({
      kind: "memory.share",
      session,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      value: { key, reason },
    });
  }
  throw new CliUsageError("Unknown memory action. Run `oompa memory --help` for supported actions.");
};

const parseSessionNote = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "note action");
  const session = take(cursor, "session");
  switch (action) {
    case "get": finish(cursor); return { kind: "session.note.get", session };
    case "edit": finish(cursor); return { kind: "session.note.edit", session };
    case "set": return command({ kind: "session.note.set", session, note: remainder(cursor, "note") });
    case "clear": finish(cursor); return { kind: "session.note.clear", session };
    default: throw new CliUsageError("Unknown note action. Run `oompa session --help` for supported actions.");
  }
};

const parseSessionPeerPolicy = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "peer policy action");
  if (action === "get") {
    const revision = option(cursor, "--revision");
    const session = take(cursor, "session");
    finish(cursor);
    if (revision !== undefined) {
      throw new CliUsageError("--revision is supported only by session peer-policy set.");
    }
    return { kind: "session.peer-policy.get", session };
  }
  if (action === "set") {
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Session peer policy --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const session = take(cursor, "session");
    const mode = take(cursor, "peer policy mode");
    finish(cursor);
    if (mode !== "off" && mode !== "inspect" && mode !== "coordinate") {
      throw new CliUsageError("Peer policy mode must be `off`, `inspect`, or `coordinate`.");
    }
    return command({
      expectedRevision,
      kind: "session.peer-policy.set",
      mode,
      session,
    });
  }
  throw new CliUsageError(
    "Unknown peer policy action. Run `oompa session peer-policy --help` for supported actions.",
  );
};

const parseSessionTask = (
  cursor: Cursor,
  idempotencyKey: string | undefined,
): LocalCommand => {
  const action = takeBeforeLiteralDelimiter(cursor, "task action");
  const session = takeBeforeLiteralDelimiter(cursor, "session");
  if (action === "list") {
    finishWithoutTaskPrompt(cursor);
    return { kind: "session.task.list", session };
  }
  if (action === "show") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    finishWithoutTaskPrompt(cursor);
    return command({ kind: "session.task.show", session, task });
  }
  if (action === "create") {
    const name = option(cursor, "--name");
    const everyMinutes = boundedDecimal(
      option(cursor, "--every-minutes"),
      "Session task --every-minutes",
      SESSION_TASK_MIN_INTERVAL_MINUTES,
      SESSION_TASK_MAX_INTERVAL_MINUTES,
    );
    const paused = flag(cursor, "--paused");
    const prompt = taskPrompt(cursor, "prompt", true);
    return command({
      everyMinutes,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.create",
      name,
      paused,
      prompt,
      session,
    });
  }
  if (action === "edit") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Session task --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const name = option(cursor, "--name");
    const rawEveryMinutes = option(cursor, "--every-minutes");
    const everyMinutes = rawEveryMinutes === undefined
      ? undefined
      : boundedDecimal(
        rawEveryMinutes,
        "Session task --every-minutes",
        SESSION_TASK_MIN_INTERVAL_MINUTES,
        SESSION_TASK_MAX_INTERVAL_MINUTES,
      );
    const pause = flag(cursor, "--pause");
    const resume = flag(cursor, "--resume");
    if (pause && resume) {
      throw new CliUsageError("Session task --pause and --resume are mutually exclusive.");
    }
    const prompt = taskPrompt(cursor, "replacement prompt", false);
    return command({
      expectedRevision,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.edit",
      ...(name === undefined ? {} : { name }),
      ...(everyMinutes === undefined ? {} : { everyMinutes }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(pause ? { status: "paused" } : resume ? { status: "active" } : {}),
      session,
      task,
    });
  }
  if (action === "delete") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Session task --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    finishWithoutTaskPrompt(cursor);
    return command({
      expectedRevision,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.delete",
      session,
      task,
    });
  }
  throw new CliUsageError("Unknown session task action. Run `oompa session --help` for supported actions.");
};

const parseSession = (
  cursor: Cursor,
  jsonl: boolean,
  idempotencyKey: string | undefined,
  presetContract: PresetContract | undefined,
  jsonRequested: boolean,
):
  | LocalCommand
  | SessionEventFollowCliInvocation
  | SessionEventWatchCliInvocation
  | SessionExportCliInvocation
  | Omit<SessionAttachmentCliInvocation, "json"> => {
  const action = take(cursor, "session action");
  switch (action) {
    case "list": {
      const account = option(cursor, "--account");
      const archived = flag(cursor, "--archived");
      const limit = boundedDecimal(option(cursor, "--limit"), "session limit", 1, 100, 50);
      const sessionCursor = option(cursor, "--cursor");
      finish(cursor);
      return command({ kind: "session.list", account, archived, limit, cursor: sessionCursor });
    }
    case "show": { const detail = flag(cursor, "--detail"); const session = take(cursor, "session"); finish(cursor); return { kind: "session.show", session, detail }; }
    case "status": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.status", session }; }
    case "state": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.state", session }; }
    case "peer-policy": return parseSessionPeerPolicy(cursor);
    case "events": {
      const followFlag = flag(cursor, "--follow");
      const follow = followFlag || jsonl;
      const eventCursor = option(cursor, "--cursor");
      const limit = boundedDecimal(option(cursor, "--limit"), "event limit", 1, 200, 200);
      const waitMs = boundedDecimal(
        option(cursor, "--wait-ms"),
        "event wait",
        0,
        30_000,
        follow ? 30_000 : 0,
      );
      if (follow && waitMs === 0) {
        throw new CliUsageError("Following events requires --wait-ms from 1 to 30000.");
      }
      const session = take(cursor, "session");
      finish(cursor);
      const parsed = command({
        kind: "session.events",
        session,
        cursor: eventCursor,
        limit,
        waitMs,
      });
      if (parsed.kind !== "session.events") throw new CliUsageError("Session event command is invalid.");
      return follow
        ? { command: parsed, jsonl: true, kind: "session.events.follow" }
        : parsed;
    }
    case "watch": {
      const eventCursor = option(cursor, "--cursor");
      const session = take(cursor, "session");
      finish(cursor);
      const parsed = command({
        kind: "session.events",
        session,
        cursor: eventCursor,
        limit: 200,
        waitMs: 30_000,
      });
      if (parsed.kind !== "session.events") throw new CliUsageError("Session watch command is invalid.");
      return { command: parsed, jsonl, kind: "session.events.watch" };
    }
    case "interactions": {
      const pending = flag(cursor, "--pending");
      const limit = boundedDecimal(option(cursor, "--limit"), "interaction limit", 1, 100, 100);
      const interactionCursor = option(cursor, "--cursor");
      const session = take(cursor, "session");
      finish(cursor);
      return command({ kind: "session.interactions", session, pending, limit, cursor: interactionCursor });
    }
    case "start": {
      const project = option(cursor, "--project");
      const provider = selectedProvider(option(cursor, "--provider") ?? DEFAULT_PROVIDER);
      const presetOption = option(cursor, "--preset");
      const preset = presetOption === undefined
        ? defaultPresetForProvider(provider)
        : selectedPreset(presetOption);
      const fast = flag(cursor, "--fast");
      const account = take(cursor, "account");
      finish(cursor);
      if (!isReboundCodexPreset(preset)) {
        if (presetContract !== undefined) {
          throw new CliUsageError("--preset-contract is supported only for Codex High or Ultra session starts.");
        }
        return command({ kind: "session.start", account, project, provider, preset, fast });
      }
      if (idempotencyKey !== undefined && presetContract === undefined) {
        throw new CliUsageError(
          "Replaying a Codex High or Ultra session start with --idempotency-key also requires --preset-contract.",
        );
      }
      if (idempotencyKey === undefined && presetContract !== undefined) {
        throw new CliUsageError("--preset-contract requires an explicit --idempotency-key.");
      }
      return command({
        kind: "session.start",
        account,
        project,
        provider,
        preset,
        fast,
        presetContract: presetContract ?? sharedActiveCodexPresetContract(),
      });
    }
    case "send":
    case "queue":
    case "steer": {
      // Attachment paths are read, sniffed, bounded, and written into local
      // content-addressed custody by the CLI composition entry. The parser
      // never opens a file and never puts a path into a command.
      const attach = repeatedOption(cursor, "--attach", ATTACHMENT_MAX_COUNT);
      const session = take(cursor, "session");
      const kind = action === "send"
        ? "session.send" as const
        : action === "queue" ? "session.queue" as const : "session.steer" as const;
      const parsed = command({ kind, session, message: remainder(cursor, "message") });
      if (attach.length === 0) return parsed;
      if (
        parsed.kind !== "session.send"
        && parsed.kind !== "session.queue"
        && parsed.kind !== "session.steer"
      ) throw new CliUsageError("Session message command is invalid.");
      return {
        attach,
        command: parsed,
        kind: "session.attach",
        legacyAttachmentReplay: idempotencyKey !== undefined && action !== "queue",
      };
    }
    case "stop": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.stop", session }; }
    case "rename": { const session = take(cursor, "session"); return command({ kind: "session.rename", session, name: remainder(cursor, "name") }); }
    case "archive": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.archive", session, archived: true }; }
    case "unarchive": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.archive", session, archived: false }; }
    case "adoption": {
      const adoptionAction = take(cursor, "session adoption action");
      const providerValue = option(cursor, "--provider");
      const provider = providerValue === undefined
        ? undefined
        : selectedAdoptableProvider(providerValue);
      if (adoptionAction === "status") {
        finish(cursor);
        return command({ kind: "session.adoption.status", provider });
      }
      if (adoptionAction === "enable") {
        if (provider === undefined) {
          throw new CliUsageError("Session adoption enable requires --provider codex|claude.");
        }
        const account = take(cursor, "account");
        finish(cursor);
        return command({ kind: "session.adoption.set", provider, enabled: true, account });
      }
      if (adoptionAction === "disable") {
        if (provider === undefined) {
          throw new CliUsageError("Session adoption disable requires --provider codex|claude.");
        }
        finish(cursor);
        return command({ kind: "session.adoption.set", provider, enabled: false });
      }
      throw new CliUsageError("Unknown session adoption action. Use `status`, `enable`, or `disable`.");
    }
    case "discover": {
      const providerValue = option(cursor, "--provider");
      const provider = providerValue === undefined
        ? undefined
        : selectedAdoptableProvider(providerValue);
      finish(cursor);
      return command({ kind: "session.adoption.discover", provider });
    }
    case "recover": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.recover", session }; }
    case "abandon": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.abandon", session }; }
    case "note": return parseSessionNote(cursor);
    case "preset": { const session = take(cursor, "session"); const preset = selectedPreset(take(cursor, "preset")); finish(cursor); return command({ kind: "session.preset", session, preset }); }
    case "export": {
      const format = option(cursor, "--format") ?? "trajectory";
      const out = option(cursor, "--out");
      const session = take(cursor, "session");
      finish(cursor);
      if (format !== "trajectory" && format !== "json") {
        throw new CliUsageError("Export format must be `trajectory` or `json`.");
      }
      if (out !== undefined && (out.length === 0 || out.length > 1_024)) {
        throw new CliUsageError("Export output path must be between 1 and 1024 characters.");
      }
      return {
        format,
        json: jsonRequested,
        kind: "session.export",
        ...(out === undefined ? {} : { out }),
        session,
      };
    }
    case "switch": {
      const provider = option(cursor, "--provider");
      const preset = option(cursor, "--preset");
      const account = option(cursor, "--account");
      const session = take(cursor, "session");
      finish(cursor);
      const selected = selectedProvider(provider);
      const selectedModelPreset = preset === undefined ? undefined : selectedPreset(preset);
      if (!providerSwitchRequiresPresetContract(selected, selectedModelPreset)) {
        if (presetContract !== undefined) {
          throw new CliUsageError(
            "--preset-contract is supported only for a source-sensitive Codex provider switch.",
          );
        }
        return command({
          kind: "session.switch",
          session,
          provider: selected,
          ...(selectedModelPreset === undefined ? {} : { preset: selectedModelPreset }),
          ...(account === undefined ? {} : { account }),
        });
      }
      if (idempotencyKey !== undefined && presetContract === undefined) {
        throw new CliUsageError(
          "Replaying a source-sensitive Codex provider switch with --idempotency-key also requires --preset-contract.",
        );
      }
      if (idempotencyKey === undefined && presetContract !== undefined) {
        throw new CliUsageError("--preset-contract requires an explicit --idempotency-key.");
      }
      return command({
        kind: "session.switch",
        session,
        provider: selected,
        ...(selectedModelPreset === undefined ? {} : { preset: selectedModelPreset }),
        presetContract: presetContract ?? sharedActiveCodexPresetContract(),
        ...(account === undefined ? {} : { account }),
      });
    }
    case "fast": { const session = take(cursor, "session"); const value = take(cursor, "on or off"); finish(cursor); if (value !== "on" && value !== "off") throw new CliUsageError("Fast must be `on` or `off`."); return { kind: "session.fast", session, enabled: value === "on" }; }
    case "project": { const session = take(cursor, "session"); const project = take(cursor, "project"); finish(cursor); return { kind: "session.project", session, project }; }
    case "task": return parseSessionTask(cursor, idempotencyKey);
    default: throw new CliUsageError("Unknown session action. Run `oompa session --help` for supported actions.");
  }
};

const parseWork = (
  cursor: Cursor,
  jsonl: boolean,
): LocalCommand | WorkApplyCliInvocation | WorkEventFollowCliInvocation => {
  const action = take(cursor, "work action");
  switch (action) {
    case "protocol":
      if (jsonl) throw new CliUsageError("work protocol emits one JSON document, not JSON Lines.");
      {
        const operation = option(cursor, "--operation");
        const typeName = option(cursor, "--type");
        const topic = option(cursor, "--topic");
        const selectors = [operation, typeName, topic].filter((value) => value !== undefined);
        if (selectors.length > 1) {
          throw new CliUsageError("Use at most one work protocol selector: --operation, --type, or --topic.");
        }
        const query = operation !== undefined
          ? { kind: "operation" as const, operation }
          : typeName !== undefined
            ? { kind: "type" as const, name: typeName }
            : topic !== undefined
              ? { kind: "topic" as const, topic }
              : { kind: "index" as const };
        const parsedQuery = workProtocolQuerySchema.safeParse(query);
        if (!parsedQuery.success) {
          throw new CliUsageError(parsedQuery.error.issues[0]?.message ?? "Invalid work protocol selector.");
        }
        finish(cursor);
        return { kind: "work.protocol", query: parsedQuery.data };
      }
    case "apply": {
      if (jsonl) throw new CliUsageError("work apply emits one JSON document, not JSON Lines.");
      const input = protectedInput(cursor, true);
      finish(cursor);
      if (input === undefined) throw new CliUsageError("Work apply requires --input-stdin or --input-fd.");
      return { input, json: true, kind: "work.apply-input" };
    }
    case "snapshot": {
      if (jsonl) throw new CliUsageError("work snapshot emits one JSON document, not JSON Lines.");
      const actor = option(cursor, "--actor");
      const work = take(cursor, "work");
      finish(cursor);
      return command({ kind: "work.snapshot", work, actor });
    }
    case "task": {
      if (jsonl) throw new CliUsageError("work task emits one JSON document, not JSON Lines.");
      const rawHistoryLimit = option(cursor, "--history-limit");
      const historyCursor = option(cursor, "--history-cursor");
      const task = take(cursor, "task");
      finish(cursor);
      if (rawHistoryLimit === undefined && historyCursor === undefined) {
        return command({ kind: "work.task", task });
      }
      const historyLimit = boundedDecimal(
        rawHistoryLimit,
        "work task history limit",
        1,
        WORK_TASK_HISTORY_ITEM_LIMIT,
        WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
      );
      return command({
        kind: "work.task",
        task,
        historyLimit,
        ...(historyCursor === undefined ? {} : { historyCursor }),
      });
    }
    case "poll": {
      if (jsonl) throw new CliUsageError("work poll emits one JSON document, not JSON Lines.");
      const actor = option(cursor, "--actor");
      const pollCursor = option(cursor, "--cursor");
      const actionCursor = option(cursor, "--action-cursor");
      const limit = boundedDecimal(option(cursor, "--limit"), "work poll limit", 1, 50, 20);
      const waitMs = boundedDecimal(option(cursor, "--wait-ms"), "work poll wait", 0, 30_000, 0);
      if (actionCursor !== undefined && waitMs !== 0) {
        throw new CliUsageError("A continued work action page requires --wait-ms 0.");
      }
      const work = take(cursor, "work");
      finish(cursor);
      return command({
        kind: "work.poll",
        work,
        actor,
        cursor: pollCursor,
        actionCursor,
        limit,
        waitMs,
      });
    }
    case "events":
    case "watch": {
      if (
        action === "watch"
        && ["--limit", "--wait-ms", "--follow"].some((optionName) =>
          cursor.values.includes(optionName))
      ) {
        throw new CliUsageError("work watch supports only <work>, --cursor, and --jsonl.");
      }
      const eventCursor = option(cursor, "--cursor");
      const followFlag = flag(cursor, "--follow");
      const follow = action === "watch" || jsonl || followFlag;
      const limit = boundedDecimal(option(cursor, "--limit"), "work event limit", 1, 200, 200);
      const waitMs = boundedDecimal(
        option(cursor, "--wait-ms"),
        "work event wait",
        0,
        30_000,
        follow ? 30_000 : 0,
      );
      if (follow && waitMs === 0) {
        throw new CliUsageError("Following work events requires --wait-ms from 1 to 30000.");
      }
      const work = take(cursor, "work");
      finish(cursor);
      const parsed = command({
        kind: "work.events",
        work,
        cursor: eventCursor,
        limit,
        waitMs,
      });
      if (parsed.kind !== "work.events") throw new CliUsageError("Work event command is invalid.");
      return follow
        ? { command: parsed, jsonl: true, kind: "work.events.follow" }
        : parsed;
    }
    default:
      throw new CliUsageError("Unknown work action. Run `oompa work --help` for supported actions.");
  }
};

type ParsedInteraction =
  | Readonly<{ command: LocalCommand; kind: "command" }>
  | ProtectedInteractionCliInvocation
  | ProtectedInteractionInspectCliInvocation;

const exactInteractionId = (value: string): string => {
  const parsed = command({ kind: "interaction.show", interaction: value });
  if (parsed.kind !== "interaction.show") throw new CliUsageError("Interaction ID is invalid.");
  return parsed.interaction;
};

const parseInteraction = (cursor: Cursor, json: boolean): ParsedInteraction => {
  const action = take(cursor, "interaction action");
  if (action === "list") {
    const pending = flag(cursor, "--pending");
    const limit = boundedDecimal(option(cursor, "--limit"), "interaction limit", 1, 100, 100);
    const interactionCursor = option(cursor, "--cursor");
    const session = takeOptional(cursor);
    finish(cursor);
    return { command: command({ kind: "interaction.list", session, pending, limit, cursor: interactionCursor }), kind: "command" };
  }
  if (action === "show") {
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return { command: command({ kind: "interaction.show", interaction }), kind: "command" };
  }

  if (action === "inspect") {
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "interaction revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const handoffFile = option(cursor, "--handoff-file");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    if (handoffFile !== undefined && (!isAbsolute(handoffFile) || resolve(handoffFile) !== handoffFile)) {
      throw new CliUsageError("--handoff-file must be an absolute normalized path to an existing protected file.");
    }
    const parsed = command({
      kind: "interaction.inspect",
      interaction,
      expectedRevision,
    });
    if (parsed.kind !== "interaction.inspect") {
      throw new CliUsageError("Protected interaction inspection is invalid.");
    }
    return {
      command: parsed,
      ...(handoffFile === undefined ? {} : { handoffFile }),
      json,
      kind: "interaction.inspect-protected",
    };
  }

  const expectedRevision = boundedDecimal(
    option(cursor, "--revision"),
    "interaction revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (action === "decide") {
    const decision = option(cursor, "--decision");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    if (decision !== "once" && decision !== "session" && decision !== "decline" && decision !== "cancel") {
      throw new CliUsageError("Interaction decision must be once, session, decline, or cancel.");
    }
    return {
      command: command({
        kind: "interaction.resolve",
        interaction,
        expectedRevision,
        resolution: { kind: "approval_decision", decision },
      }),
      kind: "command",
    };
  }
  if (action === "grant") {
    const scopeValue = option(cursor, "--scope");
    if (scopeValue !== undefined && scopeValue !== "turn" && scopeValue !== "session") {
      throw new CliUsageError("Permission scope must be turn or session.");
    }
    const input = protectedInput(cursor, true);
    if (input === undefined) throw new CliUsageError("Protected permission input is required.");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return {
      expectedRevision,
      input,
      interaction: exactInteractionId(interaction),
      json,
      kind: "interaction.resolve-protected",
      resolution: { kind: "permission_grant", scope: scopeValue ?? null },
    };
  }
  if (action === "answer") {
    const input = protectedInput(cursor, true);
    if (input === undefined) throw new CliUsageError("Protected answer input is required.");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return {
      expectedRevision,
      input,
      interaction: exactInteractionId(interaction),
      json,
      kind: "interaction.resolve-protected",
      resolution: { kind: "user_answers" },
    };
  }
  if (action === "submit") {
    const actionValue = option(cursor, "--action");
    if (actionValue !== "accept" && actionValue !== "decline" && actionValue !== "cancel") {
      throw new CliUsageError("MCP submission action must be accept, decline, or cancel.");
    }
    const input = protectedInput(cursor, false);
    if (input !== undefined && actionValue !== "accept") {
      throw new CliUsageError("Protected MCP content is accepted only with --action accept.");
    }
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    const exactInteraction = exactInteractionId(interaction);
    if (input === undefined) {
      return {
        command: command({
          kind: "interaction.resolve",
          interaction: exactInteraction,
          expectedRevision,
          resolution: { kind: "mcp_submission", action: actionValue },
        }),
        kind: "command",
      };
    }
    return {
      expectedRevision,
      input,
      interaction: exactInteraction,
      json,
      kind: "interaction.resolve-protected",
      resolution: { action: "accept", kind: "mcp_submission" },
    };
  }
  throw new CliUsageError("Unknown interaction action. Run `oompa interaction --help` for supported actions.");
};

/**
 * `oompa remote allow|deny <switch>` and `oompa remote policy`. These are local
 * daemon commands, so they are peeled off before the cloud remote parser sees
 * the cursor; `null` means this is an ordinary remote action.
 */
const parseRemotePolicy = (cursor: Cursor): LocalCommand | null => {
  const action = cursor.values[0];
  if (action !== "allow" && action !== "deny" && action !== "policy") return null;
  cursor.values.shift();
  if (action === "policy") {
    finish(cursor);
    return { kind: "remote.policy-status" };
  }
  const target = take(cursor, "remote switch");
  finish(cursor);
  if (target !== "device-commands" && target !== "account-linking") {
    throw new CliUsageError(
      "Unknown remote switch. Use `device-commands` or `account-linking`.",
    );
  }
  return { allowed: action === "allow", kind: "remote.policy-set", switch: target };
};

const parseRemote = (cursor: Cursor): RemoteCliCommand => {
  const action = take(cursor, "remote action");
  switch (action) {
    case "list": {
      const limit = Number(option(cursor, "--limit") ?? "50");
      finish(cursor);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliUsageError("Remote session limit must be an integer from 1 to 100.");
      }
      return { kind: "remote.list", limit };
    }
    case "show": {
      const session = take(cursor, "session");
      finish(cursor);
      return { kind: "remote.show", session };
    }
    case "command": {
      const commandPublicId = take(cursor, "command public ID");
      finish(cursor);
      if (!isUuidV7(commandPublicId)) {
        throw new CliUsageError("Remote command public ID must be a UUIDv7.");
      }
      return { commandPublicId, kind: "remote.command" };
    }
    case "send":
    case "queue":
    case "steer": {
      const orSteer = action === "send" && flag(cursor, "--or-steer");
      const session = take(cursor, "session");
      const message = remainder(cursor, "message");
      if (message.length > 64_000) throw new CliUsageError("Remote message is too long.");
      return orSteer
        ? { kind: "remote.send", session, message, orSteer: true }
        : { kind: `remote.${action}`, session, message };
    }
    case "resolve": {
      const interaction = option(cursor, "--interaction");
      const revisionValue = option(cursor, "--revision");
      const decision = option(cursor, "--decision");
      const session = take(cursor, "session");
      finish(cursor);
      if (interaction === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(interaction)) {
        throw new CliUsageError("Remote resolve requires --interaction <uuid>.");
      }
      const revision = Number(revisionValue);
      if (revisionValue === undefined || !/^[1-9]\d{0,15}$/u.test(revisionValue) || !Number.isSafeInteger(revision)) {
        throw new CliUsageError("Remote resolve requires --revision <positive integer>.");
      }
      // `once` remains accepted for payload compatibility with older compact
      // projections. Current remote policy only advertises actions it grants.
      if (decision !== "once" && decision !== "decline") {
        throw new CliUsageError("Remote resolve requires --decision decline.");
      }
      return { decision, interaction, kind: "remote.resolve", revision, session };
    }
    case "stop": {
      const session = take(cursor, "session");
      finish(cursor);
      return { kind: "remote.stop", session };
    }
    case "preset": {
      const session = take(cursor, "session");
      const preset = selectedPreset(take(cursor, "preset"));
      finish(cursor);
      return { kind: "remote.preset", session, preset };
    }
    case "provider": {
      const preset = option(cursor, "--preset");
      const session = take(cursor, "session");
      const provider = take(cursor, "provider");
      finish(cursor);
      const selected = selectedProvider(provider);
      const selectedModelPreset = preset === undefined ? undefined : selectedPreset(preset);
      return {
        kind: "remote.provider",
        ...(selectedModelPreset === undefined ? {} : { preset: selectedModelPreset }),
        provider: selected,
        session,
      };
    }
    case "fast": {
      const session = take(cursor, "session");
      const value = take(cursor, "on or off");
      finish(cursor);
      if (value !== "on" && value !== "off") throw new CliUsageError("Fast must be `on` or `off`.");
      return { enabled: value === "on", kind: "remote.fast", session };
    }
    default: throw new CliUsageError("Unknown remote action. Run `oompa remote --help` for supported actions.");
  }
};

export function parseCli(argv: readonly string[], cwd = process.cwd()): CliInvocation {
  const delimiter = argv.indexOf("--");
  const regular = delimiter < 0 ? [...argv] : argv.slice(0, delimiter);
  const literalTail = delimiter < 0 ? [] : argv.slice(delimiter + 1).map(literal);
  const cursor: Cursor = { literalDelimiter: delimiter >= 0, values: regular };
  const json = flag(cursor, "--json");
  const jsonl = flag(cursor, "--jsonl");
  if (json && jsonl) {
    throw new CliUsageError("--json and --jsonl are mutually exclusive output modes.");
  }
  const idempotencyKey = option(cursor, "--idempotency-key");
  const presetContract = selectedPresetContract(option(cursor, "--preset-contract"));
  const helpFlag = flag(cursor, "--help") || flag(cursor, "-h");
  const helpAlias = !helpFlag && cursor.values[0] === "help";
  if (helpFlag || helpAlias || (cursor.values.length === 0 && literalTail.length === 0)) {
    const [group, leaf] = helpAlias ? cursor.values.slice(1, 3) : cursor.values.slice(0, 2);
    return {
      kind: "help",
      json,
      ...(group === undefined ? {} : { group }),
      ...(leaf === undefined ? {} : { leaf }),
    };
  }
  if (flag(cursor, "--version") || flag(cursor, "-v")) { finish(cursor); return { json, kind: "version" }; }
  cursor.values.push(...literalTail);
  const group = take(cursor, "command");
  if (
    presetContract !== undefined
    && (
      group !== "session"
      || (cursor.values[0] !== "start" && cursor.values[0] !== "switch")
    )
  ) {
    throw new CliUsageError("--preset-contract is supported only by session start or switch.");
  }
  if (jsonl && group !== "session" && group !== "work") {
    throw new CliUsageError(
      "--jsonl is supported only by `oompa session events` and `oompa session watch`, or by `oompa work events` and `oompa work watch`.",
    );
  }
  if (group === "status") {
    finish(cursor);
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("--idempotency-key is not supported by status.");
    }
    return { kind: "status", json };
  }
  if (group === "usage") {
    if (cursor.literalDelimiter) throw new CliUsageError("Literal arguments are not supported by usage auto.");
    if (take(cursor, "usage command") !== "auto") {
      throw new CliUsageError("Unknown usage command. Run `oompa usage --help` for supported commands.");
    }
    const action = take(cursor, "usage auto action");
    if (action !== "status" && action !== "on" && action !== "off" && action !== "inherit") {
      throw new CliUsageError("Unknown usage auto action. Use `status`, `on`, `off`, or `inherit`.");
    }
    const revision = action === "status" ? undefined : option(cursor, "--revision");
    const providerValue = takeOptional(cursor);
    const provider = providerValue === undefined ? undefined : usageProviderSchema.safeParse(providerValue);
    if (provider !== undefined && !provider.success) {
      throw new CliUsageError("Usage-auto provider must be `codex` or `claude`.");
    }
    finish(cursor);
    if (action === "status") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by usage auto status.");
      }
      return { kind: "command", json, command: command({
        kind: "usage.auto.status", ...(provider === undefined ? {} : { provider: provider.data }),
      }) };
    }
    if (action === "inherit" && provider === undefined) {
      throw new CliUsageError("usage auto inherit requires a provider.");
    }
    if (idempotencyKey === undefined) {
      throw new CliUsageError("usage auto mutations require --idempotency-key <uuid>.");
    }
    return { kind: "command", json, command: command({
      kind: "usage.auto.set",
      idempotencyKey,
      expectedAutomaticPolicyRevision: boundedDecimal(revision, "--revision", 1, Number.MAX_SAFE_INTEGER),
      change: provider === undefined
        ? { kind: "set_default", enabled: action === "on" }
        : { kind: "set_override", provider: provider.data, override: action },
    }) };
  }
  if (group === "init") { const yes = flag(cursor, "--yes"); finish(cursor); return { kind: "init", yes, json }; }
  if (group === "doctor") { const offline = flag(cursor, "--offline"); finish(cursor); return { kind: "command", command: { kind: "doctor", offline }, json }; }
  if (group === "daemon") {
    const action = take(cursor, "daemon action");
    finish(cursor);
    if (action === "start") return { kind: "daemon.start", json };
    if (action === "run") {
      if (json) throw new CliUsageError("--json is not supported by the foreground daemon process.");
      return { kind: "daemon.run" };
    }
    if (action === "status" || action === "stop") return { kind: "command", command: { kind: `daemon.${action}` }, json };
    throw new CliUsageError("Unknown daemon action. Run `oompa daemon --help` for supported actions.");
  }
  if (group === "menubar") {
    finish(cursor);
    return { kind: "menubar", json };
  }
  if (group === "remote") {
    // The two policy switches are local daemon state, not a hosted command, so
    // they route to the daemon like `autorespond` rather than through the cloud
    // remote invocation. Nothing hosted can set them.
    const policy = parseRemotePolicy(cursor);
    if (policy !== null) {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by remote policy commands.");
      }
      return { kind: "command", command: policy, json };
    }
    const remote = parseRemote(cursor);
    if (
      idempotencyKey !== undefined
      && (remote.kind === "remote.list"
        || remote.kind === "remote.show"
        || remote.kind === "remote.command")
    ) throw new CliUsageError(`--idempotency-key is not supported by ${remote.kind}.`);
    const mutates = remote.kind !== "remote.list"
      && remote.kind !== "remote.show"
      && remote.kind !== "remote.command";
    return {
      kind: "remote",
      command: remote,
      ...(mutates && idempotencyKey !== undefined ? { idempotencyKey } : {}),
      json,
    };
  }
  if (group === "autorespond") {
    const action = take(cursor, "autorespond action");
    if (action === "gateway") {
      const gatewayAction = take(cursor, "autorespond gateway action");
      const descriptor = option(cursor, "--from-fd");
      finish(cursor);
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by autorespond.");
      }
      if (gatewayAction === "clear") {
        if (descriptor !== undefined) {
          throw new CliUsageError("--from-fd is not supported by `autorespond gateway clear`.");
        }
        return { kind: "command", command: { kind: "autorespond.gateway-clear" }, json };
      }
      if (gatewayAction !== "set") {
        throw new CliUsageError("Unknown autorespond gateway action. Use `set` or `clear`.");
      }
      if (descriptor === undefined) {
        return { input: { kind: "stdin" }, json, kind: "autorespond.gateway-set" };
      }
      const fd = boundedDecimal(descriptor, "gateway key file descriptor", 0, 1_048_575);
      if (fd === 1 || fd === 2) {
        throw new CliUsageError("The gateway key cannot be read from stdout or stderr.");
      }
      return { input: { fd, kind: "fd" }, json, kind: "autorespond.gateway-set" };
    }
    const session = option(cursor, "--session");
    finish(cursor);
    if (idempotencyKey !== undefined) throw new CliUsageError("--idempotency-key is not supported by autorespond.");
    if (action === "status") {
      return { kind: "command", command: { kind: "autorespond.status", ...(session === undefined ? {} : { session }) }, json };
    }
    const mode = action === "on"
      ? "auto:all"
      : action === "workspace"
        ? "auto:workspace"
        : action === "off"
          ? "manual"
          : action === "default"
            ? null
            : undefined;
    if (mode === undefined) {
      throw new CliUsageError("Unknown autorespond action. Use `on`, `workspace`, `off`, `default`, `status`, or `gateway`.");
    }
    if (mode === null && session === undefined) {
      throw new CliUsageError("`autorespond default` clears a session override; pass --session <session>.");
    }
    return { kind: "command", command: { kind: "autorespond.set", mode, ...(session === undefined ? {} : { session }) }, json };
  }
  if (group === "notification-hours") {
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("--idempotency-key is not supported by notification-hours commands.");
    }
    const action = take(cursor, "notification-hours action");
    if (action === "status") {
      finish(cursor);
      return {
        kind: "command",
        command: { kind: "notification-hours.status" },
        json,
      };
    }
    if (action !== "set") {
      throw new CliUsageError(
        "Unknown notification-hours action. Use `status` or `set`.",
      );
    }
    const startMinute = notificationClockMinute(option(cursor, "--start"), "--start");
    const endMinute = notificationClockMinute(option(cursor, "--end"), "--end");
    const timeZone = notificationTimeZone(option(cursor, "--timezone"));
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Notification-hours --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    finish(cursor);
    return {
      kind: "command",
      command: command({
        kind: "notification-hours.set",
        expectedRevision,
        version: 1,
        startMinute,
        endMinute,
        timeZone,
      }),
      json,
    };
  }
  if (group === "autorespond-after-hours") {
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("--idempotency-key is not supported by autorespond-after-hours commands.");
    }
    const action = take(cursor, "autorespond-after-hours action");
    if (action === "status") {
      finish(cursor);
      return {
        kind: "command",
        command: { kind: "autorespond-after-hours.status" },
        json,
      };
    }
    if (action !== "enable" && action !== "disable") {
      throw new CliUsageError(
        "Unknown autorespond-after-hours action. Use `status`, `enable`, or `disable`.",
      );
    }
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Autorespond-after-hours --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    finish(cursor);
    return {
      kind: "command",
      command: {
        expectedRevision,
        kind: action === "enable"
          ? "autorespond-after-hours.enable"
          : "autorespond-after-hours.disable",
      },
      json,
    };
  }
  if (group === "notification-email") {
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("--idempotency-key is not supported by notification-email commands.");
    }
    const action = take(cursor, "notification-email action");
    if (action === "status") {
      finish(cursor);
      return {
        kind: "command",
        command: { kind: "notification-email.status" },
        json,
      };
    }
    if (action !== "enable" && action !== "disable") {
      throw new CliUsageError(
        "Unknown notification-email action. Use `status`, `enable`, or `disable`.",
      );
    }
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Notification-email --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    finish(cursor);
    return {
      kind: "command",
      command: {
        expectedRevision,
        kind: action === "enable"
          ? "notification-email.enable"
          : "notification-email.disable",
      },
      json,
    };
  }
  let parsed: LocalCommand;
  let sessionAttach: readonly string[] = [];
  let legacyAttachmentReplay = false;
  if (group === "account") {
    const account = parseAccount(cursor, idempotencyKey, json);
    if (
      account.kind === "account.login-handoff"
      || account.kind === "account.claude-login"
    ) return account;
    parsed = account;
  }
  else if (group === "plugin") parsed = parsePlugin(cursor);
  else if (group === "project") parsed = parseProject(cursor, cwd);
  else if (group === "memory") parsed = parseMemory(cursor, idempotencyKey);
  else if (group === "session") {
    const sessionCommand = parseSession(cursor, jsonl, idempotencyKey, presetContract, json);
    if (sessionCommand.kind === "session.export") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.export.");
      }
      if (jsonl) {
        throw new CliUsageError("--jsonl is supported only by `oompa session events` and `oompa session watch`.");
      }
      return sessionCommand;
    }
    if (sessionCommand.kind === "session.events.follow") {
      if (json) {
        throw new CliUsageError("Event following is already JSON Lines and cannot be combined with --json.");
      }
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.events.");
      }
      return sessionCommand;
    }
    if (sessionCommand.kind === "session.events.watch") {
      if (json) {
        throw new CliUsageError("Session watch does not support --json. Use --jsonl for machine output.");
      }
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.watch.");
      }
      return sessionCommand;
    }
    if (jsonl) {
      throw new CliUsageError("--jsonl is supported only by `oompa session events` and `oompa session watch`.");
    }
    if (sessionCommand.kind === "session.attach") {
      sessionAttach = sessionCommand.attach;
      legacyAttachmentReplay = sessionCommand.legacyAttachmentReplay;
      parsed = sessionCommand.command;
    } else {
      parsed = sessionCommand;
    }
  }
  else if (group === "work") {
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("Work mutations carry one idempotencyKey inside the strict input document.");
    }
    const workCommand = parseWork(cursor, jsonl);
    if (workCommand.kind === "work.apply-input" || workCommand.kind === "work.events.follow") {
      if (json && workCommand.kind === "work.events.follow") {
        throw new CliUsageError("Work event following is already JSON Lines and cannot be combined with --json.");
      }
      return workCommand;
    }
    return { kind: "command", command: workCommand, json: true };
  }
  else if (group === "turn") { const action = take(cursor, "turn action"); if (action !== "inspect") throw new CliUsageError("Unknown turn action. Run `oompa turn --help` for supported actions."); const session = take(cursor, "session"); const turn = take(cursor, "turn"); finish(cursor); parsed = { kind: "turn.inspect", session, turn }; }
  else if (group === "interaction") {
    const interaction = parseInteraction(cursor, json);
    if (interaction.kind === "interaction.inspect-protected") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by interaction.inspect.");
      }
      return interaction;
    }
    if (interaction.kind === "interaction.resolve-protected") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by interaction.resolve.");
      }
      return interaction;
    }
    parsed = interaction.command;
  }
  else if (group === "auth") {
    const action = take(cursor, "auth action");
    if (action === "login") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by auth.login.");
      }
      const input = protectedInput(cursor, true);
      finish(cursor);
      if (input === undefined) throw new CliUsageError("Protected auth input is required.");
      return { input, json, kind: "auth.login-protected" };
    }
    if (action === "delete") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by auth.delete; Oompa durably owns deletion recovery.");
      }
      const acknowledgeErasure = flag(cursor, "--acknowledge-erasure");
      finish(cursor);
      if (!acknowledgeErasure) {
        throw new CliUsageError("Account deletion requires --acknowledge-erasure.");
      }
      parsed = { acknowledgeErasure: true, kind: "auth.delete" };
    } else if (action === "status" || action === "logout") {
      finish(cursor);
      parsed = { kind: `auth.${action}` };
    } else {
      throw new CliUsageError("Unknown auth action. Run `oompa auth --help` for supported actions.");
    }
  }
  else if (group === "device") {
    const action = take(cursor, "device action");
    if (action === "list" || action === "pair") {
      finish(cursor);
      parsed = { kind: `device.${action}` };
    } else if (action === "key-loss") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by device key-loss.");
      }
      const acknowledgeNoKeyHolders = flag(cursor, "--acknowledge-no-key-holders");
      finish(cursor);
      if (!acknowledgeNoKeyHolders) {
        throw new CliUsageError("Account-key loss acknowledgement requires --acknowledge-no-key-holders.");
      }
      parsed = {
        acknowledgeNoKeyHolders: true,
        kind: "device.key-loss",
      };
    } else if (action === "approve" || action === "revoke") {
      const device = take(cursor, "device");
      // Approval binds to the key fingerprint the operator was shown, so an
      // enrolling device cannot substitute another key pair behind its ID.
      const fingerprint = action === "approve" ? option(cursor, "--fingerprint") : undefined;
      finish(cursor);
      if (action === "approve" && fingerprint === undefined) {
        throw new CliUsageError("Device approval requires --fingerprint <value> from oompa device list.");
      }
      if (fingerprint !== undefined && !deviceKeyFingerprintPattern.test(fingerprint)) {
        throw new CliUsageError("Device approval --fingerprint must be eight lower-case hex groups of four separated by hyphens.");
      }
      const deviceMutationKey = idempotencyKey ?? createCloudUuidV7();
      if (!isCurrentUuidV7(deviceMutationKey)) {
        throw new CliUsageError("Device mutation --idempotency-key must be a current UUIDv7.");
      }
      parsed = action === "approve" && fingerprint !== undefined
        ? { device, fingerprint, idempotencyKey: deviceMutationKey, kind: "device.approve" }
        : { device, idempotencyKey: deviceMutationKey, kind: "device.revoke" };
    } else {
      throw new CliUsageError("Unknown device action. Run `oompa device --help` for supported actions.");
    }
  }
  else if (group === "sync") {
    const action = take(cursor, "sync action");
    if (action === "status" || action === "now") {
      finish(cursor);
      parsed = { kind: `sync.${action}` };
    } else if (action === "projection") {
      const projectionAction = take(cursor, "projection action");
      if (projectionAction !== "recover") {
        throw new CliUsageError("Unknown projection action. Run `oompa sync --help` for supported actions.");
      }
      const acknowledgeGap = flag(cursor, "--acknowledge-gap");
      const session = take(cursor, "local session");
      finish(cursor);
      const recoveryKey = idempotencyKey ?? createCloudUuidV7();
      if (
        (idempotencyKey === undefined && !isCurrentUuidV7(recoveryKey))
        || (idempotencyKey !== undefined && !isUuidV7(recoveryKey))
      ) {
        throw new CliUsageError("Projection recovery --idempotency-key must be a canonical UUIDv7.");
      }
      const recoveryCommand = command({
        acknowledgeGap: true,
        idempotencyKey: recoveryKey,
        kind: "sync.projection-recover",
        session,
      });
      if (recoveryCommand.kind !== "sync.projection-recover") {
        throw new CliUsageError("Projection recovery command is invalid.");
      }
      const replayCommand = projectionRecoveryReplayCommand(
        recoveryCommand.session,
        recoveryCommand.idempotencyKey,
        json,
      );
      if (!acknowledgeGap) {
        return {
          error: {
            code: "INTERACTION_REQUIRED",
            details: {
              acknowledgementRequired: "--acknowledge-gap",
              idempotencyKey: recoveryCommand.idempotencyKey,
              nextCommand: replayCommand,
            },
            message: "Projection recovery can preserve an unsynced transcript gap. Review the warning, then run the exact next command to acknowledge that gap.",
          },
          json,
          kind: "interaction-required",
        };
      }
      return {
        command: recoveryCommand,
        json,
        kind: "sync.projection-recover",
        replayCommand,
      };
    } else {
      throw new CliUsageError("Unknown sync action. Run `oompa sync --help` for supported actions.");
    }
  }
  else throw new CliUsageError("Unknown command. Run `oompa --help` for supported commands.");
  const supportsIdempotency = idempotentCommandKinds.has(parsed.kind);
  if (idempotencyKey !== undefined && !supportsIdempotency) {
    throw new CliUsageError(`--idempotency-key is not supported by ${parsed.kind}.`);
  }
  if (supportsIdempotency) {
    const generated = "idempotencyKey" in parsed && typeof parsed.idempotencyKey === "string"
      ? parsed.idempotencyKey
      : randomUUID();
    parsed = command({ ...parsed, idempotencyKey: idempotencyKey ?? generated });
  }
  if (sessionAttach.length > 0) {
    if (
      parsed.kind !== "session.send"
      && parsed.kind !== "session.queue"
      && parsed.kind !== "session.steer"
    ) throw new CliUsageError("Only session send, queue, and steer accept --attach.");
    return {
      attach: sessionAttach,
      command: parsed,
      json,
      kind: "session.attach",
      legacyAttachmentReplay,
    };
  }
  return { kind: "command", command: parsed, json };
}
