# Devin provider and preset authority

## Reactivation (2026-09-16)

On 2026-09-16 the owner accepted a quota source for Devin: the panel the pinned
official Devin CLI renders for its own `/usage` slash command, read by driving
that CLI on a pseudo-terminal. This automates the vendor's supported user
surface. Oompa uses no undocumented network endpoint, reads no credential file,
and never submits a prompt. The reader pins exactly one CLI version and reports
`unknown` with a closed reason on any drift instead of guessing.

Current Devin self-serve plans are token-metered with daily and weekly calendar
resets; ACUs remain an Enterprise billing unit. "Remaining quota" therefore
means the panel's remaining percent per window plus each window's reset
instant, not an ACU balance.

### Phase 1. Credential-free quota reader

- **Status:** Complete. Merged in PR #226.
- **Scope:** pin (`3000.10.27`) and version admission; PTY driver that types
  only `/usage`, Enter, `/exit`, Enter; closed panel grammar for the banner, the
  `Weekly` and optional `Daily` lines, and the optional extra-usage line;
  year-less reset resolution; bounded output and guaranteed child cleanup;
  captured fixture plus synthetic variants; lint layering for `src/devin`.
- **Not in scope:** daemon, CLI, storage, cloud, or browser wiring; any change
  to retired-provider refusals or schema.
- **Acceptance:** focused tests for the parser, runtime admission and driver
  pass; lint and strict types pass; one live read on the pinned build returns
  an `observed` result without spending a turn (the live fixture records
  `No quota consumed yet in this session`); independent review; Required CI.

### Phase 2. Provider runtime and ACP adapter on the current architecture

- **Status:** Implemented on `feat/devin-provider-runtime`; not wired.
- **Scope:** the ACP v1 protocol, client, process custody, auth status and
  foreground login from PR #115 restored under `src/devin/`, and the runtime
  adapter restored as `src/daemon/devin-runtime-adapter.ts` on the current
  `SessionRuntimePort` seam: provider-account authority (`dact_` ids and
  binding generations) at every boundary, `readAccount` as a readiness
  projection, `rebindProfileAuthority` and `interactionAuthority` in the
  shapes the Claude adapter uses, `hasLiveSession`, and interaction
  authorities that carry provider and account identity. The client frames
  NDJSON itself; the `@agentclientprotocol/sdk` dependency is not restored.
  The adapter reviews a new `EffectiveDevinRuntimeProfileV2` document pinned
  to CLI `3000.10.27`; the historical V1 document keeps its exact bytes.
- **Not in scope:** the V2 document is not yet a member of the reviewed
  runtime-profile union, and the adapter is not constructed by the daemon,
  selected by the service, or reachable from the parser. Attachments and
  in-turn steering remain refused by the adapter as in #115.
- **Acceptance:** the protocol, client, auth and adapter fixtures from the
  removed implementation pass on the current ports, extended with authority,
  readiness, rebind and property cases (83 tests across `src/devin` and the
  adapter); every fake child is joined on shutdown; lint layering, strict
  types, the security-primitives table and the reviewed package inventory
  pass. The zero-token `initialize` check against the real pinned build is
  deferred to Phase 4 with the paid turn, because it launches `devin acp`
  under an isolated home that Phase 3 first has to create.

### Phase 3. Lifting refusals with append-only migrations

- **Status:** Not started.
- **Scope:** parser, storage admission guards, service, cloud payloads and
  browser selectors admit Devin again; usage snapshots gain a `devin_usage_panel`
  source recorded with the exact CLI version line and the `unknown` reason when
  present; historical v39 and v40 rows keep their bytes.
- **Acceptance:** fresh and upgraded databases accept Devin while retaining
  older rows byte-for-byte; retired rows never regain execution authority;
  routing, Work and scheduled-task eligibility treat Devin explicitly.

### Phase 4. Live acceptance

- **Status:** Not started.
- **Scope:** one bounded paid turn in a disposable isolated profile covering
  turn, tool, approval, cancellation and usage-update paths; a quota read before
  and after that turn.
- **Acceptance:** sanitized acceptance record bound to the exact pin and argv;
  no credential, session identifier or raw panel retained.

## Removal record (2026-09-06)

