# Claude provider notes

Status: the notes below are the W1 spike that the W3-C adapter was built from. The adapter now exists in `src/claude/` (pin, runtime discovery, process, protocol, delta assembler, client) with `src/daemon/claude-runtime-adapter.ts` implementing `ClaudeRuntimePort`. Every mapped shape below is covered by a fixture-driven test in `src/claude/`; nothing shells out to `claude` in tests. On Linux, the daemon starts a managed Claude session end to end and the local CLI has a deterministic foreground sign-in and bounded status path. New managed Claude provider effects are refused on macOS until authenticated testing proves that an isolated `CLAUDE_CONFIG_DIR` has isolated Keychain custody and that a detached daemon can read it without a prompt. Separately, opt-in personal-home discovery can adopt a session only after exact pinned registry and process evidence proves that its prior controller is no longer live. Real authenticated managed-profile acceptance against the exact pin remains pending. A retained macOS executable reported exact Claude Code 2.1.260 on 2026-09-07, so runtime availability no longer blocks the macOS qualification; neither executable discovery, that version probe, nor the deterministic tests prove credential isolation. There is no Claude account-linking flow in the web app. See [Adopt sessions from personal provider homes](../session-adoption.md).

## Account isolation, sign-in, and status

One Oompa profile owns independent Codex and Claude homes. Its Claude home is exported as an absolute, isolated `CLAUDE_CONFIG_DIR`. Claude authentication is provider-scoped: it neither reads nor overwrites Codex `profile.state`, and Codex sign-in state does not determine Claude sign-in state.

On Linux, sign in from an interactive terminal:

```sh
oompa account login <profile> --provider claude
```

This is a Linux-only foreground, TTY-only command. It refuses `--json`, resolves the installed Claude executable to a regular-file path, requires its exact self-reported version to match Oompa's compatibility pin, and launches that path with `auth login --claudeai`, the isolated `CLAUDE_CONFIG_DIR`, and Oompa's allowlisted environment. That version assertion does not authenticate the executable's package bytes and does not defend against a malicious same-user PATH substitution. The Claude CLI owns its prompts and browser handoff. Oompa explicitly supplies the terminal descriptors but never reads, copies, stores, or forwards the credential. A terminal Ctrl-C reaches the foreground process group; Oompa observes it, joins the exact child, and bounds cleanup if the child does not exit. An internal caller abort sends that child `SIGTERM` and applies the same bounded join. On macOS, Oompa refuses before launching Claude.

Claude has no Oompa device-code, handoff-file, web-linking, or ordinary background cancellation flow. Do not pass `--device-code` or `--handoff-file`. Before launching Claude, Oompa durably consumes a one-child grant. Another login cannot start under that grant. When the profile is signed out, preparation may locally release and terminalize only Claude sessions that are quiescent and idle under the same profile. That release stops Oompa's local runtime hold but does not delete the provider thread. An active turn, queued work, a pending interaction, recovery, or any other unsettled provider authority refuses login without releasing the session. New Claude provider effects are likewise refused while a login grant is unsettled.

Each Claude child is process-local, but the durable Oompa session can resume in a later daemon. Oompa records the exact child identity and will launch `claude --resume` only after it proves the prior process is no longer live. The replacement child is durably claimed and observed before its provisioned Oompa host-tool binding becomes callable. Unknown or still-live process custody fails closed.

A shared profile-generation change cannot strand that process custody. Active, recovery-required, or otherwise unsettled Claude authority refuses an explicit Codex login. Quiescent exact children are joined and their private bindings revoked before the durable generation advances; their Oompa sessions remain resumable rather than being terminalized. After the commit, the isolated runtime bindings are rekeyed to the new generation. A spontaneous Codex disconnect does not rotate the generation while a Claude controller or launch intent is retained. If a post-commit runtime rebind fails, Oompa closes the daemon instead of continuing with split authority.

