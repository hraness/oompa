---
title: Personal-home session adoption
description: Delivery plan for automatically adopting Codex and Claude Code sessions from the owner's normal provider homes without weakening Oompa session authority.
type: plan
status: completed
area: oompa
tags:
  - codex
  - claude
  - sessions
  - authority
---

# Personal-home session adoption

## Outcome

After the owner explicitly enables personal-home discovery for an Oompa account,
Oompa discovers recently active Codex and Claude Code conversations from the
owner's normal provider homes. A discovered conversation becomes an Oompa
session only after provider-specific admission succeeds. From that point onward
it has the ordinary session shape, commands, approval authority, autorespond
policy, queue, cloud projection, and grid presentation. There is no observed,
reduced-capability, or visibly adopted session tier.

## Adversarial decisions

The source proposal correctly found the isolated-home discovery boundary and
the imported-session provider bug. The following parts are rejected:

- No observed/attached tiers, adopted badge, quieter default, or approval
  downgrade. Those would contradict parity and duplicate controls that already
  work for any normal session row.
- No origin-specific account-change prerequisite or public detach command.
  Login, logout, provider replacement, and unprovable identity use one
  fail-closed recovery contract for Oompa-created and adopted sessions.
- No fabricated transcript seed and no `foreign_turn` transport-gap event.
  Provider history is projected from the provider where supported; Oompa's local
  event ledger begins when Oompa gains custody.
- No claim of a provider-wide exclusive lease. Oompa enforces one local binding,
  but Codex exposes no exclusive handoff and Claude cannot prevent a later
  external resume. Admission must state and test the narrower guarantees it
  actually has.
- No direct edits to provider state. Once admission succeeds, the pinned
  provider process may perform its ordinary writes in its own home.

Codex admission is attempted with the pinned private app-server and exact
`thread/resume`. The pinned protocol explicitly rejoins a running thread, so
that call is a policy-neutral identity, connection, and quiescence proof, not
an exclusivity proof. It must not change provider turn policy before the
durable adoption commit. Codex admission uses the user's accepted inactivity
inference: active rows and idle rows updated within 10 minutes remain pending;
idle rows older than 10 minutes are eligible inside the 15-minute discovery
window or when a present valid Codex Desktop heartbeat automation names the
exact target thread. Active and paused records both count until deletion or
retargeting; the association waives only age and is re-read around claim. After
commit, every Oompa-owned turn applies a fresh reviewed
model, workspace permission profile, `on-request` approval routing, and
`auto_review` reviewer immediately before dispatch.

Claude's private peer surface does not carry tool-approval authority, so Oompa
does not use its private key or socket. An active or uncertain Claude process
remains a candidate; after exact PID-domain, PID, and process-start evidence
proves the old process exited, Oompa resumes the same session through the pinned
stream-JSON bridge and accepts it only when `system/init` proves the requested
session ID. The new process is held under durable process authority.

## Authority model

- Personal-home discovery is opt in, scoped to one provider and one existing
  Oompa account, and defaults off.
- A provider home can be bound to at most one Oompa account on one daemon.
- Runtime-home provenance and pending discovery state remain private SQLite
  authority. They never enter `SessionRecord`, Convex, or app session heads.
- Personal-home Claude account proof transiently reads bounded account, email,
  and organization identity metadata, retains only a one-way local authority
  key, and discards the raw fields. Raw identity fields, candidate identities
  and records, runtime bindings, process identities, schedule-source metadata,
  and provider-account authority hashes are never publicly returned,
  projected, or uploaded.
- Optional cloud sync carries only encrypted provider-level discovery
  enablement and bounded pending, adopted, and fenced counts.
- The profile state machine records the isolated Codex account, so its
  `signed_in` prerequisite applies only to Codex. Every session also carries
  exact provider-specific account authority: Claude sessions remain usable
  when the profile's independent Codex account is signed out, while managed
  and personal Claude runtime scopes are fenced independently.
- Every admitted session operation resolves both the personal runtime port and
  the personal provider home from its private binding. Account login, logout,
  usage, and plugins continue to use only isolated homes (Desktop switching
  was removed on 2026-09-10).
