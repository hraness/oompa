# Oompa local efficiency plugin

The repository marketplace distributes `oompa-local-efficiency`, a local-only Codex plugin for managed Codex and Claude Code approval defaults, repository delivery guidance, machine-wide heavyweight-command scheduling, capability lanes, privacy-safe throughput telemetry, validation ownership, complete-history CI ref audits, stale-task review, and guarded worktree cleanup. It preserves useful agent fan-out and every repository final gate while avoiding unnecessary approval and checkout churn. It does not configure or route cloud execution.

The plugin is separate from the published `@hraness/oompa` package. Install the repository marketplace and plugin on each development machine. The marketplace checkout includes the complete `plugins/` directory so it can also distribute the separate [Oompa Cloud efficiency plugin](cloud-efficiency-plugin.md):

```sh
codex plugin marketplace add hraness/oompa --ref main --sparse .agents/plugins --sparse plugins
codex plugin add oompa-local-efficiency@hraness
```

Start a new Codex task after installation so Codex discovers the skill. Ask it to install the Oompa local efficiency baseline on the Mac. The skill applies marker-bounded global Codex and Claude guidance, sets Codex to on-request approval with automatic review and the workspace permission profile, and sets Claude Code to Auto mode with its built-in classifier defaults retained after a capability probe succeeds. When entering Auto mode it removes bare or universal whole-tool allows and every wildcarded Bash or PowerShell allow such as `Bash(gh *)`, because explicit allow rules resolve before Auto's classifier; exact command rules, path-bounded non-shell rules, and every deny remain in the configuration. Claude may apply its own additional runtime filtering when Auto starts. It installs the scheduler, report, audit, and optional worker-profile commands, verifies a minimal private scheduler runtime, and adds one marker-bounded prompt rule under the Codex rules directory for the absolute installed `oompa-host-run` command. Unrelated TOML, JSON, Markdown, rules, and global Bun packages remain unchanged.

This baseline records the user's standing authority once: task-owned commits, pushes, pull requests, merges, tags, releases, deployments, and verification proceed through the gates applicable to that action without another conversational confirmation. Relevant automated checks, bounded diagnostics, and independent review establish confidence; another human approval is not a substitute for missing evidence. Passing checks does not expand task scope or authority.

The 0.4.2 guidance prefers agentic service provisioning: use a suitable native Vercel Marketplace product first, with Stripe Projects as a supported alternative. A third-party account connection is not evidence that a catalog can create the required resource. Inspect current capabilities and costs, preserve existing resources, and use the supported provider CLI or API when neither catalog fits. The [service provisioning guide](service-provisioning.md) describes route selection, private credential handling and separate operational acceptance. The plugin distributes this preference through its global and repository guidance; it does not provision services or hold provider credentials.

Artifact admission, live qualification, and operational activation are separate decisions. Applicable automated source, security, package/install, and provenance evidence can admit an artifact without live provider qualification. Live proof is not a universal publication prerequisite, but explicit live acceptance criteria and claims that depend on live evidence still require it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation. Operational activation retains its applicable identity, target, capacity, migration, and recovery guards. Report which evidence applies without claiming that artifact publication proves live behavior or operational deployment.

An obsolete gate can be replaced through a reviewed source and policy change with corresponding tests, never skipped ad hoc. The baseline does not bypass runtime-enforced approvals, access controls, branch or environment protection, or safety policies. Ask for user input only for a material product decision, missing credentials or authority, unavoidable interactive authentication, an out-of-scope destructive action, or a failure that cannot be handled safely and autonomously.

The 0.4.1 policy makes data preservation part of autonomous delivery. Before a production write, inspect the exact account, environment, deployment, and data target. For data changes, inspect a dry run or equivalent migration plan and validate recovery before an effect that could lose or corrupt data. Prefer additive migrations and bounded batches, record mutation intent, and use idempotency or conditional writes. Reconcile an uncertain result before retrying. Delivery finishes with deployed-identity, health, and relevant data-invariant readback. A routine deployment never authorizes resetting, truncating, dropping, or overwriting user data.