Normally the foreground parent joins Claude and completes the grant immediately. If that parent or the daemon fails after launch, or forced cleanup cannot prove the child's exit within its deadline, credential presence cannot prove that the child exited, so status keeps the exact recovery fence even when Claude reports signed in. The cleanup deadline starts only after interruption; an ordinary interactive login has no arbitrary completion timeout. A same-key retry identifies the attempt but never launches a second child. After first confirming the original Claude child has exited, the operator may release only that exact local fence with the acknowledged recovery command reported by status:

```sh
oompa account login-cancel <profile> --provider claude \
  --attempt-id <attempt-id> \
  --provider-generation <generation> \
  --idempotency-key <key> \
  --acknowledge-child-exited
```

This recovery command does not stop Claude and does not read, change, or delete a credential. It cannot be used as an ordinary provider-side cancel. A fresh login requires a fresh idempotency key after the fence is released.

On Linux, check the provider-specific state without starting a login:

```sh
oompa account show <profile> --provider claude
```

The status path runs the same version-admitted executable path with `auth status --json` inside the isolated home. Oompa bounds the command's deadline and output, validates its exit code and response together, transiently validates the complete status document, discards its identity and usage fields, and projects only whether Claude reports the account as signed in. `--json` is supported for this status command. Oompa does not open or parse any Claude credential file. When a launch is unresolved, status returns the exact same-key, completion-status, and acknowledged-abandon guidance without requiring a provider status probe and without treating credential presence as process-exit proof. This recovery-only read remains available when the provider probe cannot run.

This readiness rule applies to session operations and scheduled conversation tasks. `oompa work` remains Codex-only because its frozen execution route does not carry a provider. `oompa session list --account` emits locally owned Claude sessions before entering Codex's separate provider-list cursor, so account filtering remains provider-neutral even though Claude has no provider-side listing. Fast mode is a Codex service tier and is refused for Claude starts, toggles, and provider switches instead of being silently ignored.

Account selection stays user-directed, and Oompa never rotates a Claude account automatically. Claude profiles default to a per-account cap of two concurrent sessions; swarm-scale traffic may be judged non-ordinary by the provider, and users raise the cap knowingly.

Personal account status uses the same bounded, joined status process as managed login status, while leaving `CLAUDE_CONFIG_DIR` unset for Claude's canonical personal home. A coherent signed-out exit is a signed-out observation, not a process fault. Cached OAuth metadata confers identity only when the current status proves Claude subscription authentication; another signed-in authentication mode cannot inherit that cached account identity.

Personal-home adoption is a separate local, opt-in boundary. Discovery reads a bounded allowlist of scalar live-session registry fields and accepts only records naming the exact Claude Code pin. It never runs a discovery prompt or reads the registry key, socket, credential, or transcript. A complete bounded registry snapshot plus a matching PID domain, PID, and host process-start token are required to classify a process as live. A previously captured PID absent from the process table, or a captured PID whose start token now differs, is not live; a registry record missing an exact PID identity and any incomplete, conflicting, or unreadable evidence remain unknown. Oompa privately retains that bounded tuple for re-probes if a registry row disappears. The `ps lstart` token has one-second wall-clock granularity, so a rare alias conservatively retains custody rather than authorizing adoption. This is a bounded liveness inference, not a provider-wide lease against another process resuming later. A recent session must also report a registered Oompa project. The resumed runtime independently proves the installed pin and exact personal Claude account; the Oompa profile's separate Codex account may remain signed out. Once resumed, it has the same stdin, autorespond, and approval authority as a Claude session Oompa started. Account revocation and recovery also use the same provider- and runtime-scoped contract. Controller provenance remains private and does not add a session badge or require detach solely for login, logout, or provider-account replacement.

## macOS Keychain probe (plan item D2)

Release decision: managed Claude profiles ship Linux-first. Oompa refuses managed Claude login, provider-status, new-session, and switch-to-Claude effects on macOS until a detached-daemon Keychain acceptance answers the question below positively. Personal-home adoption is a separate boundary: it uses the user's existing personal Claude home and exact process-liveness proof, and does not claim that an isolated managed Keychain has been accepted.