On 2026-09-06 the user made verified remaining account quota and reset reporting
a condition of provider support. Official CLI/ACP documentation did not provide
that surface for an ordinary signed-in CLI account. The integration below was
superseded by removal on that date; the reactivation above supersedes the
removal for the quota reader only.

Removal deletes runtime/ACP dependencies and active CLI, cloud, and UI selection.
Historical v39 authority and later migrations remain append-only; stored Devin
history is readable but cannot acquire execution authority. Provider-owned
credentials are not inspected or deleted. An exact acknowledged cleanup command
remains only for historical login fences. Codex and Claude functionality and
separately owned model defaults remain unchanged.

Acceptance requires parser rejection of new Devin operations, zero runtime
dispatch for old rows or commands, preserved mixed-provider history and login
cleanup, focused regressions, independent review, and the repository final gate.
The removal is implemented on `codex/remove-devin-support-20260906`, integrated
with personal-session adoption at `6f056dc`. Schema v40 and its immutable v39/v40
DDL remain unchanged. Current runtime admission, Work authority, and all three
scheduled-task eligibility checks reject retired providers outside those
historical definitions.

Review added local-only interaction expiry so old pending Devin approvals cannot
starve supported deadlines. Prepared and uncertain replies remain evidence.
Recovery rejects a retired current provider or either retired side of an old
switch before provider reads, process release, or facts-memory cleanup. Browser
session, grid, and archived-session controls retain the retired marker and refuse
mutations without redirecting a message to another conversation.
Validated retired in-flight operations are quarantined locally on restart,
without replay, resolution, or new retired authority successors. Invalid evidence
still fails closed. This preserves uncertainty without blocking supported
accounts from starting.
The aggregate also exposed obsolete login-session cleanup methods, which are
removed, and a signed-in history pagination omission. Local history listing now
opts into retired rows explicitly; current account-authority queries remain
strict by default.

Focused evidence before final integration:

- Pre-adoption CLI: 435 tests passed; cloud retirement checks passed after
  preserving existing interaction failure codes; web suite: 442 tests passed.
- Adoption-integrated public content: 60 tests passed. Archived-session model
  and settings regressions: 26 tests passed, including supported controls.
- Adoption-integrated CLI and installer: 303 tests passed. Cloud boundary:
  150 tests passed. Storage authority and historical migration scope: 12 tests
  passed, including two generation advances and malformed-evidence negatives.
- Final queue and mixed-history storage scope: 13 tests passed after reproducing
  the old-generation restart failure. Service policy scope: 47 tests passed;
  corrected in-flight start and queued-send startup regressions each passed.
- Independent release review found no blockers. The actual npm archive has
  157 reviewed entries and no Devin runtime files. Installer pins and security
  primitive counts match their reviewed tables.
- The adoption-integrated Convex, site, and app suites pass together: 732 tests.
- Deadline starvation and recovery side effects were reproduced before their
  guards. Delivery still requires the exact-tree repository aggregate and normal
  protected-main checks; their final evidence belongs on the removal PR.

The rest of this file records the superseded implementation evidence.

## Status

Implementation complete on `codex/devin-provider-astra-20260905`, rebased onto
the model-routing integration in PR #112 and its provider-switch Work exclusion
repair in PR #114 (`1df685b`). Final delivery
remains pending the exact-tree aggregate gates below.

## Product decision

Oompa will run the official local Devin CLI as an ACP v1 subprocess. The admitted
runtime is exactly Devin CLI `3000.6.14`, and every session starts with the exact
`devin acp --model gpt-6-astra` command before Oompa validates ACP v1
initialization. A model-catalog probe is not part of admission because the
foreground login path must remain usable while the isolated profile is signed
out. Oompa will not use Devin's cloud REST or MCP APIs for local sessions: those
APIs require separate `cog_` credential custody, create a different
remote-session lifecycle, and cannot currently guarantee an arbitrary model
selection.

Codex `high` and `ultra` actively resolve to `gpt-5.6-sol` at `max` and `ultra`
reasoning, respectively. New Oompa sessions and explicit Codex preset selections
bind the immutable Sol contract. Established contract 2 Codex sessions retain
their exact Astra mapping and reviewed runtime history; queued and recovered
work cannot reinterpret that evidence. At the superseded implementation point,
Devin used an explicit `astra` preset on contract 2. Current Oompa preserves those
rows only as read-only history and exposes no Devin execution or selection.