Stable publication and production promotion use supported workload identities without recurring conversational approval. Establish machine authority once and prove it with a non-publishing preflight where available. Account 2FA and provider-required approval of an exact staged artifact remain binding; changing a package declaration or coordinate to evade that control is not an autonomy improvement.

The 0.4.3 global policy makes verified immutable GitHub Release artifacts canonical for eligible public packages, independently of optional exact-byte npm mirrors. Prefer OIDC where provider policy permits, retain required staged approvals, and preserve private-package access boundaries. This update changes the managed global guidance; the managed repository policy retains the 0.4.2 provisioning preference unchanged.

Merge queues and additional approval stages need a demonstrated coordination or safety purpose. Required checks on the current integration candidate, independent agent review, and atomic or conditional integration can provide the needed evidence without another queue. Replace redundant serial waits or repeated checks through the reviewed policy path and verify the integrated result. This guidance does not change live branch protection by itself.

The host rule deliberately uses `prompt`, never `allow`: `oompa-host-run` can carry arbitrary child argv. A top-level scheduled command must therefore keep the absolute wrapper and complete child command visible while requesting reviewed host access. Codex auto-review can review that boundary without a human pause, but neither the rule nor auto-review expands the sandbox by itself. Codex loads configuration and rules at task startup, so start another new task after bootstrap installation or update.

Claude Code Auto mode requires Claude Code 2.1.83 or later and an eligible account, model, and organization setting. Before any write, the bootstrap checks the CLI version and requires `claude auto-mode config` to return a bounded valid configuration. That command proves the local CLI/configuration surface, not account, model, or organization eligibility; Claude Code enforces those conditions when a session starts. The managed `autoMode.environment` contains only `$defaults`, so upstream safeguards update without globally treating sibling Hraness repositories or the public npm registry as internal. The permission migration is applied only when that capability probe succeeds; otherwise bootstrap leaves the ordinary mode and its allow rules untouched and reports why. If the runtime eligibility gate refuses Auto mode, use the ordinary permission mode; never substitute bypass permissions.

Inspect the complete machine baseline without changing it:

```sh
oompa-local-efficiency --json
```

The doctor reports the Codex and Claude guidance/configuration drift, command links, pinned scheduler runtime, and Claude Auto-mode CLI/configuration capability. Run `oompa-workspace-audit` separately for repository adoption state and `oompa-session-audit` for privacy-safe interruption evidence.

If a sandboxed or incompletely permitted wrapper reaches machine-wide state, it fails before child execution with `OOMPA_HOST_ACCESS_REQUIRED` and exit 77. Retry that identical wrapper invocation once with reviewed host access. Do not run the child directly, delete scheduler or Oompa recovery locks, or weaken fail-closed custody. A repeated exit 77 is a permission-configuration failure to diagnose, not cleanup authority.

Use the compute lane for ordinary scheduled work. Use one `browser-auth` owner for authenticated browser, fixed-port dev-server, or Chromium work, and use `mac-native` only for work that actually requires macOS:

```sh
oompa-host-run --mode=heavy --lane=compute --label=repo-check -- bun run check
oompa-host-run --mode=exclusive --lane=browser-auth --label=browser-suite -- bun run test:e2e
oompa-host-run --mode=heavy --lane=mac-native --label=native-check -- xcodebuild test
```

For Oompa's own local aggregate, use `--mode=exclusive --lane=compute` with the unchanged `bun run check` child. Its package-command tests exercise the machine-wide process-recovery journal, so separate checkouts under two admitted heavy leases can still contend and fail with `bounded_process_recovery_journal_blocked:concurrent_invocation`. Keep that refusal and the journal intact; wait for admitted work to finish and run the converged aggregate under one exclusive lease. This Oompa-specific custody requirement does not make ordinary focused checks or independent source review exclusive. Retain complete private gate output when investigating a failure, and preserve the wrapper's exit status.

