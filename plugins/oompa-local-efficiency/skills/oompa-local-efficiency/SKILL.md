---
name: oompa-local-efficiency
description: >-
  Install, audit, and operate the Hraness local Codex and Claude Code efficiency
  and approval-autonomy baseline across repositories and Macs. Use for managed
  agent permission defaults, repository delivery guidance, Codex swarm throughput, host-wide
  heavyweight-command scheduling, capability lanes, privacy-safe telemetry,
  validation ownership and exact-tree receipts, stale-task reporting, guarded
  Git worktree cleanup, complete-history CI ref isolation, model-lane setup, or
  checking whether a Hraness machine follows the standard. Preserve useful
  agent fan-out and all repository final gates. Do not use for cloud execution
  or cloud optimization.
---

# Oompa local efficiency

Keep parallel reasoning and routine authorized delivery moving without human
prompt churn. Reduce duplicated validation, conflicting local compute,
unnecessary checkouts, stale state, and verified disposable disk use while
preserving sandbox, provider, repository, and release gates.

## Choose the mode

- **Install or update this Mac:** run `bun run scripts/bootstrap.ts --apply`
  from this skill directory, then run it again with `--check`. This manages
  Codex automatic approval review and workspace permissions plus Claude Code
  Auto mode and global guidance; it never enables a bypass-permissions mode.
- **Inspect this Mac:** run `oompa-local-efficiency --json` (or
  `bun run scripts/doctor.ts --json`) to check the managed global Codex and
  Claude settings, then run `bun run scripts/workspace-audit.ts` and
  `bun run scripts/session-audit.ts`. All three are read-only. Add
  `--sizes` only when the slower recursive worktree-size estimate is useful.
  The workspace audit reports each Hraness repository's managed guidance
  status; use `repo-adoption.ts --apply --root ABSOLUTE-REPO` for each reported
  `needs-update` repository.
- **Measure local throughput:** run `oompa-throughput-report` for the bounded,
  privacy-safe scheduler history. Treat repeat command digests and silent tasks
  as review heuristics, never as proof of waste or abandonment.
- **Inspect a browser wait:** run `oompa-host-queue --lane=browser-auth --json`.
  It reports cooperating wrappers, safe labels, elapsed waits and owner-reported
  capability stages. Missing, stale and older-wrapper information is unknown;
  the snapshot never establishes free capacity or FIFO position. Add an explicit
  `--task-id=UUID` to `oompa-host-run` only when sharing that task identity is
  appropriate. It never reads task identities from the environment.
- **Request a cooperative handoff:** address the exact observed run with
  `oompa-host-queue --request-handoff=RUN_ID --request-id=REQUEST_ID --label=LABEL --json`.
  Use a fresh safe ASCII request ID for each intent and the identical ID and label
  when reconciling an uncertain delivery. A recorded receipt acknowledges a notice,
  not release. The holder finishes and collects its current browser session before
  returning the lane; do source editing and external waits after that return.
  Never signal another holder or change its lease to obtain a slot.
- **Run heavyweight local work:** resolve `oompa-host-run` to its installed
  absolute path and use `ABSOLUTE-Oompa-HOST-RUN
  --mode=shared|heavy|exclusive
  --lane=compute|browser-auth|mac-native --label=LABEL -- COMMAND ...` through
  reviewed host access. Keep the complete wrapper and child argv visible to
  Codex.
- **Run a reviewed interactive child that owns Ctrl-C:** opt in with
  `--tty-signal-owner=child` only when descriptors 0, 1 and 2 are actual POSIX
  terminals. Before the exact child starts, SIGINT still cancels admission.
  While it runs, terminal SIGINT reaches the foreground child directly; the
  wrapper neither duplicates it nor records cancellation before the child
  settles. Direct SIGINT sent only to the wrapper is not a supported post-start
  stop in this mode; use SIGTERM for external cancellation. HUP, QUIT and TERM,
  existing noninteractive group cleanup, default parent ownership and lease
  collection remain unchanged. This option grants no interactive/auth authority.
