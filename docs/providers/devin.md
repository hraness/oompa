# Devin integration

Devin is not yet a supported Oompa provider. The daemon does not construct the
Devin runtime, the service does not select it, and the CLI parser refuses Devin
operations, so Oompa does not launch Devin sessions, resume them, offer Devin in
provider selection, or execute a Devin turn. The retired runtime records below
remain read-only.

## Runtime adapter

Current source contains the restored Devin runtime under `src/devin/` and
`src/daemon/devin-runtime-adapter.ts`, the second phase of the plan in
`kb/plans/devin-provider.md`. It speaks ACP v1 over `devin acp --model gpt-6-astra`
on the same pinned CLI as the quota reader, frames every JSON-RPC line itself
with a byte bound, and projects agent text, tool calls, plans, context usage,
permission requests and stop reasons into Oompa's neutral session facts. Each
managed profile runs in an isolated HOME and XDG home; Oompa never reads the
credentials file, projects `devin auth status` to one readiness bit, and runs
the interactive `devin auth login` in the foreground with terminal-signal
custody.

The adapter implements the provider-neutral `SessionRuntimePort` with
provider-account authority at every boundary and reviews a runtime profile
pinned to CLI `3000.10.27`. That document is not yet admitted by storage,
cloud sync or the browser: the third phase adds it with an append-only
migration and lifts the retired-provider refusals. Attachments and in-turn
steering are refused by the adapter, as in the original integration, and
Devin's persistent always-allow permission is never mapped to an Oompa session
scope.

## Quota reader

Current source contains a credential-free quota reader in `src/devin/`. It is
the first phase of the reactivated plan in `kb/plans/devin-provider.md` and is
not wired into the daemon, CLI, storage, or cloud sync.

The reader depends on the pinned official Devin CLI, exactly `3000.10.27`, and
refuses any other reported version. It launches that CLI on a pseudo-terminal
in a caller-supplied directory with `--respect-workspace-trust false`, waits for
the input prompt, types `/usage` and Enter, waits for the quota line, then
types `/exit` and Enter. It never submits a prompt, so it cannot spend a model
turn. Output is bounded to 256 KiB and the child is killed when it does not
exit within the deadline.

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

## Existing local data

The v39 migration and historical provider tags remain readable. Oompa preserves
existing Devin sessions, transcript events, usage facts, reviewed runtime
profiles, and unsettled authority records. It never treats a historical Devin
row's legacy Codex shadow column as Codex execution authority. Retired sessions
are read-only and cannot accept turns, approvals, scheduled work, or provider
switches.

Oompa does not delete or inspect existing provider-owned credentials or profile
directories. It no longer creates Devin HOME or XDG directories for new
profiles. Removing Oompa's integration does not uninstall a separately installed
Devin CLI.

## Unsettled login cleanup

A historical foreground login grant remains a safety fence until explicitly
resolved. Inspect it locally:

```sh
oompa account show <profile> --provider devin --json
```

This reports retirement and any exact pending launch fence, without launching
Devin or reading authentication. If a grant remains, first confirm its original
child exited. Then run the exact `abandonCommand` returned by inspection. The
cleanup-only command binds the account, attempt, idempotency key, and provider
generation and requires `--acknowledge-child-exited`.

Abandonment releases only Oompa's local login fence. It does not kill a process,
prove sign-in, retry an effect, or read, change, or delete credentials. Uncertain
session effects remain recorded; removal does not invent successful completion.