Oompa's [final validation policy](../CONTRIBUTING.md#final-validation) assigns complete required CI as the final source aggregate, including executable changes, when command coverage and shard equivalence are established. Independently review the complete diff and impact, run relevant focused local contracts and the existing equivalence tests, then verify fresh complete CI for the final head and current-base integration candidate. Explicit local, native, coupled-run, live, installation, release, and deployment acceptance remains separate. Investigate observed failures and stalls with bounded diagnostics; green CI alone does not resolve them. The local full aggregate remains available for diagnosis and is required when CI coverage or equivalence is absent or uncertain.

The browser capability is serialized separately before weighted CPU admission, so it does not consume a compute permit while waiting. The Mac lane fails before child execution on another operating system. Nested wrappers may use only a mode and capability already covered by the outer lease.

### Browser wait visibility and cooperative handoff

Plugin 0.4.6 reports elapsed waits after 15 seconds and then every 30 seconds.
Each update includes up to four cooperating holders' safe labels, stages, held
durations and exact run IDs. Inspect the current reports separately with:

```sh
oompa-host-queue --lane=browser-auth --json
```

The version-1 JSON snapshot is the supported read-only projection for Slopcamera
and other local consumers. It includes `coverage: "cooperating-wrappers-only"`,
`availability: "unknown"`, `custody: "unknown"`, registry availability,
unresponsive-owner count, and an `owners` array. Each owner has a random run ID,
safe label, optional explicitly supplied task UUID, lane, mode, stage, elapsed
and queued milliseconds, capability duration, and handoff-request count.
The stages are `waiting-capability`, `waiting-compute`, `running` and `settling`.
`waiting-compute` can already have the capability, reported as `reported-held`.
These reports neither establish capacity nor assign FIFO positions. Older
wrappers and dead observation sockets remain unknown; descendants may still hold
their kernel lease. Consumers must preserve these limits when displaying results.

To expose an appropriate task identity, supply `--task-id=UUID` explicitly on
the wrapper. It never infers identities from sessions or environment values.
The projection excludes command arguments, working directories, PIDs,
environment values, task titles and child output. It does not read scheduler
files or invoke lease assertions, which can mutate stale-marker state.

Request that a specific reported holder finish its current bounded session:

```sh
oompa-host-queue --request-handoff=RUN_ID --request-id=preview-1 --label=music-preview --json
```

Replace `RUN_ID` with the exact 32-character run ID from status. The safe ASCII
request ID identifies this intent; retry an uncertain request only with its
original ID and label. `recorded` means the owner recorded the request and
attempted one notice. `already-recorded` reconciles a retry without another
notice; a changed label with that ID returns `conflict`. Owners still waiting for
the capability, or already settling, refuse new notices with `not-holder`.
At most 32 notices are retained
per run; further new intents return `limit-reached`. Exit 0 acknowledges a
status snapshot or recorded request. Exit 2 means an invalid/unavailable request,
unavailable registry, or refused handoff. The receipt never promises release or
completion time. There is no interrupt, cancellation, queue-jump or lease-edit
operation in this channel.

The holder finishes and collects its browser session before returning the lane.
Do source editing and external waits after that return, and acquire a fresh
ordinary FIFO claim for the next bounded browser session. Do not detach servers
or leave a wrapper open across unrelated work.

Observation uses owner-private POSIX sockets in an ephemeral directory under
`/tmp`, addressed by a digest of the explicit scheduler root. Reads never create
that directory. A snapshot considers at most 64 endpoints with eight concurrent
requests, 2 KiB messages, and 400 ms absolute connection deadlines. Responses
are live reports, not a persistent cache. Normal exit removes the wrapper's own
socket. Stale sockets count as unresponsive; unsafe or overfull registries report
unavailable. Status reads never delete or repair them. Registration attempts a
bounded observation-only cleanup when at least 32 endpoints have accumulated;
`oompa-host-queue --prune-stale --json` runs that same cleanup explicitly.
It removes only an owner-private socket at least 60 seconds old whose registered
owner is absent, connection is unreachable, and device, inode and modification
time remain unchanged. The private socket filename binds the random run ID to
its owner PID; public status and notices never include that PID. Signal-zero
existence checks must return `ESRCH` before and after probing. A live or reused
PID, permission refusal, or unknown result retains the endpoint.
Ordinarily this requires `ECONNREFUSED`. Bun 1.3.14 maps synchronous Unix
connection failures to `ENOENT`; on Darwin and Linux that pinned runtime also
accepts this error only with those owner and socket checks. A busy listener can
produce the same error, so it cannot authorize cleanup by itself. Missing
or replaced paths do not qualify. Reachable, young, timed-out and otherwise
uncertain endpoints are retained. Endpoint unreachability never proves owner
death. Removing an unreachable observation socket says nothing about an inherited scheduler
lease and cannot release it. Observation failures preserve
the child exit code and existing scheduler behavior. Set
`OOMPA_LOCAL_EFFICIENCY_QUEUE=off` to disable an invocation's observation channel
and automatic progress updates independently of telemetry.