- **Record or reuse deterministic focused validation:** use `oompa-validate`.
  Reuse is opt-in and is never valid for a required final integration,
  merge-queue, deployment, release, authenticated-browser, or network-sensitive
  gate.
- **Reclaim Git worktrees:** audit first with `workspace-audit.ts`, then invoke
  `worktree-cleanup.ts` separately in each owning repository with every approved
  absolute path named through `--remove`.
- **Adopt or check repository guidance:** use `repo-adoption.ts --check` or
  `--apply`. It edits only the exact managed policy block in root `AGENTS.md`
  and adds an `@AGENTS.md` import to root `CLAUDE.md` while preserving existing
  Claude-specific guidance.
  When a repository is already in scope for a change, check and refresh its
  managed baseline in that same task-owned change and existing final gate,
  preserving unmanaged rules; do not open a separate rollout solely to repeat
  expensive checks.
- **Audit CI ref isolation:** use `oompa-ci-ref-audit --root ABSOLUTE-REPO`. Review
  every candidate; fix only workflows whose complete-history gate can import
  unrelated refs, and preserve the complete-history scan itself.

Run scripts from the installed skill directory when the convenience commands
are unavailable. `bootstrap.ts` installs or refreshes those commands under the
user's Bun bin directory. It verifies a minimal pinned Slopcamera host-resource
runtime in a source-commit-specific directory under the user's local data directory;
it never replaces a global Slopcamera package or command. Runtime upgrades keep
the existing HRA state root, profile IDs and inherited lease protocol. Do not
move or rewrite a live scheduler ledger to match a runtime's product name.

This plugin was previously named `hra-local-efficiency`. `bootstrap.ts --apply`
migrates that installation in place: it replaces exactly one well-formed
`hra-local-efficiency` managed block in each managed file with the current
block, moves the Codex rule file and the two profile files to their current
names while keeping their unmanaged content, retargets the `hra-*` command
links, and installs `hra-*` compatibility links beside the `oompa-*` commands.
`--check` reports every legacy remnant as drift, requires the compatibility
links only on a machine that already has a legacy command name, and refuses a
file that carries both legacy and current markers. `repo-adoption.ts` migrates
a repository's legacy `AGENTS.md` and `CLAUDE.md` blocks the same way.

## Preserve the invariants

- Treat a user request that places a repository and outcome in scope as
  standing authorization for routine task-owned commits, pushes, pull requests,
  merges, releases, and deployments after the gates applicable to that action
  pass. Build confidence through relevant automated checks, bounded diagnostics,
  and independent review, not a second conversational confirmation. Passing
  checks does not expand task scope or authority.
- Separate artifact admission from live qualification and operational
  activation. Applicable automated source, security, package/install, and
  provenance evidence can admit an artifact without live provider qualification;
  live proof is not a universal publication prerequisite. Preserve explicit live
  acceptance criteria and require relevant live evidence for claims that depend
  on it. If publication or an artifact's install, upgrade, or default-use path
  activates risky unqualified behavior, keep that behavior guarded or disabled,
  or obtain bounded relevant evidence before shipping or activation. Preserve
  the identity, target, capacity, migration, and recovery guards applicable to
  the operational effect.
- For eligible public packages, use verified immutable GitHub Release artifacts
  as canonical distribution independently of optional exact-byte npm mirrors.
  Prefer OIDC where provider policy permits; retain required staged approvals
  and private-package access boundaries.
- Replace an obsolete gate through a reviewed source and policy change with
  corresponding tests, never an ad hoc skip. Runtime-enforced approvals, access
  controls, branch and environment protections, and safety policies remain
  binding. Ask for user input only for a material product decision, missing
  credentials or authority, unavoidable interactive authentication, an
  out-of-scope destructive action, or a failure that cannot be handled safely
  and autonomously.
- Prefer short-lived repository workload identities, npm trusted publishing,
  and scoped GitHub App tokens over personal sessions and reusable secrets.
  Use unattended stable publication and production promotion where provider
  and repository policies permit. Establish machine authority once and verify
  it with a non-publishing preflight where available. Retain account 2FA and
  provider-required approval bound to the exact staged artifact; never remove
  a package policy declaration or change its coordinate to evade that control.
  Batch unavoidable authentication at the final boundary.