- The installation boundary injects personal provider homes. Production uses
  the current user's canonical homes; live acceptance uses only fixture-owned
  homes and therefore cannot read or mutate the operator's provider state.
- Account authority loss is controller-neutral. Login generation advance,
  explicit logout, externally observed sign-out, provider-account replacement,
  and unprovable identity first move every affected nonterminal session into
  durable `recovery_required` state. Undispatched work is cancelled, uncertain
  work remains ambiguous, scheduled work pauses, and every exact native or
  personal-home controller held by the prior authority is released. Restart
  resumes an incomplete release, and the account and session status surfaces
  keep it visible.
- Account-authority changes require no origin-specific session action. Internal
  release and revocation machinery closes the exact provider connection or
  process while preserving provider history and foreign processes.
- A completed personal-home Codex account revocation leaves the released
  account generation fenced. Adoption status reports `restartRequired`, and
  re-enable returns `RECOVERY_REQUIRED` until daemon restart creates a fresh
  runtime generation; ordinary account reads never bypass that fence.
- Released v0.5 sessions carry no immutable provider-account authority that
  v0.6 can safely reconstruct. The upgrade migration therefore quarantines
  every proofless nonterminal session as `recovery_required`, cancels pending
  or prepared effects, leaves begun effects uncertain, pauses scheduled work,
  fails pending or begun interactions closed, and retires or fences associated
  Work execution. It preserves provider threads and local records and performs
  no provider effect. Generic recovery cannot invent the missing proof;
  abandonment is available only as an explicit acceptance of local
  terminalization with provider state unknown.

## Delivery phases

### A. Durable policy and truthful import

Status: complete; delivered in PR 113. See the delivery evidence below.

- Add an append-only schema migration for provider-scoped personal-home policy,
  pending candidates, and session runtime bindings.
- Require `provider`, provider-valid next-turn `preset`, and `fastEnabled` in
  `upsertProviderSession`; reject a provider collision.
- Add CLI commands for policy status/enable/disable and bounded discovery.
  Enabling performs an immediate discovery pass; there is no origin-specific
  public session command.

Acceptance: released v0.5 schema v33, the canonical pre-notification
provider-switch v35 layout, the exact known pre-release adoption-v35 and
adoption-v36 layouts, upstream provider schema v39, and the exact pre-release
adoption-only v39 layout migrate restart-idempotently to the combined adoption
schema v40 without confusing their colliding version numbers; proofless
nonterminal legacy sessions enter the audited fail-closed quarantine; the
isolation boundary defaults closed; repeated discovery and import are
idempotent; public session schemas do not change.

### B. Codex discovery and reviewed admission

Status: complete; delivered in PR 113. See the delivery evidence below.

- Run a second pinned Codex runtime against the canonical personal Codex home.
- Read bounded recent provider pages plus exact metadata for the bounded set of
  threads targeted by present Codex Desktop heartbeat automations. Cycle
  fairly through bounded automation-directory pages, retain a live private
  cursor, rotate the bounded starting page across daemon generations, retain
  only exact source directory identities privately, and reopen those sources
  around admission.
  Parse only bounded local TOML records, select and retain no prompt,
  working-directory, or unknown field, and never log, return, or project those
  ignored values. Never read a transcript, session index, or Desktop SQLite
  cache, and never resume a thread during discovery. Infer inactivity from the
  accepted quiet-time threshold, then use exact `thread/resume` as
  policy-neutral identity and quiescence admission.
- Replace the exact provider-generated Desktop heartbeat user envelope with
  generic protected text at the common Codex projection boundary, including
  provider-derived titles, live name facts, and an exact assistant or
  reasoning-summary echo. Hold a plausible live prefix in bounded local
  staging until its item boundary. Never project the automation id, firing
  timestamp, instructions, or a schedule-origin marker; do not reclassify
  near-matching ordinary user, assistant, or reasoning-summary text.