Question: after an interactive sign-in under one isolated profile, does a detached daemon spawning the runtime under that profile's `CLAUDE_CONFIG_DIR` read only its directory-keyed Keychain item without prompting?

Recorded so far (2026-09-02, Claude Code 2.1.258, macOS):

- A fresh, empty, mode-0700 `CLAUDE_CONFIG_DIR` fully isolates configuration. `claude auth status` runs non-interactively inside it, reports `loggedIn: false`, creates only `.claude.json`, a lock directory, and `backups/`, and does not touch or prompt for the Keychain.
- A sanitized credential-free probe of exact Claude Code `2.1.260` recorded exit `1` and the exact, order-insensitive key set `analyticsDisabled`, `apiProvider`, `authMethod`, `loggedIn`, `projectsDirectory`, with types boolean/string/string/boolean/string. Its authority literals were `loggedIn: false`, `authMethod: "none"`, and `apiProvider: "firstParty"`. This probe established only signed-out behavior; it did not prove authenticated macOS credential isolation. The released status parser separately validates coherent signed-in and signed-out documents as described above. No raw path, payload, credential, or identity was retained from the probe.
- The machine's login keychain holds one item for the default configuration, service `Claude Code-credentials`.

Pending, requires the owner to sign in interactively inside two distinct isolated profile homes with a Claude Code executable whose exact self-reported version matches Oompa's compatibility pin:

- Whether each sign-in stores a distinct directory-keyed Keychain item or a file inside its own profile home.
- Whether each detached process with no window server session reads only its own identity without a prompt.

The unauthenticated probe above does not establish either fact. On 2026-09-07, a retained macOS executable reported exact Claude Code 2.1.260 without replacing the active installation. This removes the earlier runtime-availability blocker, not the authenticated qualification or full live-acceptance requirements. Acceptance must use Oompa's exact Claude Code pin; a different version or executable discovery alone is insufficient. Oompa never stores a `setup-token` or any other credential under any outcome.

## Stream-json contract (captured 2026-09-03)