- Preserve production and user data. Inspect the exact account, environment,
  deployment, and data target before writes. For data changes, inspect a dry
  run or equivalent migration plan and validate recovery before an effect that
  could lose or corrupt data. Prefer additive, backward-compatible migrations
  and bounded batches. Record intent, use idempotency or conditional writes,
  and reconcile uncertain results before retrying. Verify deployed identity,
  health, and relevant data invariants after delivery. Routine delivery never
  authorizes resetting, truncating, dropping, or overwriting user data; stop the
  unsafe operation if preservation or recovery cannot be established.
- Keep delivery gates proportional to the failure they prevent. Prefer
  required checks on the current integration candidate, independent agent
  review, and atomic or conditional integration. Add a merge queue or another
  approval stage only for a demonstrated coordination or safety need. Replace
  redundant queues, serial waits, and duplicate checks through reviewed policy
  changes while retaining evidence for the integrated result.
- Do not cap agent count merely to reduce fan-out. Parallel reasoning and
  independent implementation lanes remain desirable.
- Prefer bounded subagents in the current task for research, review, diagnosis,
  and focused checks when they can safely share one working tree. A separate
  task or worktree is warranted for independently deliverable divergent edits,
  an intentionally isolated verification tree, or a different environment.
- Give each focused check one worker owner. The integrator reviews the diff and
  reported evidence, repeating a focused command only when the tree changed,
  evidence is missing, or a repair invalidated it.
- Give each CI run, merge-queue item, provider operation, or deployment wait one
  waiter. Do not hold a compute lease while waiting on external state.
- Run the repository's aggregate/final gate once after convergence. Never use a
  receipt to skip a repository-required final replayed-tree or delivery gate.
  Where reviewed repository policy assigns complete required CI as the final
  source aggregate, verify the policy's scope, coverage/equivalence evidence,
  independent impact review, and fresh exact-head, current-base CI result. Keep
  relevant focused local checks and separate local, native, coupled-run, live,
  and installation acceptance; do not add a duplicate local aggregate. Diagnose
  observed failures and stalls independently of a passing CI result. Use the
  local aggregate when the repository requires it or CI equivalence is uncertain.
- The host scheduler is an outer layer. Jungle and Oompa keep their repository
  schedulers underneath it; invoke `oompa-host-run` only around top-level
  commands. Nested `oompa-host-run` calls inherit the outer lease and do not
  acquire again.
- Keep roots and integrators on the caller's selected model. Bounded independent
  workers may use the installed `oompa-worker` or `oompa-routine` profiles when the
  task merits them; measure repair rate rather than assuming cheaper is better.
- This baseline is local-only. Do not create, configure, or route work to Codex
  cloud through this skill.

## Capability lanes

- **Ordinary:** research, review, edits, and narrow checks. Share the current
  task worktree when safe and normally do not acquire a host lease.
- **Heavy compute:** broad builds and repository gates. Use the `compute` lane
  with `heavy` or `exclusive` mode.
- **Browser auth:** work that needs the user's signed-in browser, a fixed port,
  a dev server, or Chromium. Keep it on this machine, assign one owner, and use
  the `browser-auth` lane. Use `exclusive` mode for a fixed-port or heavyweight
  suite.
- **Mac native:** Xcode, Simulator, Keychain, signed-app, or other macOS-only
  work. Keep it on a Mac, assign one owner, and use the `mac-native` lane.

The browser and Mac lanes each serialize their scarce capability while still
sharing the weighted compute capacity. A nested wrapper must be covered by the
outer lane; choose the top-level lane correctly instead of escalating it inside
an existing lease.

