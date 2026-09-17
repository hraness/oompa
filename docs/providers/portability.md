# Session portability

Oompa owns a bounded, provider-neutral retained record from the point at which
the v0.6 daemon begins recording a session. On Linux, that recorded portion of
a conversation can move from Codex to Claude Code and back while it is running,
and it can be exported as a schema-valid letta-ai trajectory v1 array for tools
that accept that normalized record format.
Codex switching remains available on macOS, but a switch into Claude is refused
there until authenticated testing proves isolated Keychain custody and
detached-daemon reads without a prompt.

Before this, Oompa stored no conversation of its own. Assistant text existed only
as `assistant_delta` events, there was no record of what Oompa had sent, and
`readSession` asked the provider for its transcript: `thread/items/list` for
Codex, and an in-memory, process-lifetime message list for Claude. A session
therefore could not outlive its provider, and could not be handed to another
one.

## The neutral transcript

Three durable session events carry the conversation, and every one of them
obeys the bounds and redaction rules that already governed the event stream
(`SESSION_EVENT_MAX_BYTES`, `containsAbsolutePath`, the secret patterns, and
the projection's `forbiddenDetailKeyPattern`).

- `user_message`, the bounded text Oompa sent to the provider, with the actor that
  authored it: `human`, `automation`, `autorespond`, `peer_session`, or `provider_switch` for a
  handoff seed.
  It is written after the provider accepted the message, so the transcript
  never claims Oompa sent something the provider rejected. Text is capped at
  16,384 characters and the remainder is stated as an exact
  `omittedCharacters` count. A message with attachments includes only a bounded
  manifest (safe name, media type, byte length, and SHA-256); attachment bytes
  remain in local blob custody and are never embedded in the ledger or handoff.
- `item_started` / `item_completed`, already carried the item kind, MCP server,
  tool name, and status. They now also carry `callId`, the stable opaque
  identity a result binds back to its call, and `summary`, a bounded one-line
  label. The summary is assembled only from values the protocol layer already
  reduced to safe labels: the item kind, the server and tool names, and the
  closed-vocabulary command class (`git commit`, `bun test`, `command`) that
  the command-approval display has always used. **A raw tool argument or a raw
  tool output is never stored**, so neither is ever in the transcript.
- `provider_switched`, the boundary record: the providers and presets moved
  between, whether the account changed, the digest of the neutral transcript,
  the digest of the seed the target provider was given, and how many records
  that seed omitted. If older ledger history had already been pruned, the event
  also records the retention-gap reason; the number of unavailable older
  records is unknowable and is never folded into the exact omission count.

`src/domain/transcript.ts` reads those events back into an ordered, bounded
conversation with a SHA-256 digest over its canonical serialization. It
is the one artifact the switch and the export both consume. Its record kinds
are `user`, `assistant`, `reasoning`, `tool_call`, `tool_result`, and
`provider_switch`. Assistant and reasoning deltas are coalesced per item; a
tool result is paired with its call by `callId`; an item whose kind is
conversation (`agentMessage`, `reasoning`, `subAgentActivity`, and so on) is
not treated as a tool call, and an unfamiliar kind is, so an unknown call is
recorded rather than dropped.

The event ledger retains at most 50,000 events, 64 MiB, and seven days per
session. When any limit prunes a prefix, transcript tails and JSON exports carry
`retentionGapReason`; no surface invents a count for the unavailable prefix.
Ordinary transcript reads and the latest tail used by switching and export ask
for at most 500 records. A result may contain fewer records when its serialized
transcript must fit the daemon's 4 MiB local response envelope, which reserves
64 KiB for response wrapping. A head page keeps the oldest records that fit and
returns an exclusive `after` cursor immediately before the first omitted
record. A tail keeps the newest records, reports the exact number additionally
omitted from retained history, and has no continuation cursor.

That retention marker does not describe an origin boundary. An adopted
personal-home session does not import provider history from before Oompa admitted
it, and a session upgraded from v0.5 has no synthesized `user_message` or
`provider_switched` events for its pre-v0.6 turns. Those older provider/local
records may still exist on their original surfaces, but they are absent from
the neutral transcript, their size is unknown, and the current
`retentionGapReason` does not mark that absence.

Nothing in the reader talks to a provider. A session whose provider thread is
gone, whose provider runtime is not installed, or that has already switched
still has a readable conversation.

## Switching provider

```
oompa session switch <session> --provider codex|claude [--preset <preset>] [--account <account>] [--idempotency-key <uuid> [--preset-contract <1|2>]]
```

`--preset-contract` is valid only when paired with an explicit
`--idempotency-key` for a source-sensitive Codex switch. When that key already
names a request, both values are immutable replay identity. When the key has no
stored row, only the current build's active contract may authorize the one
fresh request; this option cannot select a retired route. A stable switch replay
uses `--idempotency-key` alone and rejects `--preset-contract`.

In order, a switch:

1. refuses a switch it cannot make safely (below);
2. builds the neutral transcript and renders the bounded handoff seed from it;
3. writes immutable mutation evidence that fences the exact source and target
   account generations, then reviews and starts a thread on the target;
4. records the exact target-thread receipt, writes an immutable seed intent,
   sends the seed as the first user message of the target thread, and records
   the returned turn and status. The seed uses the switch attempt id as its
   provider client-message id, so recovery can prove zero, one, or duplicate
   acceptance without inventing a retry;
5. releases the outgoing provider's hold on the thread through `endSession` on
   the neutral runtime port, then records an immutable source-release receipt.
   This stops the pinned Claude Code process that served the session and is a
   documented no-op for Codex, whose app-server owns thread lifetime. The
   outgoing thread is **never deleted**;
6. atomically rebinds the provider, account, preset, provider thread, reviewed
   runtime profiles, and conversation-automation row; appends the
   `provider_switched` boundary and the seed's `user_message` event; and stores
   the replay receipt.

Store schema v35 adds the append-only target, seed-intent, seed-result,
source-release, target-release, and authority-rebind records behind that
sequence. After a crash, Oompa advances only from durable evidence and a complete
provider projection. It never repeats an unproven target-start or seed effect.
Before the seed result exists, abandonment may release the addressable target
and retain the source. After the target is seeded, Oompa preserves it until it can
prove the source release and complete the atomic rebind; it does not discard the
only provider that is known to contain the handoff.

Every new switch receipt also names the daemon generation that admitted its
provider effects. Claude sessions exist only in the runtime manager that
started their isolated CLI process, so an unreleased Claude source or target
cannot be read, resumed, or released after that generation changes. In that
case `oompa session recover` returns `RECOVERY_REQUIRED` without starting,
seeding, ending, or otherwise probing either provider. Only an explicit
`oompa session abandon` settles the local authority: it terminalizes the session
with provider-state-unknown evidence, never calls the inaccessible Claude
side, and narrows what remains unknown only by observing an addressable Codex
source or releasing an addressable Codex target. It never reports all provider
state deleted while an unreleased Claude side remains unknown. A durable
Claude source-release receipt is sufficient for recovery to inspect and adopt
a seeded Codex target after restart; durable rows alone cannot prove a seeded
Claude target is still live.

A switch is refused, with no effect, when:

- a turn is active, the turn would be stranded on the outgoing provider with
  no way to attribute its result. Stop it with `oompa session stop` first;
- the session is quarantined or terminal;
- the requested preset is not one the target provider can run (`low` on
  Claude or Devin, `fable-max` on Codex or Devin, and `astra` on Codex or
  Claude). With no `--preset`, the switch keeps the session's tier when the
  target has one and otherwise takes the target's highest;
- the target is Claude and the custodian daemon is not running on Linux;
- `--account` selects another Oompa profile after the session has acquired its
  working-memory authority. Oompa does not transfer that account-bound working
  lane in this release, so it refuses before either provider is touched. A
  same-profile Codex, Claude Code, or Devin switch remains supported;
- the session already runs that provider, preset, and account.

### What a switch preserves, and what it cannot

**Preserved:** the retained conversation as Oompa saw it, what was asked, what the
assistant said, what its reasoning summaries said, which tools were called and
whether they succeeded, and the switch boundary itself. Also the session's
identity, its project, its note, its title, its queue, its session tasks, and
its event stream; the session id never changes.

The session's expiring working-memory authority is also preserved when the
provider changes inside the same Oompa account profile. Its current-project
canonical memory is project-scoped and is selected again through the same Oompa
coordinator. Cross-account working-memory transfer is not implemented; start a
new session under the target account instead.

**Not preserved, and not recoverable:**

- the provider's own hidden state, Codex's server-side thread, Claude's full
  reasoning traces, and Devin's provider-private ACP state, none of which Oompa
  ever stored;
- the provider's native thread. Codex `thread/resume` takes only a thread id,
  and the pinned Claude CLI's `--resume` takes only its own session id and
  cannot import a foreign transcript. Neither provider can be handed the
  other's thread, so the target starts a genuinely new one;
- cached context and prompt-cache warmth. The target pays full context cost for
  the seed;
- anything the redaction rules removed on the way in: secrets, absolute paths,
  raw tool arguments, raw tool output. These were never stored and cannot
  reappear;
- attachment contents. Only the byte-free manifest described above can cross a
  provider handoff or trajectory export;
- provider history from before Oompa admitted an adopted personal-home session,
  and pre-v0.6 user messages or switch boundaries in an upgraded session. Oompa
  does not backfill either origin prefix into the neutral transcript, and the
  current retention-gap field does not mark it;
- any ledger prefix removed by the seven-day, 50,000-event, or 64-MiB retention
  limits. A switch and export disclose the retention-gap reason, but the number
  of removed records is not recoverable;
- turn ids and item ids from the old provider. They remain in the transcript as
  opaque identifiers, but they mean nothing to the new provider.

### The seeding rule

The seed is one user message, and it is built only from records that already
passed Oompa's redaction. It opens with the literal header
`[Oompa provider handoff]`, states which provider the conversation ran on and
which it now runs on, states plainly that this is Oompa's own record rather than
the previous provider's transcript, and instructs the model to ask rather than
assume anything the summary does not state. It states the exact number of
otherwise-retained records omitted by the 500-record and 24,576-character
bounds. If the ledger had already pruned older history, the header separately
warns that earlier records are unavailable and their count is unknown.
It cannot warn about a pre-admission or pre-v0.6 origin prefix because that
prefix was never in the Oompa ledger and has no current gap marker.

It is capped at 24,576 characters. When the transcript does not fit, the
**most recent** records are the ones kept: a handoff needs the end of a
conversation more than its beginning. The exact retained-tail omission count,
any retention-gap reason, and the seed's digest are recorded on the
`provider_switched` event, so the bounded text the new provider was told and
the known-versus-unknown history boundary are provable after the fact.

Codex and Claude Code start with Oompa's current static preamble and closed
host-tool binding. The initial Devin ACP adapter does not bind either surface in
this release, so a switch to Devin transfers the bounded handoff seed as an
ordinary text prompt only. The owner can still use Oompa's memory and policy CLI
against that session. Devin accepts a new message while idle and a durable
queued message for later delivery, but ACP v1 has no unambiguous in-turn steer;
`oompa session steer` therefore refuses an active Devin turn without an effect.

## The remote surface

`set_provider {provider}` for Claude, `set_provider {provider:
"codex", presetContract}` when the target Codex preset is daemon-derived,
`set_provider {provider, preset}` for an unchanged explicit alias, or
`set_provider {provider, preset, presetContract}` for explicit rebound Codex
`high | ultra` sits alongside `set_model` in the hosted command union
(`convex/validators.ts`, `src/cloud/contracts.ts`, `src/cloud/payloads.ts`), and
the journal, bridge lane, and local-control parser all derive their closed
unions from that one list.

When a remote command explicitly selects the rebound Codex `high` or `ultra`
alias, `presetContract` is required and must equal the receiving daemon's active
immutable binding for that alias. Missing or stale tokens are refused before a
provider effect, so a browser or CLI from one side of a Sol/Astra rollout cannot
silently change the meaning selected on the other side. A preset-omitted switch
to Codex carries the same fence because the daemon derives High or Ultra from
the source tier; the active High and Ultra aliases must share one contract for
that shape to be produced or admitted. Explicit stable `low` and `fable-max`
aliases, plus preset-omitted Claude switches, retain their exact token-free
shapes.

Local provider switches use an equivalent conditional build fence in the
strict CLI-to-daemon request envelope. It is present for explicit High or Ultra
and for a preset-omitted target of Codex, where the persistent daemon derives a
possibly rebound alias from the source tier. Stable explicit presets and
preset-omitted Claude targets remain token-free. The build fence is
checked before the internal `session.switch` command reaches provider-effect
handling, so a CLI and an already-running daemon from opposite sides of the
mapping change cannot silently disagree. The command also carries a separate
caller-authored source contract beside its generated idempotency key, and both
are returned for uncertain replay. The resolved High or Ultra contract is part
of the durable switch request identity. A prepared switch from an older
mapping cannot resume under the newer meaning after restart; stable target
presets retain their earlier digest shape. Only a source-matched, exact-key
settled replay returns its historical result without repeating a provider
effect. Reusing the key with another request identity is a conflict.

Unlike the settings commands, a provider switch is a provider effect, not local
state, so `src/cloud/daemon-adapters.ts` routes it onto the ordinary execution
path as a `session.switch` command under the same execution lease as a turn.

The payload deliberately has no account field. Account selection is
user-directed and stays on the machine that holds the credentials; a remote
switch keeps the session's account.

`oompa remote provider <cloud-session> <codex|claude> [--preset <preset>]` is the
CLI form. The custodian daemon applies the same Linux-only admission rule to a
remote switch into Claude; the browser cannot widen platform support.

## Exporting a trajectory

```
oompa session export <session> [--format trajectory|json] [--out <path>]
```

`--format json` writes Oompa's own neutral transcript. `--format trajectory`
(the default) writes the letta-ai trajectory v1 shape. With `--out`, the path
must not already exist. Oompa creates one new mode-`0600` file and refuses an
existing file or symlink; use a path inside a current-user-owned private
directory and remove it when it is no longer needed.

Without `--out`, Oompa writes the complete document to standard output. Use that
only with a controlled pipe. Terminal scrollback, command capture, and shell
redirection can disclose conversation content, and shell redirection does not
inherit Oompa's private-mode, no-overwrite file checks. Prefer `--out` when
keeping an export.

**Upstream is import-oriented.** `@letta-ai/trajectory` and its
`schema/trajectory-v1.schema.json` exist to normalize many agent harnesses'
native logs *into* that shape; the package does not convert back out of it.
Oompa's runtime emits the shape without calling that normalizer. Development
pins `@letta-ai/trajectory` 0.3.0 and validates representative output against
the JSON Schema and `validateTranscript(..., { partial: true })` runtime
validator exported by that exact package. Partial mode is deliberate: a bounded
retained tail may lack a user or assistant turn, and it may retain a tool result
whose call fell outside the tail. Validation still enforces exact fields,
timestamps, JSON-object argument strings, and unique tool-call ids. This proves
the normalized document contract, not a round trip to a provider-native log or
acceptance by every downstream tool. The mapping below is Oompa's, and
`src/domain/trajectory.ts` is its runtime implementation.

| Neutral record | Trajectory record | Notes |
| --- | --- | --- |
| (none) | `meta` | Always first and exactly `{ "role": "meta", "source": "oompa" }`. Trajectory v1 forbids Oompa-specific extension fields on this record. |
| Oompa export context | `observation` | Always second. Its `content` is an Oompa-defined JSON string containing `hra_export_context: 1`, `session_id`, `provider`, `transcript_digest`, `omitted_records`, and optional `retention_gap_reason`; its `timestamp` is the export time. These are text inside a standard observation, not trajectory v1 properties. |
| `user` | `user` | `role`, `content`, `timestamp`. Automation and autorespond messages are explicitly prefixed; a handoff seed keeps its own `[Oompa provider handoff]` header and is not labelled twice. Attachment manifests are appended, but contents are not embedded. |
| `assistant` | `assistant` | `role`, nonempty `content`, `timestamp`. A zero-length Oompa assistant event becomes the explicit marker `[oompa] assistant message was empty` because v1 forbids empty assistant prose. |
| `reasoning` | `reasoning` | `role`, `content`, `timestamp`. The content is the provider's reasoning summary, which is all Oompa ever stored. |
| `tool_call` | `assistant` | `content` is `null`; `tool_calls` contains one entry whose `id` is deterministically derived from the provider, turn id, event sequence, and neutral call id, whose `name` is `server/tool` or the item kind, and whose `args` is a stringified JSON object. This keeps ids unique when providers or turns reuse a native id. |
| `tool_result` | `tool` | `tool_call_id` links to that deterministic export id when the call is inside the same provider segment of the bounded export. A tail can begin after the call and retain only its result; partial-mode validation deliberately permits that orphan. `ok` is present only when the provider's status classifies; `content` says the output was never retained. |
| `provider_switch` | `observation` | States the providers, presets, whether the account changed, and the seed digest. |

`args` deserves a note. The format requires a string, and Oompa holds no raw
arguments because it never stored them. Rather than invent provider input, Oompa
emits a stringified object that states exactly what it does hold:
`{"hra_arguments_retained":false,"item_kind":"...","server":"...","tool":"...","summary":"..."}`.
Optional keys are absent when Oompa did not retain them. A consumer can therefore
distinguish an Oompa tool call from one captured with real arguments.

Event-derived records use ISO 8601 timestamps from their recorded time; the Oompa
export-context observation uses export time. Export reads one latest bounded
retained tail and never asks a provider, so a session whose provider is gone
still exports. Oompa JSON exposes typed `retentionGapReason` and `omittedRecords`
fields. In a trajectory document, the corresponding Oompa-only values are inside
the export-context observation's JSON text, not the trajectory meta record.
`omittedRecords` / `omitted_records` counts only known records dropped from the
retained tail, never an already pruned prefix whose size is unknown. Neither
format signals provider history from before personal-session admission or user
turns from before the v0.6 neutral event types existed.