- Persist a normal session only after exact thread ID, current connection,
  quiescent state, and project are proven. Apply the reviewed model, workspace
  permissions, approval policy, and approval reviewer on every owned turn.
  Existing pre-effect observation,
  mutation journaling, turn IDs, interaction authority, and ambiguity rules
  remain authoritative.

Acceptance: a quiet eligible external thread becomes a normal session; an
active, recently updated, or unknown thread remains pending without a public
  session row; a later poll can adopt it; every Oompa session uses the same
  approval and autorespond integration path. A stale idle Codex thread with a
  valid active or paused heartbeat target is discovered by exact metadata read
  and admitted only while that association, account, project, liveness, and
  quiescence all remain proven.

### C. Claude durable identity and resume takeover

Status: complete; delivered in PR 113. See the delivery evidence below.

- Fix Oompa-created Claude sessions to use and validate one real provider session ID.
- Discover sessions only through bounded scalar live-session registry metadata
  that names the exact pinned version. Do not invoke an unverified discovery
  command. Prove liveness with PID domain plus exact process start, never
  registry status or socket existence alone.
- When the source process is dead, launch the normal stream-JSON bridge with
  `--resume <session-id>` and accept custody only after `system/init` matches.

Acceptance: an Oompa-created Claude session survives daemon restart; a dead external session is
resumed under the same ID; a live, unknown, copied, or mismatched candidate is
not admitted as a public session or granted runtime authority; future turns
expose the normal interaction and autorespond path.

### D. Projection, settings, and operations

Status: complete; delivered in PR 113. See the delivery evidence below.

- Route daemon and cloud reads through the session's private runtime binding.
- Poll once at daemon admission and on a bounded interval with single-flight,
  backoff, and pathless diagnostics.
- Put the opt-in control and pending counts in settings without adding any
  adopted marker to session cards.
- Document discovery limits, nonexclusive handoff, liveness confidence,
  account-revocation restart fencing, the v0.5 upgrade quarantine, the private
  candidate and authority boundary, and the pre-adoption local-event-history
  boundary.

Acceptance: the grid and public command surfaces cannot distinguish an admitted
session by capability; disabling discovery stops new claims but does not
degrade existing sessions; account loss applies the same visible fail-closed
recovery to both controller sources; daemon shutdown drains both runtime sets.

### E. Verification and delivery

Status: complete for the original source change. Release and runtime rollout
remain separate from this historical delivery.

- Run focused storage, parser, provider-runtime, service, cloud, and app tests.
- Run independent adversarial review over the converged diff.
- Run the repository final gate through the host scheduler on the exact tree,
  then follow the repository PR, merge, release, deployment, and production
  verification workflow that applies.
- Deploy the app-side optional aggregate-status reader before any daemon release
  that can upload the new optional registry field, because the previous app
  parser rejects unknown exact keys.

### Delivery evidence