Plugin 0.4.6 adds bounded wait updates after 15 seconds and then every 30 seconds,
plus a private local status and handoff channel. `waiting-compute` can already
hold the browser capability, so finish that bounded command before releasing it.
Do not keep a browser wrapper open for unrelated work between settled sessions.
The status command is the supported projection for Slopcamera and other local
callers; they must not inspect scheduler files. The projection is advisory and
partial, with availability and custody always unknown. A crashed wrapper can
leave descendants holding the real lease. Only the unchanged scheduler decides
admission and release. `OOMPA_LOCAL_EFFICIENCY_QUEUE=off` disables this wrapper's
observation channel and progress updates without changing its lease or telemetry.
If dead observation sockets accumulate, `oompa-host-queue --prune-stale --json`
removes only old, private, unchanged socket endpoints with unreachable connections.
Registration performs the same bounded cleanup near its endpoint limit. Status
reads never repair state, and observation cleanup never touches scheduler leases
or establishes free capacity.

For an indivisible aggregate that requires macOS, such as Slopcamera `bun run check`,
use `exclusive` mode on `mac-native` when its Chromium work is an owned fixture
with a fresh profile and loopback server. Exclusive reserves all common compute
capacity. This mapping admits no personal authenticated browser, shared fixed
server, or nested cross-lane acquisition. Separate browser-only gates retain
`browser-auth`.

For non-interactive macOS and Linux runs, the wrapper supervises a dedicated
child process group and forwards `HUP`, `INT`, `QUIT`, and `TERM` to the whole
group. An interactive TTY preserves its controlling terminal and receives
best-effort leader signaling so an intentional 2FA prompt still works. Do not
detach a background server from scheduler custody.

## Resource modes

Use `shared` for one narrow check, `heavy` for production builds and ordinary
repository-wide checks, and `exclusive` for full monorepo validation, native
packaging, capture hardware, or fixed-port browser suites.

Submit `exclusive` work only after its inputs converge. Strict FIFO prevents
starvation but can strand spare permits behind a waiting all-permit claim. If
that happens ahead of a known finite shared/heavy backlog, only the exclusive
claim's owner may cancel it before admission and requeue the identical command
after the backlog drains. Never interrupt an admitted command just to reorder
the queue, and never run its child outside the scheduler.

Known mappings:

- Jungle `check:affected`: heavy; Jungle full `check`: exclusive.
- Oompa `check`: exclusive compute, with the unchanged `bun run check` child.
  Its package tests share the machine-wide process-recovery journal, so parallel
  heavy leases can still contend across checkouts. Production builds: heavy;
  native package work: exclusive on the applicable capability lane.
- Personal template and Tiff full check/build: heavy.
- Narrow file or package tests: normally unscheduled, except process-custody or
  recovery checks that require the scheduler.

The wrapper runs the original public command unchanged. It does not substitute
a weaker check.

Each top-level scheduler attempt appends one bounded local telemetry record when
storage is available. A pre-admission scheduler error or catchable cancellation
has no admission timestamp or run duration; cancellation is recorded before the
waiting claim is released. Records contain timestamps, lane, mode, safe label, program
label, permit counts, queue and run durations, an exit class, a hashed workspace
identifier, and a command digest. They never contain raw argv, environment
values, paths, transcripts, reasoning, or tool output. Telemetry is best effort
and never changes the child command's result.

## Host-access boundary

The machine-wide scheduler state intentionally lives outside an ordinary
repository sandbox. Request reviewed host access for the top-level absolute
`oompa-host-run` invocation on the first attempt. This also applies to focused
Oompa process-custody and recovery tests: they exercise machine-scoped identity
and journal locks even when their CPU cost is small.

If the wrapper reports `OOMPA_HOST_ACCESS_REQUIRED` and exits 77, retry the
identical wrapper invocation once through Codex host-access approval or
configured auto-review. Preserve the working directory and every argument. If
the reviewed retry still returns 77, stop and diagnose the permission setup.
Never bypass the wrapper by running its child directly, remove scheduler or
recovery state, weaken fail-closed custody, or create an unconditional allow
rule for `oompa-host-run`; it can wrap arbitrary child commands.

The bootstrap sets Codex to `approval_policy = "on-request"`,
`approvals_reviewer = "auto_review"`, and `default_permissions = ":workspace"`.
It also manages a prompt-only Codex rule for the absolute installed wrapper.
The rule makes every complete invocation reviewable but grants no permission.
Codex loads configuration and rule files at task startup, so start a new task
after installing or updating the baseline.