## Authority and privacy invariants

- Devin owns its credential file. Oompa launches `devin auth login` in the exact
  profile-isolated XDG/HOME directories and reports only signed-in readiness.
- The ACP child inherits an allowlisted environment and receives no ambient
  `WINDSURF_API_KEY`, provider token, or user's global Devin configuration.
- Every child is fenced by profile id and process generation. A stale review,
  session, interaction, or reconnect is refused before another provider effect.
- Stdout is newline-delimited JSON-RPC only. Stderr is bounded diagnostics.
  Unknown ACP/vendor notifications are ignored or reduced explicitly; malformed
  protocol frames fail the connection closed.
- The neutral transcript stores bounded human/assistant text, lifecycle, tools,
  approvals, and usage projections, never raw ACP frames, credentials, or ACP
  thought chunks. ACP does not certify thought chunks as safe summaries, so
  Oompa drops their content at the provider boundary.
- Account selection remains user-directed. Oompa never switches or rotates Devin
  accounts to evade provider limits.

## Usage truth

ACP `usage_update` carries context usage (`used`, `size`) and may carry a
monetary cost. Oompa records only those supplied usage and cost facts. The
effective runtime profile separately records the exact model Oompa requested in
the launch argv. Oompa does not reinterpret context usage as account quota.

The local Devin CLI has human-facing `/usage` and `/session-stats` commands, but
ACP v1 and `devin auth status` expose no documented machine-readable allowance,
remaining balance, reset time, or reset-credit mutation. Oompa therefore reports
account allowance as unavailable/unknown and maps explicit provider refusals
such as exhausted credits or quota to bounded provider errors. It never submits
`/usage` as a hidden model turn and never invokes Codex reset-credit behavior for
a Devin account. A future cloud adapter may add administrative ACU observations
only under a separate explicit credential and authority design.

## Protocol surface

The first shipped matrix admits only:

- `initialize` with ACP protocol version 1;
- `session/new` and capability-gated `session/load`;
- `session/prompt`, `session/update`, and `session/cancel`;
- `session/request_permission` with bounded, durable Oompa interaction authority;
- the standard file/terminal callbacks only when Oompa advertises and implements
  them (the initial client advertises neither);
- standard message, tool, plan, command/config, and usage updates that have an
  explicit neutral reduction. Oompa observes the kind of an ACP thought update
  but does not read or project its content.

ACP v1 has no in-turn steering method. Oompa refuses a direct steer while a Devin
turn is active; the caller can explicitly queue the message for the next prompt
or stop the turn before sending another message. Oompa never issues concurrent
prompt requests for one session. Interrupt sends `session/cancel` and waits for
the prompt result or child termination boundary.

## Delivery phases

### 1. Pinned provider core

- **Status:** Complete.
- **Scope:** pin/version admission, exact Astra launch argv, isolated process
  environment, strict auth status projection, foreground login custody, ACP
  framing/client, fact reduction, usage parsing, and deterministic
  fixtures/tests.
- **Acceptance:** malformed frames, version drift, and an ACP v1 initialization
  mismatch fail closed; every admitted session uses the exact Astra argv;
  signed-out status exposes no identity; every child is joined on shutdown.

### 2. Product integration

- **Status:** Complete.
- **Scope:** provider and preset unions, reviewed runtime profile, daemon runtime
  selection, interaction ownership, CLI composition and account commands,
  provider switching, cloud payloads, browser selectors, and append-only SQLite
  migrations for provider `CHECK` constraints.
- **Acceptance:** no binary fallthrough can route Devin to Codex or Claude; fresh
  and upgraded databases accept Devin while retaining older rows byte-for-byte;
  all provider directions preserve their exact runtime authority.

### 3. Usage and parallel-branch convergence

- **Status:** Implementation and main-first model-routing rebase complete.
- **Scope:** persist session usage supplied by ACP; keep unavailable quota
  explicit; reconcile with `codex/provider-usage-management-20260904` and
  `codex/model-routing-autonomy-integration-20260905` without editing either
  worktree or copying unfinished state.
- **Acceptance:** Devin never enters Codex reset paths; the provider-usage branch
  can add `devin_acp` as a source without migrating this branch's meaning; model
  routing preserves frozen Codex contract 2 Astra evidence while active Codex
  selections use Sol.