[PR 113](https://github.com/hraness/oompa/pull/113) merged on 2026-09-06 at
`6f056dcafd6435cd11ae504c75e9b1f869955ca7`. Its final source
`066296513422f6c6bbecd0eff208283e051e04cb` passed 2,775 local tests,
the full build/package/install gate, and independent adversarial review as
recorded in the PR. Post-merge [CI 34040242595](https://github.com/hraness/oompa/actions/runs/34040242595)
passed macOS, Ubuntu, and Required; [CodeQL 34040242363](https://github.com/hraness/oompa/actions/runs/34040242363)
also passed for that exact merge commit. These records were read back on
2026-09-07. They close the original adoption source work, not a later tree's
validation or release and deployment gates.

The current [memory integration plan](oh-memory-civilization.md) owns the
additional model-tool binding limits for existing provider threads. The
[hosted rollout runbook](../../docs/hosted-sync.md) still governs capacity
activation and intended-target proof before current daemon writers roll out.

## Explicit residual boundary

Neither provider exposes a global lease against all later external resumes.
Codex adoption relies on the accepted 10-minute inactivity inference, and exact
resume cannot detect a still-open but quiet terminal. Claude proves that the
specific old process exited, but another process can race by resuming later.
Oompa therefore promises one Oompa binding plus exact resumed-channel authority,
not universal exclusion. The operator chooses one controller for subsequent
writes and must not resume the provider conversation elsewhere while Oompa
controls it.

Oompa does not answer an approval already delivered only to another controller
and does not fabricate that authority. Pre-adoption content can appear through
a real bounded provider projection, but Oompa's local event export begins at
admission. The pinned Codex resume method also cannot add a thread-creation-only
dynamic tool to a thread that never had it. That limits model-originated
automation changes in arbitrary existing Codex threads, not the public Oompa
session commands, scheduler, approval authority, or autorespond path.

## Provider timestamp recovery repair

Status: complete. [PR 122](https://github.com/hraness/oompa/pull/122) merged on
2026-09-06 at `576ccd76a6742cd62759ab6176a6a41844846daa` with successful
macOS, Ubuntu, Required, and CodeQL checks. [Issue 121](https://github.com/hraness/oompa/issues/121)
closed at 20:03:05 UTC that day. The later Sol/schema join landed through
[PR 123](https://github.com/hraness/oompa/pull/123) at
`97cebc44ecd2d27b8c0b6399b0814b1993d94fc1`. These are historical source
delivery records, not admission of the subsequent memory candidate.

Codex thread parsing converts provider epoch seconds to milliseconds. An old
unmarked stop or rename baseline must not become evidence of advancement merely
because a later read uses the converted unit. The parser now establishes the
private `unix_milliseconds_v1` marker only after safe conversion, and the runtime
adapter propagates it conditionally. Bare adapter projections remain unmarked.

New stop and rename effect evidence may record that marker at the top level.
Recovery requires both the recorded baseline and the observed projection to
carry it, both timestamps to be nonnegative safe integers, and strict time
advancement. Existing exact thread, old-turn absence or terminal state, and
requested-name proof remains necessary. Direct confirmed receipts and causal
send, steer, and queue recovery retain their existing authority.

The shared three-field provider baseline is unchanged. No existing evidence or
resolution is rewritten, normalized, or inferred from timestamp magnitude. The
typed store refuses invalid new proofs before writes. Schema 41 adds one insert-only
SQLite guard, `mutation_resolutions_timestamp_proof_insert`, and its migration
ledger entry. The guard refuses invalid new stop/rename resolutions, requires
the proof to agree with the resulting session snapshot, and requires SQL NULL
receipts for non-proven resolutions. Exact schema 40 writable migration
admission requires its migration ledger row and frozen Work authority surface.
Exact schema 41 admission requires the exact stored timestamp guard and the
exact `[40, 41]` ledger tail with nonnegative safe-integer application times
before the Work migration. Schema 42 retains that exact timestamp guard and
ledger history, then replaces only the reviewed Work authority guards for
active Sol routing and records its own migration entry. Schema 43 adds
append-only transcript-finalization bits to the existing mutation and queue
source-authority rows, fencing pre-v43 dispatched sources without retaining a
second per-message ledger. At that repair checkpoint, schema 43 opens required the exact
`[40, 41, 42, 43]` ledger tail and all current authority surfaces before
maintenance; missing or altered guards are refused without repair.
Schemas 40 and 41 remain immutable predecessors, and readonly older databases
retain the migration-required policy. Public and cloud projections omit the
private unit marker.

Acceptance requires real-parser legacy-unit regressions, positive and invalid
marked observations, typed and raw SQL atomic refusal, unchanged historical
bytes and digests after reopen, and public projection privacy. Focused parser,
adapter, service, and storage proof tests pass. The schema-41 compiler and
changed-file lint checks passed. The storage and CLI migration run passed 265
tests and exposed two fixture errors; both were corrected and the focused
rerun passed seven tests with 370 assertions. The merged PR and successful
checks above close the repair's integration and delivery. Later schema 44
approval budgets and schema 45 authentication recovery retain these historical
proof rules; later after-hours and memory migrations retain those predecessors. No live
provider or native authentication claim is needed for these local proof rules.