When the installed Claude Code is at least 2.1.83 and
`claude auto-mode config` confirms that the CLI exposes a valid Auto-mode
configuration surface, the bootstrap sets
`permissions.defaultMode = "auto"` and inherits its built-in classifier rules
through `$defaults`. Because explicit allow rules resolve before the Auto
classifier, the bootstrap removes bare or universal whole-tool allows and every wildcarded
Bash or PowerShell allow while preserving exact commands, path-bounded
non-shell allows, and every deny. Claude may apply additional runtime filtering. It
does not globally declare sibling repositories or the public npm registry
trusted. The doctor reports the machine capability
decision. If the CLI does not expose that surface, bootstrap leaves the
ordinary permission setting untouched. Account, model, and organization
eligibility is enforced by Claude Code when a session starts rather than
attested by the configuration command; if that runtime gate refuses Auto mode,
use the ordinary permission mode and never fall back to bypass permissions.

## Validation receipts

`oompa-validate` fingerprints the Git HEAD, tracked diff, untracked file content
and executable/link mode, working directory, exact command, Bun/Node versions,
lockfiles, and caller contexts. It never follows untracked symlinks. Successful
receipts live under the repository's Git common directory
so linked worktrees can share exact evidence. Receipts and wrapper output retain
only a safe operation label, program name, and command digest—not raw argv or
context values. Reuse fails closed when the index contains skip-worktree or
assume-unchanged entries, a populated gitlink/submodule, or an unsupported
untracked file type.

Use `--reuse --ttl-minutes=N` only for deterministic focused commands. Force a
real run after relevant environment or external state changes. Failed commands
are reported for diagnosis but never reused as success.

## Complete-history CI

A complete-history policy is not permission to fetch every live branch. Start
from the exact governed SHA, disable credential persistence, and explicitly
fetch only the fully qualified branch, tag, or exact-SHA refs the policy owns.
Enumerate refs immediately afterward and reject any unexpected ref before the
history scan. Keep `rev-list --all` or the repository's equivalent complete
scan over that governed ref set.

Use `oompa-ci-ref-audit` as a conservative review aid. A broad fetch without a
complete-history consumer is informational, and a complete-history consumer
with an explicit governed ref set is compliant. Do not rewrite release history
fetches mechanically; tags and the stable branch may both be required inputs.

## Cleanup safety

Size is a discovery signal, not deletion authority. A removable worktree must
be registered, present, clean including untracked and ignored files, free of
skip-worktree and assume-unchanged index flags and populated gitlinks, neither
primary nor the invoking worktree, explicitly named, and merged into an exactly
fetched, fully qualified remote target. The cleanup script validates the full
manifest before deletion and revalidates every target at action time. It never
forces removal or deletes branches.

Treat unregistered temporary directories, Codex transcripts, application
databases, credentials, private corpora, archives, and dirty worktrees as user
state. Never sweep a temporary-path prefix.

At task closeout, record the applicable final branch, pull request, checks,
merge, release, deployment, and production readback. Archive only a
conclusively finished task; silence is not completion evidence. In the Codex
app, archiving a completed managed-worktree task lets the app snapshot and
reclaim its managed checkout. Permanent worktrees still require their own
guarded cleanup.

## Machine standard

`bootstrap.ts` manages one marked block in global Codex `AGENTS.md`, three
top-level Codex permission settings, one marked block in global Claude
`CLAUDE.md`, Claude's Auto-mode default, bounded environment, and broad-allow
cleanup, two optional
CLI profiles, a prompt-only host-access rule, a minimal private scheduler
runtime, and convenience commands. It preserves unrelated TOML, JSON, Markdown,
and rule content, leaves exact profile symlinks intact, and refuses unsafe
targets. Use `--check` in automation and after plugin upgrades.

The Oompa repository marketplace is the cross-machine source of truth. Upgrade
the marketplace and reinstall the plugin, then rerun bootstrap and start a new
Codex task so the refreshed skill is discovered.