The explicit local native acceptance uses the installed, checksum-verified
runtime in isolated ledgers. Run it through the absolute installed host wrapper:

```sh
OOMPA_HOST_QUEUE_NATIVE=1 /absolute/oompa-host-run --mode=shared --lane=compute --label=queue-native -- bun test plugins/oompa-local-efficiency/skills/oompa-local-efficiency/scripts/host-queue.native.test.ts
```

It proves FIFO after canceled waiters, exact-owner idempotent handoff, unchanged
child exit under observation failure, and continued exclusion after wrapper
death while a descendant retains the inherited descriptor. Ordinary plugin
tests cover protocol bounds and socket behavior without loading that runtime.

### Admission and process custody

The weighted coordinator is strict FIFO for overlapping claims. Queue `exclusive` only for a converged command that is ready to run. If a never-admitted exclusive claim strands spare permits ahead of a known finite shared/heavy backlog, only its owner may cancel that waiting wrapper and requeue the identical command after the backlog drains. Do not interrupt admitted work or bypass the scheduler to reorder it.

For non-interactive macOS and Linux runs, the wrapper gives the command its own process group, forwards `HUP`, `INT`, `QUIT`, and `TERM` to that complete group, and terminates residual descendants when the command leader exits. Residual processes receive a bounded graceful interval before forced cleanup. An interactive TTY keeps its controlling terminal and receives best-effort leader signaling. This keeps interrupted package runners and browser suites from continuing outside their scheduler lease without breaking an intentional 2FA prompt; an uncatchable host-level kill still requires operating-system recovery and diagnosis.

Plugin 0.4.5 adds explicit `--tty-signal-owner=child` for a reviewed interactive
child that owns terminal Ctrl-C. The default is `parent`, preserving prior
behavior. Child ownership refuses before lease or subprocess work unless all
three standard descriptors are actual POSIX terminals, and rechecks them before
spawn. SIGINT still cancels while waiting for admission or before a child exists.
After that exact child starts, the wrapper does not forward another SIGINT into
its shared terminal group or prematurely record its local interruption as a
canceled command. The wrapped child determines its exit outcome; its actual
collection still precedes lease release. The mode has a distinct command digest.

A signal sent directly to only the wrapper as SIGINT is not a supported
post-start cancellation in this opt-in mode: JavaScript signal listeners cannot
distinguish it from terminal delivery. Use SIGTERM for external cancellation.
HUP, QUIT and TERM forwarding, default parent ownership and noninteractive
process-group cleanup remain unchanged. The caller must still own its exact
child and distinguish any deliberately local Ctrl-C from a stop. Do not use a
timing grace to infer a signal's origin. The option neither establishes owner
terminal accessibility nor authorizes authentication or another provider effect.

Each top-level scheduler attempt records one bounded event when telemetry storage is available; pre-admission scheduler failures and cancellations have no admitted timestamp or run duration. A catchable cancellation is recorded as `canceled` with its conventional signal exit code before the wrapper releases its waiting claim. Daily files are mode `0600` below a mode-`0700` directory, are capped at 4 MiB, and retain fourteen UTC days. Records include safe labels, digests, timings, lane, mode, permits, and outcome. They exclude raw argv, paths, environment values, process identities, transcripts, reasoning, and tool output. Telemetry is best effort and never changes the wrapped command's result.

