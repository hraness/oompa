# Devin provider

Status: current source drives the official local Devin CLI through Agent Client
Protocol (ACP) v1. Oompa admits exactly Devin CLI `3000.10.27`. The `devin`
executable must already be on the daemon's `PATH`; Oompa resolves its real path,
reads its exact self-reported version, and refuses a different version before a
provider session starts.

Oompa starts each admitted session with this exact provider command:

```text
devin acp --model gpt-6-astra
```

`astra` is Devin's only Oompa preset and the default when `--provider devin` is
used without `--preset`. The effective profile records model
`gpt-6-astra`, reasoning effort `provider-default`, Devin CLI `3000.10.27`, and
ACP protocol version 1. Devin exposes no separate Oompa Fast tier, so `--fast`
is refused instead of ignored.

Codex uses separate provider profiles and presets. Its `high` and `ultra`
presets also select `gpt-6-astra`, with `max` and `ultra` reasoning
respectively. A matching model name does not share authentication, native
sessions, usage, or provider authority between Codex and Devin.

## Account isolation and sign-in

Install the exact supported Devin CLI by following the [official Devin CLI
guide](https://docs.devin.ai/cli), then verify the version before asking Oompa to
use it:

```text
devin --version
oompa account login <profile> --provider devin
```

The login command requires a foreground terminal. Oompa launches `devin auth
login` and gives that exact child the terminal. To request Devin's own manual
token flow, use:

```text
oompa account login <profile> --provider devin --manual-token-flow
```

That option launches `devin auth login --force-manual-token-flow`. Oompa does not
accept `--device-code`, `--handoff-file`, JSON mode, or web account linking for
Devin.

The web account registry shows Devin only after a bounded background status
observation. Unknown or expired observations omit the Devin row; they never
borrow Codex's sign-in state. A slow Devin status command does not block
unrelated Codex commands or settings changes.

Each Oompa profile gives Devin five distinct private directories:

- `HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `XDG_CACHE_HOME`
- `XDG_STATE_HOME`

The child receives an allowlisted environment with those five values replaced.
Devin owns every provider-private file in that boundary, including
`$XDG_DATA_HOME/devin/credentials.toml`. Oompa never opens, parses, copies, or
uploads that credential. It runs the bounded `devin auth status` command inside
the same isolated boundary and reduces the result to `signedIn` only.

When the foreground login child exits, Oompa runs that bounded status command
once under the login's exact authority and records the readiness it observed on
the Devin provider account. A replayed login receipt and a launch that provably
never started record nothing. Devin owns its own account process generation,
separate from the Codex profile generation: `oompa account show <profile>
--provider devin` reports that Devin generation, and a Devin session start
advances only that fence.

If the foreground Oompa parent or daemon fails after granting a login launch,
`oompa account show <profile> --provider devin` reports the exact unsettled
attempt. Confirm that the original child has exited before running the complete
acknowledged `oompa account login-cancel` command returned by status. That command
releases only Oompa's local launch fence. It does not stop Devin or read, change,
or delete a credential. Oompa does not implement Devin sign-out; perform that
operation with Devin inside the same isolated five-directory boundary.

## Sessions and protocol limits

Oompa uses `initialize`, `session/new`, `session/prompt`, session updates,
permission requests, and `session/cancel`. It uses `session/load` after a
restart only when Devin advertises that ACP capability. The provider owns the
native session, tool execution, permissions, model behavior, and hidden state.
Oompa stores only its bounded provider-neutral transcript, lifecycle, interaction,
and usage facts. ACP `agent_thought_chunk` content is raw reasoning rather than
a provider-certified summary, so Oompa drops it at the provider boundary.

ACP's remembered allow and reject choices are provider-persistent, not scoped
to one Oompa session. Oompa therefore exposes only one-time allow, one-time deny,
and cancel decisions; it never presents a remembered choice as session scope.

ACP v1 has no in-turn steering method. `oompa session steer` therefore refuses an
active Devin turn. Use `oompa session queue` to send the message after the current
prompt completes, or stop the turn before sending another message. Oompa never
sends two concurrent prompts to one Devin session. The initial Devin adapter is
text-only, so it also refuses attachments.

## Usage and limits

An ACP `usage_update` reports current context occupancy as `used` and context
capacity as `size`. Oompa records those supplied values as session usage. If
Devin also supplies a cumulative session cost with an amount and ISO currency,
Oompa records that provider cost as supplied. Neither value is interpreted as an
account allowance, remaining balance, billing settlement, or reset window.

ACP v1 and `devin auth status` expose no documented machine-readable account
allowance, remaining balance, reset time, or reset-credit operation. Oompa
therefore reports Devin account allowance as `unknown` with source `devin_acp`.
It does not submit the human-facing `/usage` or `/session-stats` commands as
hidden model turns. Explicit provider quota or credit refusals remain bounded
provider errors. Oompa never invokes a Codex reset credit for Devin and never
rotates to another account or provider to evade a limit.

## Quota reader

Current source also contains a credential-free quota reader in `src/devin/`. It
is the first phase of the reactivated plan in `kb/plans/devin-provider.md` and
is not yet wired into the daemon, CLI, storage, or cloud sync, so session and
account reporting still use the ACP facts described above.

The reader depends on the same pinned official Devin CLI, exactly `3000.10.27`,
and refuses any other reported version. It launches that CLI on a
pseudo-terminal in a caller-supplied directory with
`--respect-workspace-trust false`, waits for the input prompt, types `/usage`
and Enter, waits for the quota line, then types `/exit` and Enter. It never
submits a prompt, so it cannot spend a model turn. Output is bounded to 256 KiB
and the child is killed when it does not exit within the deadline.

The panel is a human-facing surface, not a published contract. The parser
recognizes only the lines captured on the pinned build: the startup banner
(`v3000.10.27 · Max · 100% remaining (resets in 3d 13h)`), one `Weekly` line
and one optional `Daily` line in the form
`Weekly  ■■■■  0% used  · resets Sep 20, 4:00 AM (UTC-4)`, and an optional
`Extra usage  $12.50 remaining` balance line. The `Daily` line is absent on Max
plans, which the observation reports as `dailyShown: false`. Remaining percent is
`100 - used`. The panel prints no year, so the reset instant is the first
occurrence of that date and clock time, in the printed UTC offset, at or after
two days before the observation; the observation records that rule and the
exact rendered text beside the instant.

Any other shape, a repeated line with different values, a percent outside 0 to
100, an impossible date, a banner from another version, or the workspace-trust
prompt yields an `unknown` observation with a closed reason. The reader retains
only the parsed observation and the exact `devin --version` line. It never
reads, copies, logs, or forwards `~/.local/share/devin/credentials.toml` or a
session identifier.

The captured fixture and its synthetic variants live in
`src/devin/usage-panel.fixture.json` and are excluded from the package. Re-pin
by re-capturing that fixture on the new build and updating `src/devin/pin.ts`.

Devin's supported CLI and ACP interfaces still expose no machine-readable
allowance, and Oompa uses no undocumented network endpoint for this read. See
the [CLI reference](https://docs.devin.ai/cli/reference/commands) and
[usage documentation](https://docs.devin.ai/admin/billing/usage).

### The `devin_usage_panel` source

`src/domain/devin-usage-source.ts` names the one source this reader feeds,
`devin_usage_panel`, and holds its closed codec. An observation carries the
exact `devin --version` line, the weekly and optional daily used and remaining
percent, each window's resolved reset instant together with the year-less text
the panel rendered, and the reader's exact `unknown` reason when the grammar
refuses. A reading the codec cannot admit becomes `unknown` with
`quota_line_ambiguous`; it is never reduced to a partial value.

The source is deliberately **not** a member of `providerUsageSourceSchema` in
`src/domain/provider-usage.ts`. That enum is the persisted and hosted usage
vocabulary, and its values reach `provider_usage_observation_receipts`, the
cloud usage payloads and the browser. A Devin panel observation reaches none of
those: its binding is `local_only` with `persisted: false`, so no stored table,
no hosted payload and no browser surface holds one, and no hosted data surface
or cost entry is registered for it. `oompa account show` renders only the source
name, as `Usage source: devin_usage_panel (local only, not stored)`, because
naming a source is not observing one: that line carries no percentage, reset
instant or allowance. Persisting an observation needs a registered data surface
and its cost entry, which is separate work.

## Existing local data

The v39 migration and historical provider tags remain readable. Oompa preserves
existing Devin sessions, transcript events, usage facts, reviewed runtime
profiles, and unsettled authority records. It never treats a historical Devin
row's legacy Codex shadow column as Codex execution authority. Sessions created
during the 2026-09-06 removal era may carry an inert `retiredProvider: "devin"`
metadata marker; the marker still parses and keeps the session's name and note,
and it grants and withholds nothing. Schema 61 removed the blanket
`retired_provider_*` refusal triggers, so those rows are governed by the same
ordinary authority guards as every other session rather than by a separate
retired fence.

Oompa does not delete or inspect existing provider-owned credentials or profile
directories. New profiles receive their own isolated Devin HOME and XDG
directories as described above; uninstalling a separately installed Devin CLI
remains the owner's operation outside Oompa.

## Unsettled login cleanup

A historical foreground login grant remains a safety fence until explicitly
resolved. Inspect it locally:

```sh
oompa account show <profile> --provider devin --json
```

Abandonment releases only Oompa's local login fence. It does not kill a process,
prove sign-in, retry an effect, or read, change, or delete credentials. Uncertain
session effects remain recorded; removal does not invent successful completion.

## Upstream references

- [Devin CLI overview](https://docs.devin.ai/cli)
- [Devin CLI command reference](https://docs.devin.ai/cli/reference/commands)
- [Devin CLI models](https://docs.devin.ai/cli/models)
- [Devin authentication](https://docs.devin.ai/cli/enterprise/devin-auth)
- [Devin ACP integration](https://docs.devin.ai/cli/acp)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/introduction)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)

The installed CLI has passed a zero-token compatibility check in a disposable
isolated profile: exact version `3000.10.27`, signed-out status, Astra launch,
and ACP v1 initialization with session loading advertised. The protocol reducer
and runtime manager also have deterministic fixture coverage. One bounded paid
turn on 2026-09-17 in a disposable isolated profile gave live proof for the
turn, tool-call and usage-update paths; its sanitized record is in
`kb/plans/devin-provider.md`. The permission and in-flight cancellation paths
remain fixture-verified only, because that turn requested no permission and
the session was idle when stopped.