### 4. Verification and delivery

- **Status:** In progress.
- **Focused gates:** Devin protocol/client/runtime/adapter tests, provider and
  preset tests, migrations, provider switching, CLI, cloud payloads, and browser
  selectors.
- **Aggregate gates:** package inventory/pins, `bun run check`, exact-history CI,
  independent review, protected-main CI, deployment, and public readback.
- **Live gate:** in a disposable isolated profile, verify exact binary version,
  signed-out and signed-in status parsing, and exact
  `devin acp --model gpt-6-astra` startup with ACP v1
  initialization/capabilities, without sending `session/prompt`. This is a
  zero-token compatibility proof, not a claim that a real turn was exercised.

## Open evidence

The installed CLI passed a zero-token check in a disposable isolated profile:
exact version `3000.6.14`, requested model `gpt-6-astra`, signed-out auth status,
and ACP v1 initialization with `loadSession: true`. No session or prompt was
created. Signed-in status remains fixture-tested only.

The renewed review repaired auth-status cancellation races during runtime
admission and process creation; cancellation during a blocked transport write;
duplicate permission replies; credential and UNC-path redaction gaps; queued
turn handoff; false incompatibility notices for deliberately omitted ACP
metadata; and cumulative transcript omission accounting. Input framing now
pauses at bounded byte/frame capacity and resumes without dropping facts.
Focused evidence is 9 auth tests, 26 protocol/client tests, and 17 adapter
tests, all passing, with focused lint checks clean. Seven rebased historical
and v39 migration tests also pass. A final cloud review repaired sequential
optional-provider status probes blocking registry publication and unrelated
device commands. The 82-test cloud adapter suite passes with bounded background
observations, fair scheduling, expiry and authority invalidation, retry backoff,
and joined shutdown. CLI cleanup enters forced recovery when observation
process cleanup cannot be proved. The exact-tree aggregate gate remains the
final local delivery prerequisite.

Claude runtime admission now forwards the caller's cancellation to its version
probe, so background account discovery can join promptly during shutdown.
All 25 focused Claude adapter tests pass, including three regression-first
account/session-review/turn-review cancellation cases.

The complete application-source suite passes all 2,397 tests. Aggregate
validation also caught a stale installer digest in release notes and a stale
social-card expectation; both are corrected. The original intermittent
invalid-terminal startup test passed 31 isolated repetitions, while review
identified unnecessary recovery work before invalid configuration rejection.
The ordering is now corrected: four invalid-input cases reject before recovery,
while valid agent execution and resume retain the mandatory recovery gate.
Independent delta review also found invalid resume descriptors and receipts
could reach recovery. Shared numeric/range/nonterminal validation and the
existing bounded receipt parser now reject those inputs first. Eleven new
invalid-input regressions failed before the fix; all 49 scenario tests now
pass, including valid-run recovery refusal. Browser review corrected a stale
settings fixture
without changing the local-only Devin login contract. Zod's three exact JSON
Schema dialect literals are reviewed bundle metadata exceptions, with path and
query variants still rejected; no origin or CSP permission was added. All 18
focused browser tests pass. The converged tree awaits the final aggregate
replay and independent delta review.

After PR #114 convergence, all 16 focused Work/provider-switch and historical
migration checks pass. Independent review confirms both directions of the
Work/switch exclusion still use the canonical v39 authority. The recovery test
table has an explicit case type; repository type checking and its 17 focused
input-boundary cases pass.

The rebased service/storage suites pass all 452 tests and the web/backend
suites pass all 723. A host-scheduler receipt integration test exceeded Bun's
default five-second budget under load; a bounded latency probe reproduced its
timeout and the resulting next-test console-capture failure. That one test now
has a fifteen-second budget for its three real validation launches and 63
Git/toolchain subprocesses. The same probe and all 15 receipt tests pass; no
runtime deadline or security assertion changed, and the probe is not committed.

- A bounded paid turn is required before claiming real-provider turn, tool,
  approval, cancellation, and usage-update acceptance. Until then those paths
  are protocol/fixture verified only.
- Model routing and its Work/provider-switch safety repair merged first through
  PR #112 and PR #114; Devin is rebased onto that protected-main source. Other
  concurrent branches remain outside this
  worktree and must converge through protected main.