Review the first seven days of available local measurements with:

```sh
oompa-throughput-report
oompa-throughput-report --days=14 --json
```

The report shows queue and run percentiles, failures, permit-weighted runtime, concurrency, and repeated command digests. Repeats are review candidates, not proof of wasted work. Measurements begin after this plugin version is installed; the plugin does not reconstruct historical telemetry from private transcripts.

Audit a repository's history-fetch posture with:

```sh
oompa-ci-ref-audit --check --root /absolute/repository/path
```

The audit is read-only. It rejects an unbounded ref fetch coupled to a detected complete-history consumer, recognizes explicit exact-ref allowlists, and leaves uncertain broad-history cases for review. It never rewrites workflows or weakens `rev-list --all` and equivalent policy gates.

From a reviewed repository checkout, maintainers can apply and verify the same bootstrap directly:

```sh
bun run local-efficiency:apply
bun run local-efficiency:check
```

After a marketplace update, refresh the Git snapshot, reinstall the plugin, and start another new task:

```sh
codex plugin marketplace upgrade hraness
codex plugin add oompa-local-efficiency@hraness
```

Machines that installed the earlier plugin-specific sparse checkout must replace that marketplace snapshot once before upgrading:

```sh
codex plugin marketplace remove hraness
codex plugin marketplace add hraness/oompa --ref main --sparse .agents/plugins --sparse plugins
codex plugin add oompa-local-efficiency@hraness
```

In that new task, invoke `$oompa-local-efficiency` and have it run the freshly installed skill's `scripts/bootstrap.ts --apply` followed by `--check`. This repoints the convenience-command symlinks from the prior versioned plugin cache before they are used and refreshes the prompt-only host-access rule.

Run the plugin's deterministic test suite before handoff:

```sh
bun run test:local-efficiency-plugin
```

The bootstrap and audits are local operations. The read-only workspace audit reports managed-guidance drift alongside the existing Hraness repository and worktree inventory. Repository adoption changes only the exact `oompa-local-efficiency` marker block in root `AGENTS.md`; it creates root `CLAUDE.md` as `@AGENTS.md` when missing, preserves an existing active import byte-for-byte, or adds a marker-bounded import without replacing Claude-specific guidance. The managed policy keeps bounded research and review subagents in one working tree when safe, creates another worktree only for genuinely divergent delivery, assigns one owner to each focused check and external wait, prefers short-lived workload identities to personal credentials, and records final delivery evidence before closeout.

When a repository is already in scope for a change, check its managed baseline and refresh drift with `scripts/repo-adoption.ts` in the same task-owned change and existing final gate, preserving unmanaged rules; do not open a separate rollout solely to repeat expensive checks.

Session silence remains a review heuristic. The audit never writes the Codex database or infers completion from inactivity or support-task metadata. Verify terminal task state through the app, then archive a conclusively finished task so the app can snapshot and reclaim its managed checkout. Permanent worktrees and other registered checkouts still require the separate explicit cleanup operation with every approved absolute path.

## Scheduler runtime identity

Plugin 0.4.4 adopts the Slopcamera runtime name and an immutable source pin.
The existing Oompa ledger and inherited lease identities remain unchanged.

The local plugin retains a minimal, checksum-verified Slopcamera host-resource
module at an immutable source commit. The runtime cache directory includes that
commit. This cache is separate from Oompa's stable resource and capability ledgers.
Oompa passes its own state roots and profile IDs explicitly, so an upstream default
namespace change does not create another Oompa admission domain.

Before changing the pin, qualify both library directions with the opt-in
`host-runtime-compatibility.process.test.ts` against isolated temporary state.
Set `OOMPA_PREVIOUS_HOST_RESOURCES_MODULE` and `OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE`
to exact verified module files and use the installed host scheduler. The test
proves an admitted holder excludes the other library until release, then verifies
its later ticket, identical profile hash and complete lease cleanup. Ordinary
tests skip this native qualification when those inputs are absent.

A source change does not activate the installed plugin. Upgrade through the
normal marketplace/bootstrap path after admission; never rewrite an active
installed module or move live ledger files by hand.