Spike for the "Providers, models" and Claude Code (W3) sections in [Oompa Web v1](../../kb/plans/hra-web-v1.md). Pinned facts for this capture: `claude_code_version` `2.1.260` measured with `claude --version` on this machine (the plan's prior ground truth recorded `2.1.259`; treat the exact version as drifting release to release and keep pinning and failing closed on drift, as the plan already requires). None of this is a published contract.

### CLI surface (`claude --help`)

Relevant flags, verbatim from `claude --help` on `2.1.260`:

- `--append-system-prompt <prompt>` appends a host-supplied prompt to Claude's default system prompt. Passing an append normally disables the built-in prompt snapshot, so Oompa also passes `--system-prompt-snapshot on`: the rendered prompt (including the append) is then recorded and reused verbatim. On resume, an existing record wins over a different launch-time append until compaction. Oompa may therefore admit one static preamble without an opening user-message impersonation. The complete relevant help paragraph is retained in the pinned fixture rather than reduced to the flag's first line.
- `--mcp-config <configs...>` loads explicit MCP server configuration, and `--strict-mcp-config` ignores every other MCP configuration source. These exact flags are the narrow provider-native seam for Oompa host tools.
- `--effort <level>` - "Effort level for the current session (low, medium, high, xhigh, max)". This is the flag list of common values, not the full legal set: `ultracode` is a real, separate `reasoningEffort` value returned by the protocol's model listing for reasoning-capable models (see below) and is not shown in `--help`; "max without ultracode" means passing `--effort max` specifically.
- `--model <model>` - "Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')." The help text's own example (`claude-fable-5`) is already one version behind what this machine accepts (see below).
- `--fallback-model <model>` - "Enable automatic fallback to specified model(s) when the default model is overloaded or not available." It accepts an ordered comma-separated list and works only with `--print`. The flag's presence proves only an argv surface. It does not prove that a particular fallback model and effort combination is accepted for an authenticated account.
- `--output-format <format>` - "(only works with --print): 'text' (default), 'json' (single result), or 'stream-json' (realtime streaming)".

- `--input-format <format>` - "(only works with --print): 'text' (default), or 'stream-json' (realtime streaming input)".
- `--resume [value]` / `-r` - "Resume a conversation by session ID, or open interactive picker with optional search term".
- `--permission-mode <mode>` - "Permission mode to use for the session (choices: 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan')".
- `--dangerously-skip-permissions` - "Bypass all permission checks. Recommended only for sandboxes with no internet access." (Distinct from `--allow-dangerously-skip-permissions`, which only makes the bypass available as an option without enabling it by default.)
- `CLAUDE_CONFIG_DIR`: not a `--help` flag, it is an environment variable read by the bundled runtime; strings found in the installed CLI bundle confirm it must be an absolute path (the process errors with "... is not an absolute path" otherwise), that it selects the whole config/session/credential home (matching this doc's existing Keychain-probe notes), and that the runtime specifically checks whether a spawned child's `CLAUDE_CONFIG_DIR` matches its parent's for transcript-mirroring purposes, i.e. isolation is a first-class, load-bearing concept in the runtime, not an incidental side effect of the env var.

### Session-bound Oompa host tools

The pinned CLI initializes a stdio MCP server with protocol revision
`2025-11-25`, then sends `notifications/initialized` and `tools/list`; the exact
request frames are in `claude-fixtures/mcp-handshake-2.1.260.jsonl.txt`. Oompa's
bridge admits only that pinned client/version and exposes exactly the eight
entries in the shared `hra.host-tools.v1` manifest. Each model-visible tool
schema has `additionalProperties: false`; account, project, provider-thread,
process-generation, clock, and storage authority are never model arguments.

New Oompa-created Claude threads receive the Oompa preamble and host tools together. Existing personal adoptions and legacy sessions without that durable capability resume with Oompa host tools disabled: a saved provider prompt snapshot can ignore a later append, so an MCP configuration alone cannot prove that the combined capability was installed. Their owner-facing memory CLI and ordinary session controls remain available.

Each tool-bound Claude process receives a unique MCP config and binding file in a private
mode-0700 directory. Both files are mode 0600. The config contains only the
stdio command and binding-file path; the binding file contains a random
per-session capability and local callback-socket path beneath the same
validated private root. Provisioning leaves the binding inactive so the config
can exist before process spawn; the daemon explicitly activates it only after
the provider-thread commit. The daemon keeps the capability digest mapped to
the provider thread and profile generation, and it invalidates that mapping
before deleting the files on session end, provider switch, or daemon shutdown.
No daemon-wide bearer or raw HTTP endpoint is given to Claude.

Request replay bodies are retained in a bounded live ledger and reclaimed only
after the MCP response-written lifecycle completes. Compact session-lifetime
request-ID and callback call-ID tombstones continue to fence old replays after
the 256 live bodies are reclaimed. Each session-lifetime ledger retains at
most 4,096 distinct IDs: known IDs remain exact replays, while a new ID fails
closed once that ledger's lifetime bound is exhausted. A reclaimed ID can
never cause the host mutation to execute again.

This is an application attribution boundary, not an OS sandbox. Another
hostile process running under the same Unix uid can inspect that user's memory
and private files and is therefore inside Oompa's local trust base. The binding
prevents a model call from choosing another actor; it does not claim isolation
from same-uid malware.

### Fable model id and reasoning efforts

- On this machine, `claude -p ... --model claude-fable-5-1 --effort max --output-format json --max-turns 1` was accepted directly; no fallback to `claude-fable-5` was needed. The result and stream-json `assistant`/`result` events report `"model":"claude-fable-5-1"` and `modelUsage["claude-fable-5-1"] = {canonicalModel:"claude-fable-5-1", provider:"firstParty", contextWindow:1000000, maxOutputTokens:64000, ...}`.
- **The model id itself has drifted between builds.** A `model/list` capture from `get-bb/bb`'s recordings (Claude Code `2.1.238`, 2026-08-21) lists the Fable entry as id `claude-fable-5` ("Fable 5"), with `supportedReasoningEfforts` = `low | medium | high | xhigh | ultracode | max` (each as `{reasoningEffort, description}`) and `defaultReasoningEffort: "high"`. By `2.1.260` (this machine, 2026-09-03) the accepted id is `claude-fable-5-1`. This capture did not re-run `model/list` on this machine (only the `-p` path above), so the full `supportedReasoningEfforts` set for `claude-fable-5-1` specifically is inferred from the `claude-fable-5` capture, not independently reconfirmed; only `max` was directly confirmed to work for `claude-fable-5-1` here. Pin the exact id per deployed `claude_code_version` and re-verify on every Codex/Claude bump, the same way the plan already requires for Codex.
- Unauthenticated behavior (fresh, empty `CLAUDE_CONFIG_DIR`, `--output-format json`): `is_error: true`, `subtype: "success"` (the CLI's own outer envelope, despite the failure), `result: "Not logged in · Please run /login"`, `terminal_reason: "api_error"`, all usage/cost fields zeroed, `session_id` still issued. See `claude-fixtures/output-json-unauthenticated.jsonl.txt`.
- Authenticated, single short turn (this machine's existing login, minimal real spend, owner-approved): `is_error: false`, `stop_reason: "end_turn"`, `terminal_reason: "completed"`, `result: "ok"`, real `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `total_cost_usd`, and a `modelUsage` map keyed by canonical model id. See `claude-fixtures/output-json-authenticated.jsonl.txt`.

### Native Fable-to-Opus fallback

The reviewed ladder for Claude Code 2.1.260 is Fable `claude-fable-5-1`, native fallback `claude-opus-5`, and effort `max`. Oompa's pure argument builder covers both exact forms. The disabled form omits `--fallback-model`; the admitted form places `--fallback-model claude-opus-5` between the primary model and `--effort max`.

The live capability is `unavailable: live_acceptance_required`. No signed-in isolated Oompa Claude profile was available for an authenticated acceptance run. Oompa did not use the global Claude configuration or copy credentials into an isolated profile. Every new runtime profile records the reviewed fallback model and this unavailable reason, and production runtime resolution always chooses the disabled argv form. Older runtime profiles remain readable without that newly added field.

Enabling the capability requires a sanitized record from the exact pinned build and an already signed-in isolated Oompa profile. The record must prove an ordinary terminal result for Opus with max effort and an ordinary terminal result when the process starts with Fable, Opus fallback, and max effort. It may record only the exact version, model ids, effort, argv shape, terminal classification, and evidence digest. It must not retain a prompt, response text, configuration path, credential, account identity, or raw provider payload. The acceptance does not need to force or claim that a fallback occurred.

Oompa does not restart, resume, or replay a Claude turn to simulate fallback. A future admitted native fallback may continue only inside the provider's own in-flight process. A missing terminal model identity stays unknown and is not inferred from quota or the requested model.

### stream-json event shapes

Captured with `claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 1`, one user line piped on stdin (`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`). Raw, path-redacted event lines: `claude-fixtures/stream-json-single-turn.jsonl.txt`. Event sequence observed for one short turn with hooks configured: `system/hook_started` x N, `system/hook_response` x N (one pair per configured `SessionStart` hook), `system/init` (session bootstrap: `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`, `slash_commands`, `claude_code_version`, `capabilities`, `memory_paths`), `assistant` (one per completed message; only present without partial deltas unless `--include-partial-messages` is also passed, in which case `stream_event` wrapping raw Anthropic Messages API deltas such as `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop` interleave before the final `assistant` line, as seen in the bb recordings), `rate_limit_event` (`rate_limit_info.status`, `unifiedWindows.{five_hour,seven_day,...}.utilization`), `result` (the same shape as the `-p --output-format json` result above, terminating the process).

### bb wire captures: control protocol, questions, subagents

From `get-bb/bb` (MIT), `packages/provider-bridge-protocol/recordings/claude-code/{approval-allow,approval-deny,user-question,subagent}` (`claude-code 2.1.238`). Curated, redacted examples: `claude-fixtures/bb-control-protocol-examples.jsonl.txt`.

- `control_request` subtypes observed across all recorded cells: `can_use_tool`, `hook_callback`, `initialize`, `mcp_message`, `set_permission_mode`. Only `can_use_tool` is in the plan's current mapping (below); `hook_callback` and `mcp_message` are Claude's own hook/MCP plumbing and `set_permission_mode`/`initialize` are session bootstrap, none currently projected into Oompa's provider-neutral interaction model.
- `can_use_tool` request: `{type:"control_request", request_id, request:{subtype:"can_use_tool", tool_name, display_name, input, description, permission_suggestions:[{type:"addRules"|"addDirectories", rules?, directories?, behavior?, destination}], decision_reason_type?, blocked_path?, tool_use_id, requires_user_interaction?}}`. `permission_suggestions` carries candidate persistent-allow rules the *user* could pick, not a grant; `blocked_path` appears when a filesystem boundary caused the ask. `requires_user_interaction: true` was observed set on the `AskUserQuestion` request and is otherwise absent (falsy by omission) on a plain `Bash` ask.
- `can_use_tool` response (bridge to provider): `{type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow"|"deny", updatedInput?, toolUseID, decisionClassification?, message?}}}`. `allow` echoes (possibly edited) `updatedInput` back as the tool call's actual input; `deny` carries a human-readable `message` and omits `updatedInput`. The plan's autorespond rule (allow only at `once` scope, echoing only the verbatim input) matches this shape exactly: never add `permission_suggestions` to the response, only ever answer with the request's own `input`.
- `AskUserQuestion` is itself a `can_use_tool` call (`tool_name: "AskUserQuestion"`), input `{questions:[{question, header, options:[{label, description}], multiSelect}]}`; the allow response's `updatedInput` adds an `answers` map keyed by the literal question text (`{"<question text>": "<chosen label>"}` for single-select). There is no separate question/answer RPC pair; it is exactly the `can_use_tool` allow flow with the answers folded into `updatedInput`.
- Subagents: `system` events `task_started` (`task_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type, prompt, session_id`), `task_progress` (`task_id, tool_use_id, usage:{total_tokens, tool_uses, duration_ms}, last_tool_name`), `task_updated` (`task_id, patch:{status, end_time, ...}`, not named in the plan's ground truth but present in the wire capture), and `task_notification` (`task_id, tool_use_id, status, output_file, summary, usage`). The parent-child link the plan calls `parent_tool_use_id` is carried on the subagent's own `assistant`/`stream_event` lines (set to the spawning `Task` tool's `tool_use_id`), not inside the `task_*` system events themselves, which key by `task_id`/`tool_use_id` instead.
- Steering: mid-turn steering is a second `{"type":"user","message":{"role":"user","content":"..."}}` line sent on the same input stream while a turn is in flight, exactly as the plan states; the bb `steer` recording shows the runtime accepting a second instruction ("Stop counting now...") after the first ("Count from 1 to 40...") without a new session or turn boundary.

### Event mapping (Claude to Oompa)

| Claude event / field | Shape | Oompa event body / interaction kind | Notes |
| --- | --- | --- | --- |
| `control_request` `can_use_tool`, `tool_name: "Bash"` | see above | `command_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, `tool_name` in `{Edit, Write, NotebookEdit}` | see above | `file_change_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, any other `tool_name` (no `requires_user_interaction`) | see above | `permission_approval` interaction | Matches the plan's mapping. |
| `control_request` `can_use_tool`, `tool_name: "AskUserQuestion"`, or any `requires_user_interaction: true` | `input.questions[]` | `user_input` interaction, answered via `updatedInput.answers` | Matches the plan's mapping; this is the same envelope as the two rows above, discriminated by `tool_name`/`requires_user_interaction`, not a separate method. |
| second `user` line mid-turn on the input stream | `{type:"user", message:{role:"user", content:...}}` | `send_or_steer` command, resolved at execution time | Matches the plan's mapping. |
| `system` `task_started` / `task_progress` / `task_updated` / `task_notification`, correlated by `parent_tool_use_id` on the child's own message lines | see above | `subagent_activity` event (`started\|interacted\|interrupted` in the plan's vocabulary) | `task_updated` has no named Oompa equivalent yet; treat its `patch.status` transitions as additional `interacted`/completion signal alongside `task_notification`. |
| `assistant` (complete message) or, with `--include-partial-messages`, `stream_event` `content_block_delta` (`text_delta`) | message/content-block text | `assistant_delta` (coalesced) | Oompa's live-projection uploader (plan, "Live projection (W1)") needs `--include-partial-messages` to get true incremental deltas; without it, only whole-message granularity is available. |
| `stream_event` `content_block_delta` on a `thinking`/reasoning block (not directly observed in this capture; inferred from the Anthropic Messages streaming shape `content_block_start.content_block.type` values) | - | `reasoning_summary_delta` (coalesced, opt-in) | Not confirmed in this capture; verify the exact `content_block.type` for thinking blocks before relying on it. |
| `result` (terminating the process/turn) | see `output-json-*.jsonl.txt` | `turn_completed` / `turn_summary` | `is_error`, `stop_reason`, `terminal_reason`, `result` (text), `usage`, `total_cost_usd` map onto the plan's completion/caveat classification inputs. |
| `system` `init` | see above | session bootstrap (not a per-turn event) | Carries `model`, `permissionMode`, `claude_code_version`; useful for the daemon to confirm which preset/effort is actually active. |
| `rate_limit_event` | `rate_limit_info.{status, unifiedWindows}` | no current Oompa mapping | Candidate signal for a future budget/quota surface; out of scope for W1/W3 as planned. |
| `control_request` `hook_callback`, `mcp_message`, `set_permission_mode`, `initialize` | see above | no current Oompa mapping | Claude-internal plumbing (hooks, MCP passthrough, bootstrap); the plan's adapter does not need to translate these. |

## Compaction (shipped, `session.compact`)

Oompa compacts a live Claude session by writing one user line whose text is `/compact` on the session's stream-json input: the provider's own compaction, never transcript surgery. Verified on the pinned 2.1.270 runtime (`claude-fixtures/stream-json-compaction-2.1.270.jsonl.txt`):

- The write is admitted only while the session is open and idle; `claude/client.ts` `steer()` requires an active turn, so `compact()` is a separate idle-session user-line write that refuses `INVALID_INPUT` on a closed client or an in-flight turn.
- The runtime answers with a `system` line carrying `status: "compacting"`, then a `compact_result` fact, then a post-compact `init`; there is no restart and no argv change. On a nearly empty session it returns `compact_result: "failed"` with `compact_error`; that is a normal outcome, not a protocol error.
- The assembler reduces these facts to the shared `threadCompaction` timeline fact (`turnId: null`), which the daemon persists as a provider-neutral `compaction` event with `outcome: "completed" | "failed"` and `trigger: "manual" | "policy" | "provider"`. No transcript text enters the event.
- A compaction requested through `oompa session compact` or the per-session auto-compact policy (`oompa session compact-policy <session> on`) is recorded `outcome: "requested"` before dispatch; an indeterminate dispatch reconciles against the event stream rather than replaying.
