---
title: Oompa v2
description: Proposed plan to make Oompa a provider-neutral control plane for humans and agent swarms, covering the agent CLI contract, a keyboard-first web surface, robustness and decomposition, typed routing policy with route receipts, a Claude provider behind the Codex seam, and a rewritten public surface.
type: plan
status: proposed
area: oompa
tags:
  - bun
  - cli
  - codex
  - claude
  - convex
  - web
  - routing
relations:
  related-to: [ plans/oompa-v1, notes/agent-first-coordination, notes/web-ux ]
---

# Oompa v2: provider-neutral control plane for humans and agent swarms

Domain update, 2026-09-10: [the current domain plan](./oompa-app-domain.md) supersedes earlier host choices in this record. Current website and app destinations are `oompa.app` and `app.oompa.app`; prior hosts grant no current routing or authentication authority. Dated delivery evidence remains historical.

Status: proposed plan, revision 3 (2026-09-02). Not yet adopted. `oompa-v1.md` remains the plan of record until the owner adopts this file. Revision 1 was reviewed adversarially from three angles (engineering feasibility, product fit, security and invariants) and revision 2 by a consolidated verification pass; every finding and its disposition is in the review log at the end.

Authority update (2026-09-04): Phase 8A of [Model routing and bounded autonomy](model-routing-autonomy.md) supersedes this proposal's blind remote-approval design. Current remote interaction policy may decline an offered command, permission, or file-change request, and may answer only a provider-proven, non-secret closed-choice user question contract. All grants and accepts, free-text and Other responses, and MCP answers remain on the execution device. The older approval work items below remain historical proposal context only.

Source evidence: six independent audits of the `v0.1.6` tree (commit `86648e8`) covering the agent-facing CLI, the web surface, architecture and robustness, model routing and swarm coordination research, the Codex provider seam, and marketing and documentation. Load-bearing findings are restated here with `file:line` citations so this plan stands alone. The web UX contract derived from the audit is committed as [Web surface UX contract](../notes/web-ux.md).

Every work item carries a tier. `P0` is the minimum lovable cut and ships first. `P1` follows. `P2` runs only when a lane is idle. If the swarm falls behind, `P2` is dropped first, then `P1`, never `P0`.

## Outcome

Oompa becomes the control plane a person or an agent swarm uses to run several coding-agent subscriptions side by side, with one contract for humans (terminal shell and a keyboard-first web surface) and agents (one machine-readable CLI schema, one additive envelope, one work protocol). Codex remains the first provider on macOS and Linux. Claude subscriptions become a second Linux-only provider executed through a realpath-resolved installed Claude Code executable whose exact self-reported version must match Oompa's compatibility pin, with Oompa never touching the credential. That version assertion is not package-byte provenance. macOS Claude support stays withheld until authenticated testing proves isolated Keychain custody and detached-daemon reads without a prompt. Routing and coordination policy moves from prose in skills to typed, fail-closed rules with local route receipts, so the swarm's behavior is measured rather than described.

The plan is complete when:

1. A new Linux user installs Oompa with one readable package-manager command, reaches a first useful command in under 60 seconds from a clean machine using only the README, links a Codex account and a Claude account from the shell, checks both from `--json`, and drives sessions on both providers from the shell and from a browser enrolled as a device. Claude authentication remains local and TTY-only; browser account linking is Codex-specific. The equivalent macOS criterion remains open until the Keychain and detached-read acceptance passes.
2. An agent learns the entire CLI offline from `oompa schema --json`, reaches its first `oompa work apply` in two calls using `oompa work protocol --topic examples`, receives `requestId` on every response and `error.exitCode`, `error.retryable`, `error.recovery` on every failure, and can pass `--idempotency-key` to every mutation.
3. Work tasks declare a class, Oompa rejects violations at admission, requires an independent reviewer for edit- and release-class work, and `oompa work routing-report` shows repair and revise rates per class, preset, and provider from durable local route receipts. Release-class work follows the standing-authority and workload-identity policy in [Hraness delivery autonomy](delivery-autonomy.md), with no duplicate conversational gate.
4. No file in `src/daemon`, `src/storage`, or `src/cli` exceeds 3,000 lines; `service.ts` has no switch over more than 20 command kinds; the merge log for waves 3 onward shows no two concurrent PRs touching the same file in those directories; `check:fast` runs the product tests in parallel in under five minutes.
5. The README is under 800 words, a stranger can state the thesis after one pass, docs are generated from one content source, and the site ships no client analytics bundle.

## What the audits found

| Angle | Verdict |
| --- | --- |
| Agent-facing CLI | Best-in-class JSONL framing and exit codes; weak discoverability. Help is literal strings (`src/cli/parser.ts:138-376`), no leaf help, no schema export, envelope drift across `init` (`src/cli.ts:2228`), `doctor --offline` (`:2376`), and `work apply`; `work protocol` is a pure function routed through the daemon behind `assertInstallationHome` (`src/cli.ts:4655`); `--idempotency-key` is accepted on 11 of about 25 mutations. |
| Web surface | No logged-in UI exists; `site/` is static and the plan of record excludes a web app (`kb/plans/oompa-v1.md:502`). Convex stores ciphertext for all content, and the account key is unwrappable only by an enrolled device's P-256 key (`src/cloud/crypto.ts:378-410`). All crypto is WebCrypto, so a browser can be a device with no schema or function changes for a read-plus-remote-command MVP. Hosted sync itself is not yet live (`kb/plans/oompa-v1.md:523`). |
| Architecture | No P0. Nine P1s: transport admission is one undifferentiated pool of 32 slots (`src/daemon/local-transport.ts:218`) although v1 specifies a 16/16 split (`kb/plans/oompa-v1.md:338`); queue scrub stops the daemon when a readonly opener holds the DB (`src/storage/state-store.ts:2394-2404`, `src/storage/work-store.ts:1052` via `state-store.ts:3768`); Codex child is orphaned on daemon crash (`src/codex/process.ts:38-43`, `src/codex/client.ts:1249-1261`); two cloud writers (`src/cli.ts:2667` vs `:2933`); layer inversion through `src/cloud/contracts.ts`; retired release code still gating CI; no socket-level e2e. Static discipline is excellent: zero `any`, exhaustive switches, 537 zod schemas, STRICT SQLite. |
| Routing and swarm | The coordination substrate (claims, fences, leases, request-before-effect, receipts) is rigorous and in code (`src/storage/work-store.ts:3454-3866`). The routing policy (what runs where, on which model, with how much effort, when to verify) is prose interpreted by the LLM (`plugins/hra-local-efficiency/skills/hra-local-efficiency/SKILL.md:56-122`). Research consensus: static role tiering plus independent verification beats learned routers and cascades for agentic coding; specification and verification failures dominate multi-agent failure taxonomies. |
| Provider seam | Already ports-and-adapters (`src/daemon/ports.ts:123-183`, single implementation). Provider names appear in six public contract points: `source: "codex_app_server"`, `reason: "codex_*"`, handoff `type: "codex_device_login"`, `doctor --json` `runtime.codex`, Convex `codexAccounts`, `codex_` public ids. Claude has no app-server; the driveable seam is the pinned Agent SDK (the `claude-agent-sdk` package, version 0.3.258, verified against its `sdk.d.ts`), `CLAUDE_CONFIG_DIR` is the official home analog, rate-limit windows arrive in-band as `rate_limit_event` messages, there are no reset credits, and the legal page permits an end user signing in to the unmodified binary with their own subscription while forbidding any third party to collect, store, or intermediate credentials. |
| Marketing and docs | README is 7,662 words opening with an 871-character installer and no thesis sentence. Scores 8 of 24 against gum, uv, opencode, jj, goose, and claude-code on hero, install, demo, badges, docs, positioning. Site ships a 253 KB analytics bundle on a two-page product page and an SVG social card that major unfurlers do not render. The provenance story is the strongest trust asset and is invisible. |

## Guiding decisions

### D1. Provider port is Oompa-owned, ACP-aligned in vocabulary, native in transport, extracted after the second provider works

Oompa defines `ProviderAdapter` with declared capabilities and an Oompa-owned neutral event schema whose kind names follow Agent Client Protocol (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`; permission options `allow_once`, `allow_always`, `reject_once`) with an opaque bounded `ext` slot. Codex keeps the pinned app-server client. Claude drives the pinned Agent SDK `query()` with Oompa's env-scrubbed spawner through `spawnClaudeCodeProcess`, one `CLAUDE_CONFIG_DIR` per profile, `settingSources: ["user"]` scoped to that home, and `strictMcpConfig: true`.

Order: the Claude adapter is built first as a second implementation of the existing runtime port (`src/daemon/ports.ts`) with capability flags, modeling each per-session `query()` as a connection under the profile's existing `processGeneration` (fencing is already `(profileId, processGeneration, connectionId)`). `ProviderAdapter`, the neutral event schema, and `RuntimeAuthority { profileId, profileGeneration, runtimeKey, runtimeGeneration, home }` are extracted afterwards from two working implementations. This follows the repository's own rule to add a boundary only for a concrete second consumer.

Copied from prior art: Vibe Kanban's executor-per-agent with `AuthRequired` and `FollowUpNotSupported` capability errors and a `PendingApproval` tool status; goose's move from CLI-as-model to CLI-as-agent; OpenHands' preference for cached subscription login directories over API keys; ACP's event-kind and permission-option names; the Vercel AI SDK usage shape.

Rejected: ACP as the internal seam (omits accounts, login state, rate limits, reset credits; adds an unpinned process that hides exact ids). Rejected: raw `claude -p` stdio (control-protocol wire format undocumented). Rejected: any design in which Oompa reads, stores, or forwards a Claude credential, including `claude setup-token` output.

Terms reading, stated so it can be checked later: on Linux, `oompa account login <profile> --provider claude` drives the user's own login as a foreground, TTY-only invocation of a realpath-resolved installed Claude Code executable after its exact self-reported version matches Oompa's compatibility pin inside that profile's isolated `CLAUDE_CONFIG_DIR`. That assertion is not package-byte provenance. The Claude CLI owns the prompts and browser handoff. Oompa never sees a token, does not disable any built-in authentication method, and declines to forward ambient values. Ctrl-C reaches the foreground process group while Oompa observes and joins the exact child. Claude has no Oompa device-code, detached handoff, web-linking, or ordinary background cancellation flow. Oompa durably grants one child launch; an exact completion can settle it after daemon restart. When the account is signed out, login can locally release and terminalize only quiescent idle Claude sessions, without deleting their provider threads; active turns, queued work, pending interactions, recovery, and unsettled provider authority refuse. Only after confirming that child exited may an operator run the status-provided, fully bound `login-cancel --provider claude ... --acknowledge-child-exited` recovery command, which releases the local fence without stopping Claude or reading or changing credentials. `oompa account show <profile> --provider claude` runs a bounded, non-interactive `claude auth status --json` probe, transiently validates the status document, discards identity and usage fields, and projects only `signedIn`; credential presence alone never settles an unresolved child. One Oompa profile owns independent Codex and Claude homes, so neither provider's authentication state determines or mutates the other's. Oompa refuses new Claude provider effects on macOS pending authenticated isolated-Keychain and detached-read acceptance. A profile may opt into `apiKeyHelper` with a Console key inside its own `settings.json`, outside Oompa custody. Claude profiles default to a per-account concurrent-session cap of 2, user-raisable, and `docs/providers/claude.md` states plainly that swarm-scale traffic may be judged non-ordinary by the provider.

### D2. Routing policy lives in code, never selects accounts or routes, and is measured

A typed `RoutingRule` table keyed by `taskClass` (`research | review | edit | verify | integrate | release`) decides allowed presets, lanes, review requirements, reviewer difference, attempt and lease budgets, workspace exclusivity, and whether a human decision is required. `effectClass` and `lane` default from `taskClass` and the declared route so a coordinator declares one field. Oompa validates at `work.create` and `task.addBatch` admission and rejects violations with `INVALID_INPUT` and a `routing_rule_violation` detail, the same fail-closed posture as `ROUTE_MISMATCH`. Existing work documents without a class are admitted as `unclassified` with `read` effect only.

Kept: user-directed account selection, never automatic rotation (`AGENTS.md:25`). Kept: routes are immutable; Oompa never dispatches on a preset or account the coordinator did not declare. Added: a same-account quota admission gate that delays dispatch on the declared account when its provider-read weekly window is at or above 99 percent with no reset credit and fresh coverage. The `UNAVAILABLE{retryAt}` response and the worker brief name no alternative account or route. The capability matrix row "Token or quota budget enforcement" changes from "Observational" to "Same-account admission gate; never selects another".

Rejected: learned routers and cascades (low-volume heterogeneous traffic; a failed cheap edit churns the tree). Adopted from the research: route receipts as durable local artifacts, an independent verifier, non-empty criteria before edit-class work, effort budgets per class, repetition and stall detection. External effects get an independent review rather than a human gate while Oompa is a beta.

### D3. The web app is an enrolled browser device over the compact projection

The browser authenticates with the existing email-code flow, generates non-extractable P-256 keypairs, registers as a `browser`-class device that can never approve other devices and never be the first device, is approved from a CLI device against a displayed public-key fingerprint, binds its auth session by signature, and unwraps the account key into memory only. It renders the compact projection and submits remote commands. For F2 and F3 the only Convex changes are `deviceClass` on registration, `register` and `approve` rejecting that class as F2 specifies, and one auth-config origin change; F4 adds one command kind and F5 one bind-to-session function, both in the register. Separate origin `app.oompa.dev` with a strict Content Security Policy, no service worker, no previews against production, no analytics.

Decided: remote decisions for `command_approval` and `permission_approval` are in scope with `once` scope only, carried as an encrypted command kind with `(interactionId, revision, decision)` and custodian-side compare-and-set. The remote approver decides on the bounded `commandClass` and summary in the projection, never on exact command text or permission values, which never leave the custodian; the policy note names this as blind approval and adversarial invariant 17 (`kb/notes/agent-first-coordination.md:321`) is rewritten accordingly. `file_change_approval`, `session` scope, Claude login, and usage refresh from the web are never remote. Claude login remains a local foreground TTY flow.

The UX is the committed [Web surface UX contract](../notes/web-ux.md). Hosted sync must be live for the owner before any web item can produce live evidence; until then web items are demonstrated against a local Convex dev deployment and count as deterministic-only.

### D4. One command descriptor generates help, parsing, schema, and docs

The `work-protocol.ts` descriptor pattern becomes the description for all roughly 75 leaves: help at root, group, and leaf; `oompa help [group [leaf]] --json`; `oompa schema` via zod v4 `toJSONSchema`, itself versioned and snapshotted; README and docs CLI reference generated from it and diffed in CI. The hand-rolled parser and its security properties stay; the descriptor sits above it.

### D5. The public JSON contract only grows

No envelope version bump. `requestId`, `command` on `init` and `doctor --offline`, and `error.exitCode`, `error.retryable`, `error.recovery`, `error.nextCommand` are added to the existing `version: 1` envelope. `work apply` keeps the strict `hra-work-local-v1` response document unchanged; it already carries those fields and is the model the rest adopts. Provider vocabulary is never renamed: `reason: "codex_*"` stays as the Codex provider's reasons, `provider` is added beside `source` and inside error `details` and the handoff document, and new providers emit their own reasons. `session wait` stays reserved by OBS-008; the client-side composition ships as `session poll-until` with documented lost-wake semantics.

### D6. Structural decomposition precedes swarm-scale parallel work, and does not overlap feature work in the same files

`StateStore` (one class, 130 public methods, 15 aggregates) and `OompaService` (61-arm switch) are split so ownership maps to files. Within any wave the integrator assigns exactly one owner per file for `src/cli.ts`, `src/cli/parser.ts`, `src/cli/render.ts`, `src/daemon/service.ts`, and `src/storage/state-store.ts`, and items sharing one of those files land serially. Waves that split a file do not schedule feature work in that file. A `scripts/check-security-primitives.ts` count invariant guards the moves.

### D7. The gate goes on a diet and install becomes a package-manager command, with every dropped guarantee named

`bun add -g @hraness/oompa@<version>` becomes the primary install; the verified installer moves to a hosted file and a "verify this release" page; `oompa doctor --offline` verifies the installed package manifest and empty lifecycle scripts after the fact. The release workflow keeps every guarantee it proves today (listed under H2). Descendant-lifetime custody and pidfd crash recovery for release tooling are the guarantees dropped, documented as such, and the Linux reaper source is retained for live acceptance.

### D8. Docs are generated from one content source, the README is short, and positioning is provider-neutral

`site/content.ts` stays the single source and grows `readme`, `docs`, and `site` targets. Oompa is positioned as a control plane for coding-agent subscriptions, with Codex on macOS and Linux and Claude Code on Linux, in every description, card, and badge.

## Workstreams

Effort: S under one day, M one to three days, L over three days, for one engineer or agent with review. Items marked `day-one` are independent in meaning; file ownership per D6 still applies. Evidence marked `live` cannot be produced deterministically.

### A. Robustness and security fixes

| # | Tier | Item | Effort | Evidence |
| --- | --- | --- | --- | --- |
| A1 | P0 | Transport admission: implement the v1-specified 16 command and 16 long-poll partition (`kb/plans/oompa-v1.md:338`), respond to slot 33 with a closed `UNAVAILABLE` before closing, add a 5 s header timeout and an idle timeout distinct from the 180 s deadline, drop request buffers after `handled` (`src/daemon/local-transport.ts:218, 259-299, 476-517`). Expose slot occupancy, long-poll count, waiter counts, poller health, and last scheduler diagnostic in `oompa daemon status --json`. day-one | S | Test: 32 concurrent long polls do not block `daemon.stop`; overload reports `UNAVAILABLE`, never indeterminate. v1 evidence table updated. |
| A2 | P0 | Scrub self-stop: exclude readonly opens from `assertWorkSchema`'s `foreign_key_check` (`src/storage/work-store.ts:1052`, called at `state-store.ts:3768`), raise the scrub busy timeout to 5 s, retry with backoff before `StateSecurityScrubRequiredError` (`state-store.ts:2394-2404`). day-one | S | Test: `oompa status` during queue settlement does not stop the daemon. |
| A3 | P0 | Codex child custody: spawn in its own process group and kill the group on terminate, terminate the child on stdout EOF or protocol fault (`src/codex/client.ts:1249-1261`), journal pid plus boot id and reap at next daemon boot, set explicit `cwd` (`src/codex/process.ts:38-43`). The process group is a cleanup aid, not an authority proof, consistent with the v1 review finding at `kb/plans/oompa-v1.md:639`; that finding is amended to say the daemon's Codex child uses group cleanup plus a boot-id journal. | M | Deterministic: unit tests for group kill and journal. `live`: SIGKILL the daemon mid-turn; next boot reaps the app-server and MCP grandchildren (covered by B7's e2e once it exists). |
| A4 | P0 | Ledger gaps: record `account.login-cancel` before dispatch (`src/daemon/service.ts:2733-2740`); transition the mutation before `assertCurrent` on the `#effect` failure path (`:6255-6268`); route `observeCodexAccount` through a CAS tolerant of `signed_in` at login commit (`:1520`). day-one, same owner as A5 | S | Every Codex mutation has a `mutation_attempts` row; three regression tests. |
| A5 | P0 | Background hygiene: rejection handler on the usage poller (`src/daemon/usage-poller.ts:71`), a process-level `unhandledRejection` handler that publishes a `failed` receipt, scheduler errors surfaced as diagnostics, `#sessionFactEpochs` pruning, `SessionEventWaiters` abort-listener cleanup (`src/daemon/session-event-waiters.ts:71-74`). day-one | S | Test: a throwing `listProfiles` does not halt polling silently. |
| A6 | P1 | Shutdown budget: join deadline proportional to the longest provider mutation deadline, or transition in-flight `effect_started` rows to `ambiguous` before `exit(70)` (`src/cli.ts:3155-3165`). | S | Test: a 30 s `turn/start` in flight at shutdown does not quarantine the session. |
| A7 | P1 | Single cloud writer: route `oompa remote *` through the daemon when one is present, else a read-only CLI path that enqueues nothing (`src/cli.ts:2667` vs `:2933`). Note the UX change for a machine that is only a remote client. | M | No second `LocalCloudControl` writer; spurious "changed concurrently" `UNAVAILABLE` gone from remote tests. |
| A8 | P1 | Retention and startup cost: age-based prune of terminal rows only (never `effect_started`, `ambiguous`, `recovery_pending`) for `mutation_*`, `provider_interactions*`, `desktop_switches`, `turn_summaries`, `work_events`, `work_task_history_versions`, and `work_route_receipts`; `maintainSessionEventRetention` on a daemon timer; per-open sweeps behind a "schema just migrated" flag; `DaemonLock.assertCurrent` (`src/daemon/daemon-lock.ts:616-628`) reuses the `sqlite_schema` probe at `:461`. New local-retention section in `docs/retention.md`. | M | `oompa status` open time is O(1) in table size; migration test. |
| A9 | P0 | Codex pin ergonomics: one `CODEX_PIN` constant for the 14 non-test sites in 9 files, decouple the usage-metrics digest domain from the pin (`src/domain/usage-metrics.ts:334`), `bun run codex:bump` regenerates schema and matrix digests. day-one, lands before A3 so D2's baseline is the post-wave-1 tree | S | Bumping Codex is one constant plus one script run. |
| A10 | P0 | Wave-0 security items from the architecture audit: OTP digest compared with `timingSafeEqual` (`convex/authDelivery.ts:268` and the consume path); `daemon run` and `$EDITOR` spawned with the allowlisted env rather than `process.env` (`src/cli.ts:2035, 2417`); Convex HTTP response bodies byte-bounded (`src/cloud/client.ts:101-149`); per-key GCM message budget with a rotation trigger (at 2^31 messages the writer refuses further chunks with `KEY_ROTATION_REQUIRED` and the CLI directs the user to the existing key-version rotation); redaction patterns for unlabelled secrets (`src/sensitive-text.ts:9-33`); `scripts/check-security-primitives.ts` asserting per-file counts of `timingSafeEqual`, `O_NOFOLLOW`, `fsync`, mode checks, `validateOwnedFile`, `#assertFence`, `assertCurrent` around `#fencedEffect`, `.immediate()`, `secure_delete`, `synchronous=FULL`, `SAFE_ENVIRONMENT_KEYS`, and write-time redaction sites. day-one | M | Each item has a test; the primitives check runs in `check:fast` and must be edited deliberately when a count changes. |

### B. Structural decomposition

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| B1 | P0 | Layer DAG: move `isUuidV7`, `redactAbsolutePaths`, `isRecord`, `hasExactKeys`, `assertNever` from `src/cloud/contracts.ts` to `src/domain/`; move `AccountKeyLossPreconditionError` and `createCloudUuidV7` out of `local-control.ts`; move desktop journal types imported by `state-store.ts:121-125` to `domain/`; ESLint `no-restricted-imports` boundary rule per directory. day-one | S | - | Lint fails on upward imports; zero file-level cycles. |
| B2 | P1 | Storage extraction: `storage/migrations.ts` (schema constants, runner, `assertSchemaVersion24Objects`) and `storage/security-scrub.ts`. | S | B1, A10 | ~2,800 lines leave `state-store.ts`; no caller changes; primitives check unchanged. |
| B3 | P1 | Per-aggregate repositories behind the existing `StateStore` facade: profiles, projects, sessions, queue, mutations, desktop-switch, session-events, interactions, rate-limit-reset, usage, daemon-state. Convert `work-store.ts` row casts to `.strict()` zod row schemas as each repository is touched, exercised against every migration fixture. | L | B2 | Facade keeps method names; `service.ts` untouched in the first PR; per-repository test files. |
| B4a | P0 | `daemon/mutation-ledger.ts` and `daemon/compose.ts` extracted from `src/cli.ts:2804-3188` and `service.ts`, facade-preserving, because D3 and B7 need them. | M | B1 | D3 and B7 compile against the new files; `cli.ts` loses the `runDaemon` body. |
| B4 | P1 | Service decomposition (rest): `usage-service.ts`, `work-facade.ts`, `interaction-service.ts`, `provider-fact-projector.ts`, and `cli/commands/*.ts`. Split `service.test.ts` along the same seams. Each moved boundary gets or updates its `AGENTS.md`. | L | B3, B4a | `cli.ts` under 800 lines; no file over 3,000 lines in `src/`. |
| B5 | P2 | Cloud consolidation: `cloud/wire.ts` with zod parsers replacing drifted duplicates in `local-control.ts` and `daemon-bridge.ts`; closed error codes in the bridge; split `local-control.ts`. | M | B1 | One parser per wire shape. |
| B6 | P0 | Test parallelism: fix the `process.env.HOME` writes (`src/cli.test.ts:4282, 4893`) and `HRA_CONVEX_URL` writes (`:3809, :3826`), a test-only `synchronous=OFF` constructor option unreachable from CLI, env, or `daemon run` composition with a test asserting production opens FULL, then remove `--max-concurrency=1` and document why it existed. Record baseline timings first. | M | H1 | `state-store.test.ts` under 5 s from a recorded ~30 s baseline; `bun test ./src` in parallel under 3 min. |
| B7a | P0 | Minimal JSON snapshot harness: snapshot directory, temp-path redaction, CI diff. | S | B6 | Snapshot directory diffed in CI. |
| B7 | P1 | Test depth (rest): one socket-level e2e (spawn `daemon run`, drive via `main()` without injected transport, kill -9 mid-turn, assert child reaping), fast-check properties for queue and session transitions, work fences, cursor codec tamper, streaming redaction; snapshot files for every `--json` output. | M | B7a, A3 | Snapshot directory diffed in CI; storage property tests from 0 to at least 8. |

### C. CLI contract

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| C1 | P0 | Serve `work protocol` before `assertInstallationHome` (`src/cli.ts:4655-4658`). day-one, same owner as C2 | S | - | `oompa --json work protocol` succeeds on an uninitialized root. |
| C2 | P0 | `oompa help` alias, leaf-level help, `--json` for `help` and `version`, curly-quote fix (`src/cli/parser.ts:182`), doctor exit code and envelope agree (`src/cli.ts:4805-4811`). day-one | S | - | `oompa session events --help` prints only that leaf. |
| C3 | P0 | Additive envelope: add `command`, `requestId`, `error.exitCode`, `error.retryable`, `error.recovery`, `error.nextCommand` to the `version: 1` envelope everywhere except `work apply`; usage errors go to the same stream in `--json` and `--jsonl`; `nextCommand` passes `redactAbsolutePaths`; `recovery` is the closed directive enum; `requestId` is a fresh UUIDv7 never reused as an idempotency key and never sent to Convex. Integrator-owned PR, the largest single merge of the plan. | M | B7a | Snapshots for every command; README envelope section regenerated. |
| C4 | P0 | Usage errors name the option when it matches `^--[a-z][a-z0-9-]{0,62}$`, values never echoed, zod issue paths limited to schema-known keys and integers, group usage rather than root, nearest-option suggestion from the known set (`src/cli/parser.ts:550, 556, 609`; `src/cli.ts:4874`). The v1 finding text becomes "never repeats untrusted argv except a bounded ASCII option name". | S | - | fast-check property: no 4-byte substring of a non-matching token appears in any usage error. |
| C5 | P0 | Command descriptor: `src/cli/spec.ts` describing every leaf; help rendered from it; parser validated against it; `oompa schema [--json-schema]` versioned and snapshotted; README and docs reference generated and diffed in CI. | L | C3 | One source; CI fails when `oompa --help` and the generated reference diverge. |
| C6 | P0 | `--idempotency-key` on every mutation including `session preset|fast|project|note set|note clear`, `auth logout`, `remote *`; v4 or v7 accepted at the CLI boundary; one replay shape `details.replay: {command, arguments}`. | M | C3 | Every `idempotencyKey` in `localCommandSchema` reachable from argv. |
| C7 | P1 | Pagination `page: {nextCursor, expiresAt, limit, returned, omitted}`; `Continue:` hint on every paged output; `--flag=value`; specific duplicate-option error. | S | C3 | Snapshots. |
| C8 | P0 | `oompa session poll-until <id> --until idle|interaction|turn:<id> --timeout <ms> --json` composed client-side from status and events, with documented lost-wake semantics and its own INVARIANTS row; `session wait` stays reserved by OBS-008. Global `--timeout` for one-shots. | M | C3 | Agent recipe shrinks from two subprocesses to one. |
| C9 | P0 | Work onramp: `work protocol --topic examples` with one request document per operation kind, `oompa work list`, did-you-mean for `--type` names. Any work protocol shape change is scheduled here as `hra-work-local-v2` with a dual-accept window and regenerated shards. | M | C1 | First `work apply` from an agent takes 2 calls. |
| C10 | P1 | Shell: opt-in in-memory history holding only shell verbs and session text, dropping any line with sensitive-label evidence, cleared on exit and `Ctrl+l`, never in diagnostics; tab completion for slash verbs and selectors; one-line compact live events; collapsed repeated notices; `/help` to stderr (`src/cli/shell-terminal.ts:530`, `src/cli/shell-live.ts:380-403`). | M | - | Shell tests; a two-account session transcript fits one screen. |
| C11 | P2 | `--fields a,b` projection for `--json`. | S | C3 | Test. |

### D. Provider port and Claude

Current platform decision: D3 admits Claude effects only on Linux. macOS fails closed before provider launch until D2's authenticated isolated-Keychain and detached-read acceptance passes.

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | P0 | Additive provider vocabulary, nothing renamed: `provider: "codex"` beside `source` (`src/domain/observation.ts:166, 445`) with the literal widened to an enum and OBS-007 updated; `provider` inside error `details` and the handoff document with `type` unchanged (`src/cli/protected-output.ts:474, 581`); `runtime.providers.<id>` beside `runtime.codex` in `doctor --json`; `providerHome(provider)` returning the existing on-disk `codex-home` with `src/desktop/*` callers staying Codex-typed; human labels from the profile's provider display name. | M | C3; not concurrent with B4 | Observation, render, CLI, and content tests updated; INVARIANTS OBS-007 row amended. |
| D2 | P0 | macOS Keychain probe: does a detached daemon spawning the exact version-admitted Claude Code executable under each of two authenticated per-profile `CLAUDE_CONFIG_DIR` homes read only that directory-keyed Keychain item without prompts? The unauthenticated probe does not prove this, so the release ships Claude Linux-first and refuses new macOS Claude effects. Oompa never stores a `setup-token` or any `sk-ant-oat` value under any outcome. | S | - | Still open: authenticated isolated-Keychain and detached-read acceptance against the exact self-reported version pin. The available host has 2.1.261 while Oompa pins 2.1.260. `live`. |
| D3 | P0 | Claude adapter as a second implementation of the existing runtime port behind capability flags: each existing profile owns an independent `<state>/profiles/<id>/claude-config` home exported as `CLAUDE_CONFIG_DIR`, alongside its Codex home and without a `profiles.provider` discriminator. `oompa account login <profile> --provider claude` is a foreground, TTY-only run of the version-admitted CLI path with `auth login --claudeai`; Ctrl-C reaches the foreground process group while Oompa observes and joins the exact child. Claude has no Oompa device-code, detached handoff, web-linking, or ordinary background cancellation flow. A durable one-child grant survives daemon restart; exact completion settles it, while a fully bound `login-cancel --provider claude ... --acknowledge-child-exited` can release only the local fence after the operator confirms the original child exited. `oompa account show <profile> --provider claude` runs bounded `auth status --json`, validates exit and payload coherence, discards identity and usage fields, and projects only `signedIn`; neither path reads credential files or consults or mutates Codex `profile.state`, and credential presence does not settle an unresolved child. `session.start` allocates the session id locally and the first `send` spawns `query({sessionId, cwd, permissionMode: "default", canUseTool, includePartialMessages, env, settingSources: ["user"], strictMcpConfig: true, spawnClaudeCodeProcess})`; later sends use `streamInput` while alive or `resume` after idle close, treating a changed session id like `thread_mismatch`; `stop` maps to `interrupt()`; `steer` absent by capability; approvals map `Bash` to `command_approval`, edits to `file_change_approval` (admissible for Claude only, with OBS-010 gaining a per-provider capability clause, a test that Codex still rejects before storage, path and diff rendered only through the protected handoff, and `allow_always` and session scope refused for edit tools), other tools to `permission_approval`, `AskUserQuestion` to `user_input`; a deny on the 30-minute deadline is journaled as `interaction_timeout`, never as a user decision; usage windows from the SDK's in-band `rate_limit_event` messages and the result message's `rate_limits` as `UsageWindow{windowKind: five_hour | seven_day | seven_day_opus | seven_day_sonnet, authority: provider_pushed}` with velocity `unavailable`, no hook installed; auto-reset disabled by capability; per-account concurrent-session cap default 2; `accountKind: subscription | api_key_helper` reserved. Presets map to SDK options as `low -> {effort: low}`, `high -> {effort: high}`, `ultra -> {effort: max}` with the SDK default model until D4 keys presets per provider; `cwd` is the session's bound project root and `session.start` requires one for Claude. Pin the accepted self-reported CLI version and SDK, vendor and digest `sdk.d.ts`, and parse every message from `unknown`. New `src/claude/AGENTS.md`. | L | D2, C3, B4a | Deterministic: unit tests over recorded SDK message fixtures plus login/status parser, process, cancellation, restart recovery, concurrency, and provider-isolation tests. `live`: acceptance with a real Claude profile on Linux and, if D2 passes, macOS; OBS-007 evidence tier for Claude starts "unproved live"; the daemon surfaces `signed_out` on refresh expiry and never re-logs in unattended. |
| D4 | P1 | Extract the port from two implementations: `src/provider/{port.ts, events.ts, usage.ts, registry.ts}`; both adapters implement `ProviderAdapter`; pure `CodexFact -> ProviderEvent` mapper beside `parseFact`; `service.ts` consumes `ProviderEvent`; `RuntimeAuthority` with a `runtime_key` column defaulting to `profile_id`; presets and `EffectiveRuntimeProfile` keyed by provider; `providerCommandFailure` keyed by `CodexFailureCode` (`src/codex/errors.ts:1`) widened per provider. `src/codex/*` stays byte-identical to the post-wave-1 tree. New `src/provider/AGENTS.md`. | L | D3, B4 | Property test: `CodexFact -> ProviderEvent -> sessionEventBody` equals today's `#eventBodyForCodexFact` on all fixtures, extended to interactions and mutations; `bun run check` and the OBS and MEM gates unchanged. |
| D5 | P1 | Cross-provider work hooks: validate at `work.apply` admission that the task preset exists in the account's provider preset table and that requested signal modes are supported; `provider` in the public task and attempt projection; reviews may name a reviewer session on another provider. No rotation, pooling, or failover across providers or accounts. | M | D3, E1 | Admission tests; routing report groups by provider. |

### E. Routing policy and coordination telemetry

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| E1 | P0 | Typed routing policy: `src/domain/routing-policy.ts` with `taskClassSchema`, `effectClassSchema`, `executionLaneSchema` (`local_shared_tree | local_worktree | codex_cloud`), and a `RoutingRule` table; `taskClass` and `lane` optional in protocol v1 with defaults `unclassified` and `local_shared_tree`, admitted only to `read` effect; `effectClass` and `lane` derived by default; `criteria` non-empty for `edit`, `integrate`, `release`; `release` requires at least one independent review from a different session and preset (beta policy, decided 2026-09-03: no human decision gate while Oompa is a beta); `#prepareTaskAdmission` (`src/storage/work-store.ts:3257`) rejects violations; `oompa work protocol --topic routing` publishes the policy; `blocked{reason: "needs_clarification"}` added. Initial defaults, tuned later from E9: `research` and `review` are `read`, any preset, 2 attempts, 30 min lease; `edit` is `workspace_write`, `worker|high|ultra`, 3 attempts, 60 min lease, one review; `verify` is `read`, `routine|worker`, 2 attempts; `integrate` is `workspace_write`, exclusive workspace, `high|ultra`, one review; `release` is `external_effect`, one independent review, 1 attempt. Work schema `user_version` bump, `assertWorkSchema` update, and `work protocol` shards regenerated for the optional v1 fields. | M | C1 | Admission tests per class; the routing prose in the plugin skills shrinks to "declare the class"; INVARIANTS row for fail-closed routing admission. |
| E2 | P0 | Presets: promote `routine` and `worker` (today's `oompa-routine` and `oompa-worker` Codex `config.toml` profiles written by the plugin bootstrap) into `presetSchema` with `presetRequirements` and runtime-profile checks, keyed per provider after D4. Provider model ids never appear in public output. | S | - | A work route can name a cheap preset. |
| E3 | P0 | Reviewer independence: record the worker attempt's preset and account generation at claim; at `submission.review` reject with `REVIEWER_NOT_INDEPENDENT` when the reviewer's session matches, or when its preset matches and another preset was declared, or when its account matches and two accounts were declared; never fail solely because one account exists; replaces the session-only `SELF_REVIEW` check (`src/storage/work-store.ts:4946`) and trigger (`:700-707`); at least one review for `edit` and `release`; optional `score: 0..1`, stored, never authoritative. Work schema `user_version` bump. | M | E1, E9 | Tests per rule. |
| E4 | P1 | Budgets and promotion: per-work `maxParallelAttempts` (default 3) enforced in `#claimTask`; per-class attempt and lease defaults; instruction cap 4 KiB for `routine`. Promotion is opt-in per work (`promotion: "declared_only"`), moves to the next-higher preset only among routes the coordinator declared on the same account, fails closed with `ROUTE_MISMATCH` and detail `promotion_unavailable` when none exists, is recorded as `attempt.promoted`, and never demotes or crosses accounts. | S | E1, E2 | Tests per rule. |
| E5 | P0 | Same-account quota admission: before `attempt.dispatch`, if the route account's usage authority is `provider_read` with fresh coverage and the weekly window is at or above 99 percent with no reset credit, return `UNAVAILABLE{retryAt = weeklyWindowResetsAt}`; stale, unknown, or `provider_pushed` usage never blocks; the response and worker brief carry no alternative route; receipts record `blocked_by_quota` per account without linking to any later task. | S | E1 | Test with `automaticRateLimitResetDecision` inputs (`src/domain/usage-metrics.ts:208-228`); capability matrix row updated; INVARIANTS row "same-account gate is not rotation". |
| E6 | P2 | Workspace claims: an admission rule in the policy file rejecting a second `edit` task naming the same `(projectId, branch)`; `branch` is declared by the task spec and advisory until E8 verifies it; a durable table only if two coordinators collide in practice. | S | E1 | Evidence line states the advisory status. |
| E7 | P0 | Termination and repetition: `attempt.stalled` event when a running attempt has no checkpoint for more than half its lease; reject a checkpoint whose summary digest equals the previous two with `CONFLICT` and directive `refresh_state_then_new_request`. | S | E1 | Tests. |
| E8 | P1 | Closed evidence verifier as a daemon-side `EvidenceVerifierPort`: re-hash `artifact` evidence under the project root and confirm `git_commit` evidence via a bounded `git cat-file -e` in the project root; the store stays I/O-free. Requires a design note in `kb/notes/` and a new INVARIANTS row for daemon-initiated project reads with attacker-influenced `cwd`. | L | E1, threat review | Test: a submission citing a missing commit cannot complete. |
| E9 | P0 | Route receipts, lite: `work_route_receipts` written at prepare and settled at effect settlement with task class, effect class, lane, preset, fast, provider, account generation, policy digest, outcome, promotion, queue and run durations; `oompa work routing-report --days N` (read-only, 256 KiB cap) with repair rate per class and preset, revise rate per reviewer preset, blocked-by-quota counts, opaque account public ids only. Local-only: never synced, never in the compact projection, pruned by A8, purged by `work.release`. Work schema `user_version` bump. | M | E1 | The cloud pilot criteria in `docs/cloud-efficiency-plugin.md:102-109` are computed by the report. |
| E10 | P2 | Route receipts, full: token delta estimates guarded by `usageEpoch`, host-run join keys, OpenTelemetry GenAI span naming so a later exporter is a projection. | M | E9 | Report extended; still local-only. |
| E11 | P2 | Cloud lane in the kernel: `codex_cloud` as a claim-only lane whose attempt records the route-gate report digest as evidence; `oompa-cloud-exec` remains the sole effect; preset sentinel `cloud-default`. | M | E1 | Cloud attempts appear in poll and receipts. |

### F. Web app

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| F0 | P0 | Hosted sync go-live completed 2026-09-03: current source deployed to `qualified-hummingbird-537`, bootstrap completed, admissions reopened at generation 2, and the first identity, device, and production sync were proved. The former literal phrase and Linux-only operator gates are retired; exact target, custody, denylist, and readback checks remain. | M | - | `oompa auth login` and `oompa device pair` succeeded against the hosted deployment. `done`. |
| F1 | P0 | Origin and shell: revise the `oompa-v1.md:502` exclusion; `app/` with `build:app` via the Bun bundler and its own `AGENTS.md`; a separate Vercel project with `default-src 'none'; script-src 'self'; connect-src <exact convex https and wss hosts>; style-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; worker-src 'none'; manifest-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`, `Referrer-Policy: no-referrer`, `Permissions-Policy: clipboard-read=()`, `Cache-Control: no-store` on the shell, no service worker (test that the bundle never references `navigator.serviceWorker`), previews disabled or bound to a dev deployment, no analytics, and no direct provider credential or loopback OAuth callback handling. The only provider-login surface is the encrypted Codex device-code relay in F11; Claude stays on its custodian terminal. | S | - | Deployed shell passes a CSP evaluator. |
| F2 | P0 | Browser device enrollment (custody decided 2026-09-03: a browser device is a key holder for the compact projection only, never an approver and never the first device; non-extractable P-256 signing and wrapping keypairs held per tab by default with opt-in IndexedDB persistence; the unwrapped account key lives in memory only and is dropped on idle lock, tab close, or the first authority error); `devices:register` with `deviceClass: "browser"`, refused by `devices:register` server-side when no active device exists (the same Convex change that adds `deviceClass`) and client-side, so a browser is never the first or key-generating device; `devices:approve` rejects `browser`-class callers; enrollment displays a public-key fingerprint that `oompa device approve` requires for browser devices; `beginBind` and `finishBind` per auth session; `listKeyEnvelopes` and unwrap into a non-extractable in-memory AES-GCM key; idle lock and `Ctrl+l`; self-revoke proven or added; the tab wipes the key on the first authority error; presence heartbeat while visible. Reuse `src/cloud/crypto.ts`, `payloads.ts`, `projection.ts`, `authCredentials.ts` unchanged. PRIVACY gains a paragraph naming a browser device as a key holder whose protection excludes extensions, accessibility APIs, and the clipboard. | M | F0, F1 | `oompa device list` shows the browser as a normal device; revocation locks the tab; subscriptions stop after revocation (test). |
| F3 | P0 | Read-only TUI dashboard per the [UX contract](../notes/web-ux.md): sessions, stream, context, accounts and usage, devices; Convex subscriptions with cursor-based resubscription; client-side decrypt with digest-chain and epoch verification as `src/cloud/local-control.ts:3737-3745`; no plaintext persistence; text-only rendering in `role="log"` with bidi and zero-width neutralization; `y` yanks public ids and `oompa remote` commands only, never decrypted text; React Aria primitives from `@hraness/ui`. | M | F2 | Screenshots match the contract's wireframes; axe passes in CI. `live`: screen-reader walkthrough of NORMAL and INSERT modes. |
| F4 | P0 | Remote commands and decisions from the browser: send, queue, steer, stop, preset, fast with an in-memory outbox keyed by idempotency key, `expectedTargetDevicePublicId` from the head, deadlines mirroring the CLI, inline state trail, compose disabled with reason when the custodian is offline, two-step stop; plus `command_approval` and `permission_approval` decisions with `once` scope as a new encrypted command kind `(interactionId, revision, decision)` with custodian-side compare-and-set, after the F9 policy note is written and the threat review is recorded as this item's acceptance. | L | F3, F9 | Command state trail renders `pending` through terminal states; a lost response replays the same key; a decision on a stale revision is rejected. |
| F5 | P0 | Token custody: in-memory auth tokens via a custom Convex Auth storage adapter; the device bind alone may re-establish an auth session without a new OTP within the 7-day window (decision recorded), so OTP rate limits do not push refresh tokens back into `localStorage`. | S | F2 | No refresh token in `localStorage`. |
| F6 | P0 | Invariants: `OBS-W-*` rows for "renders only the compact projection", "no plaintext persistence", "command submission binds expected target device", "browser device cannot approve or be first", "decrypted text never enters the clipboard", each with a deterministic test. | S | F3 | Rows and tests exist. |
| F7 | P1 | Device-targeted command channel: `deviceCommands` for `session_start` (referencing an existing local project public id, never a path) and `usage_refresh` on a named online machine, with quota class, retention, and erasure inventory entries; overwrite-style latest-usage document per device-account outside the 24 h spacing, with the v1 quota inventory amended (`kb/plans/oompa-v1.md:369`). Convex schema revision. | L | F4, A7 | A session starts from the browser on a chosen custodian; usage is current. |
| F8 | P2 | Metadata hygiene: move `sessionCommands.kind` into the ciphertext and re-key the idempotency index `[userId, sessionId, requestingDeviceId, kind, idempotencyKey]` on a kind-blind digest; `set_metadata` command kind for remote rename and note. Convex index migration. | M | F4 | Migration tests. |
| F9 | P0 | Policy note in `kb/notes/` for remote decisions: names blind approval, limits to `command_approval` and `permission_approval` with `once` scope and a bounded `commandClass` in the projection, rewrites adversarial invariant 17 (`kb/notes/agent-first-coordination.md:321`), excludes file changes and session scope. Owner sign-off recorded here. | S | - | Note exists; owner sign-off line in this plan. |
| F10 | P2 | Read-only work projection for the browser (task board). Deferred: needs its own encryption, retention, and erasure contract. Listed so the gap is explicit. | L | F7 | - |
| F11 | P0 | Codex web account linking always requests the app-server device-code mode on an opted-in registered machine. The daemon validates one HTTPS verification URL plus separate user code, encrypts the complete handoff to the account key, and the requesting browser consumes it once before a hosted five-minute deadline. Loopback callbacks, URL credentials, missing codes, cross-device reads, clipboard writes, stale rows, and supersession of an outstanding handoff fail closed. | M | F2, F7 | Deterministic daemon, Convex, browser-model, and relay-component tests; two-device live acceptance remains required. |

### G. Marketing, docs, install

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| G1 | P0 | README order and thesis: H1, one-sentence thesis, status line, install, hero steps (`site/content.ts:1102`); positioning "control plane for coding-agent subscriptions, Codex on macOS and Linux, Claude Code on Linux" in `package.json` description, JSON-LD, and social card; one sentence on the name and one on the maintainer; em-dash check added to `scripts/public-text-policy.ts` (WRITING.md and STYLE.md already ban them). day-one | S | - | First English sentence is line 3 of the README. |
| G2 | P0 | Install surface: `bun add -g @hraness/oompa@<v>` primary, documented with `--ignore-scripts` or Bun's verified default plus a post-install `oompa doctor --offline` that checks the package manifest and empty `scripts`; `bunx @hraness/oompa@<v> doctor --offline` to try; verified installer hosted at `oompa.dev/install.ts` and documented in `docs/install.md` under "verify this release" with `SHA256SUMS` and the sigstore attestation link. day-one for the docs half | M | - | README install block is one readable line; `llms.txt` no longer starts with an 871-character command. |
| G3 | P0 | Trust signals: npm version, provenance, CI, license, Bun, and supported-runtimes badges; `CHANGELOG.md` fed by one entry per wave; `docs/roadmap.md`; SECURITY.md supported-versions table; issue templates; CONTRIBUTING.md note on how agent-authored PRs are reviewed; `.well-known/hra.json` version drift fixed. day-one, same owner as G4 | S | - | Present on GitHub and oompa.dev. |
| G4 | P0 | Social card as 1200x630 PNG rendered at build time with `og:image:width/height`; text "Oompa · control plane for coding-agent subscriptions · oompa.dev". day-one | S | - | Unfurls on X, LinkedIn, Slack, iMessage, Discord. |
| G5 | P0 | Docs architecture: `content.ts` gains `readme`, `docs`, and `site` targets; `docs/` gets getting-started, install, concepts (each term defined once), agents index plus Claude Code and Codex integration guides with copy-paste snippets, a status-to-poll-until loop, and an agent-first onboarding block whose first line is `bunx @hraness/oompa@<v> schema --json`; a "Compared with" section (several `CODEX_HOME`s by hand, tmux, account switchers, orchestrators); work protocol, security model, sync, desktop switching, providers, operators, plugins, changelog, roadmap; CLI reference generated from C5; `build:site --check` diffs every generated file. Update the exact-sentence assertions in `site/content.test.ts`. | M | C5 | README under 800 words; every docs page generated and checked. |
| G6 | P1 | Site: body copy in Nebula Sans with mono for code; H1 measure widened; features grid and agent snippet between hero and install; docs under `/docs/` with left nav; social footer collapsed to one "Part of Hraness" line; Ask-AI strip removed; client analytics removed in favor of server-side counts if the owner wants a number. | M | G5 | Page weight excluding fonts under 150 KB. |
| G7 | P0 | Demo: a 20 to 30 second recording (two accounts in the shell prompt, `session status --json`, `watch --jsonl`) as GIF or asciinema on README and hero; two PNG screenshots. Recorded with today's shell; re-recorded after C10. day-one | M | - | Embedded and linked. |
| G9 | P1 | `oompa self-update --version <v>`: source is the GitHub Release asset bound to the npm version, verified by `SHA256SUMS` and the sigstore bundle before an atomic swap, reusing the retired installer's manifest and publication custody. | M | G2, H1 | `check-package.ts` covers it; a tampered asset is refused. |
| G8 | P1 | `docs/security-model.md` for an evaluator: threat model, what is isolated, what is not a sandbox, what the sync server sees, how Claude custody differs, the terms reading from D1. Section of G5 first, own page after D3. | M | G5, D3 | Page exists; INVARIANTS links to it. |

### H. Gate diet and CI

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| H1 | P0 | Phase 1: delete `publish-beta-release(.test).ts` and `release-candidate(.test).ts`; remove the duplicate `build:site --check` and duplicate supervisor test from `ci.yml`; replace the `bun run check` rerun in `release.yml` with a readback that the tagged commit's CI run concluded `success`. day-one | S | - | CI wall time drops; retired code no longer runs; tag on an unchecked commit cannot publish. |
| H2 | P2 | Phase 2: retire descendant-lifetime custody and pidfd crash recovery for release tooling (every `runBoundedProcess` caller is in `scripts/`), replacing `bounded-process.ts` with a bounded `Bun.spawn` wrapper and removing Zig, sysctl, and sudo from both workflows; keep the Linux reaper source for live acceptance; move site, domain, and hosted ops tooling into `ops/` with its own gate. Preserved and tested: frozen lockfile; single-ref governed history; annotated tag, version match, and ancestor-of-`main`; registry-only runtime dependencies; byte-identical tarball; installed-package behavior on both OSes from the exact artifact; OIDC exchange proven before any immutable Release; standing repository authority with independent review; Fulcio claim admission (repository path, owner and repository IDs, tag ref); post-publish npm-equals-GitHub admission. | L | H1, G2 | Each preserved guarantee has a test that passes against the replacement before deletion; the dropped guarantees are named in `docs/beta-release.md`. |
| H3 | P0 | Gate shape: `check:fast` (lint, typecheck, primitives check, unit in parallel, under 5 min) as the PR gate and `check:complete` (build, package, e2e, live-optional) as the merge-queue gate. | S | B6, H1 | Documented in CONTRIBUTING.md; enforced by the `Required` job. |

### X. Plugins

| # | Tier | Item | Effort | Depends | Evidence |
| --- | --- | --- | --- | --- | --- |
| X1 | P0 | Update `oompa-local-efficiency` and `oompa-cloud-efficiency` scripts, `SKILL.md`, and tests for E1, E2, and the additive envelope; host-lease and lane logic in `host-run.ts` and `routing.ts` consume Oompa's routing policy data; `worktree-cleanup.ts` stays plugin-owned until E6 is a table. | M | E1, E2, C3 | Plugin tests green inside `bun run test`; routing prose reduced to "declare the class". |

## Sequencing

Waves are time boxes for a swarm with one integrator. No wave exceeds 12 owner slots. Inside a wave, items on different files run in parallel; items sharing one of the five god files run serially under one owner. The integrator runs `check:complete` once per merge.

| Wave | Weeks | Items | Exit criterion |
| --- | --- | --- | --- |
| 0 | 1 | A1, A2, A4+A5, A9, A10, B1, C1+C2, D2, G1, G3+G4, H1 | Day-one items merged; boundary lint and primitives check on; Keychain probe recorded; CI baseline recorded. |
| 1 | 2-3 | A3, B6, H3, B7a, C3, C4, G2, G7, F0, F1, F9 | Additive envelope shipped; tests parallel; install line readable; demo published; hosted sync live for the owner with neutral account ids; remote-decision policy signed. |
| 2a | 3-5 | B2, B3, B4a, E2, F2, F3 | Storage and service seams exist; browser reads a live session. |
| 2b | 5-7 | D1, D3, C5, C6, G5, E1, E5, E7, F4, F5, F6 | Claude session runs on Linux; macOS refuses until D2 passes; `oompa schema` generates the reference; README under 800 words; routing admission enforced; browser sends commands and decisions. |
| 3 | 7-10 | B4, E3, E9, X1, B7, C8, C9, A6, A7, C7, D5, E4 | Service split complete; routing report produces numbers from dogfood; plugins consume policy data; socket e2e green. |
| 4 | 10-13 | D4, E8, F7, A8, B5, C10, G6, G8, G9 | Port extracted from two adapters, targeting the post-split `provider-fact-projector.ts` and `interaction-service.ts` under one owner; session start and current usage from the browser; evidence verifier live. |
| 5 | when idle | C11, E6, E10, E11, F8, F10, H2 | P2 items. |

Owner commitment: from wave 2b onward, Oompa's own development runs through `oompa work` tasks with declared classes, driven by Claude Code using the G5 guide, so route receipts accumulate on real work before wave 3 tunes defaults.

### Schema and protocol register

| Change | Item | Wave |
| --- | --- | --- |
| Work schema `user_version` +1: optional `task_class`, `lane`, `runtime` on task specs and routes | E1 | 2b |
| Work schema `user_version` +1: `work_route_receipts` | E9 | 3 |
| Work schema `user_version` +1: worker route recorded on attempts | E3 | 3 |
| State schema `user_version` 30: `runtime_key` default `profile_id` | D4 | 4 |
| State and work retention pruning | A8 | 4 |
| Convex and bridge: neutral account public-id prefix `acct_` and HMAC domain `account-match` before go-live | F0 | 1 |
| Convex: `deviceClass` on `devices`; `register` refuses a first browser device; `approve` rejects `browser` | F2 | 2a |
| Convex: remote decision command kind | F4 | 2b |
| Convex: `deviceCommands`, latest-usage document, quota inventory amendment | F7 | 4 |
| Convex: `sessionCommands.kind` into ciphertext, idempotency index re-key | F8 | idle |
| Work protocol `hra-work-local-v2` (required class, examples topic) | C9 | when E1 defaults have been dogfooded |
| Public envelope: additive fields, `version` unchanged | C3 | 1 |
| Semver: 0.2.0 ships wave 0 because GitHub reserves the v0.1.7 to v0.1.10 names used by the retired v0 repository; the first Claude release takes the next minor; migrations are forward-only and the CHANGELOG states how to downgrade by reinstalling the prior version against a backup of the state directory | - | 2b |

### Invariant registry changes

| Row | Change | Item |
| --- | --- | --- |
| OBS-007 | `source` widened to an enum; `provider` added | D1 |
| OBS-008 | Unchanged; `session poll-until` gets its own row with lost-wake semantics | C8 |
| OBS-010 | Per-provider capability clause for `file_change_approval`; Codex still rejects | D3 |
| New | Fail-closed routing admission | E1 |
| New | Same-account quota gate is not rotation | E5 |
| New | Route receipts are local-only and exclude prompts, paths, labels | E9 |
| New | Claude custody never holds a credential | D3 |
| New | Daemon-initiated project reads are bounded and journaled | E8 |
| New `OBS-W-*` | Browser surface rows | F6 |
| Adversarial invariant 17 (`kb/notes/agent-first-coordination.md:321`) | Rewritten for remote `once`-scope decisions | F9 |
| v1 review finding on the reaper (`kb/plans/oompa-v1.md:639`) | Amended for A3 group cleanup plus journal; reaper retained for live acceptance | A3, H2 |
| v1 review finding on argv echo | Amended for bounded option-name echo | C4 |

## Execution state

| Wave | State | Evidence |
| --- | --- | --- |
| 0 | Implemented on `claude/oompa-20260902`; `bun run check` green in a single-branch clone (2,387 tests, 0 failures) | Nine worker branches merged: A1 (transport partition, 23 tests), A2 (readonly opens skip the FK scan, scrub retries), A4+A5 (login-cancel ledgered, `#effect` failure ordering, poller and waiter hygiene, unhandled-rejection receipt), A9 (`CODEX_PIN`, `codex:bump`, usage digest domain decoupled), A10 (OTP constant-time compare, allowlisted daemon and editor env, Convex body bound, GCM message budget, redaction patterns, `check-security-primitives.ts` in the gate), B1 (layer DAG, boundary lint, cycle check), C1+C2 (offline `work protocol`, `oompa help`, leaf help, JSON help and version, doctor envelope), G1+G3+G4 (README thesis and badges, PNG social card, em-dash policy, CHANGELOG, roadmap, SECURITY table, issue templates, CONTRIBUTING note), H1 (retired release scripts deleted, duplicate CI steps removed, CI-run readback in the tag workflow). D2 is partially recorded in `docs/providers/claude.md`; the login-dependent half needs the owner. `oompa daemon status --json` exposes transport slots; waiter and poller counts remain for B4a. |
| 1 onward | Not started | - |
| v0.2.1 patch release | Done 2026-09-03 | Expired-access-token transport fix (PR 84) found after go-live: hosted commands failed with `INTERNAL` after fifteen idle minutes. Released as immutable `v0.2.1` (PR 87 preparation, release run 33803212691) and marked live. |
| Hosted go-live (F0, beta) | Done 2026-09-03 | v0.2.0 released (PR 71 to 74); oompa.dev alias moved by the reviewed operator (PR 75, 76); hosted runner made portable (PR 80); expired bootstrap invite reissued through the reviewed `hosted:bootstrap reissue` path (PR 81); main 7af0dde deployed with bootstrap-phase attestation evidence; admissions reopened at generation 2; first identity and device admitted and the first `oompa sync now` completed against the production deployment; public copy flipped to "hosted sync live as an invite-only beta". `hosted:status` still classifies the reissued and resumed frame as `preflight_inconsistent`; follow-up. |

Wave-0 deviations from the plan text: the transport idle timeout is 10 s; the A1 status exposure covers transport slots only; the doctor envelope keeps `data` beside `error` for compatibility; C1 short-circuits before the daemon caller rather than before `assertInstallationHome`, which only checks the live-acceptance home; H1 found that all five recorded release failures happened in the replacement workflow, not in the deleted scripts, so the deletion rests on the scripts being unreferenced.

## Acceptance evidence

| Claim | Deterministic | Live |
| --- | --- | --- |
| Transport does not starve under long polls | A1 test | Wave 3 dogfood with 8 concurrent agents, measured via `oompa daemon status --json` |
| Daemon crash does not orphan providers | B7 e2e (wave 3) | Manual kill during live acceptance |
| One additive envelope, one schema | C3 and C5 snapshots; CI reference diff | Claude Code and Codex guides executed end to end |
| Routing rules enforced | E1, E3, E5, E7 tests | Routing report from two weeks of dogfood |
| Browser is a device, nothing more | F6 tests; CSP evaluator | Two-device live acceptance with a browser as the second device |
| Claude adapter | D3 fixture tests; D4 property test | Live acceptance with a real Claude profile; D2 probe recorded |
| Install and docs | `build:site --check` over all generated files | Fresh-machine install following only the README in under 60 seconds |

## Risks

| Risk | Mitigation |
| --- | --- |
| Hosted sync never goes live in the plan window | F is deterministic-only against a local Convex dev deployment until F0 closes; F7 onward slips; nothing else depends on F. |
| Claude terms change again | Oompa never holds a credential, spawns only the unmodified SDK-bundled binary, keeps user-directed accounts, caps concurrency by default, and reserves an `api_key_helper` account kind that lives in the profile's own settings. |
| macOS Keychain prompts from a detached daemon | D2 runs in week 1; Linux-first is acceptable; no credential fallback exists. |
| Decomposition churn conflicts with feature waves | Waves 2a and 2b are separated by file; one owner per god file; `check-security-primitives.ts` and the D4 property test guard silent drops. |
| C3 is the largest single merge | Integrator-owned; snapshot harness lands first; every test suite and generated doc moves in one PR with no concurrent edits to `cli.ts`, `render.ts`, or `service.ts`. |
| Browser key custody weaker than file custody | Memory-only key, per-tab default, in-memory tokens, Trusted Types, text-only rendering, no clipboard of plaintext, separate origin, no approver authority, documented loss model. |
| Gate diet removes a guarantee by accident | H2 keeps a test per preserved guarantee and names each dropped one; `oompa self-update` reuses the installer custody. |
| Routing defaults are wrong | Defaults are data in one file; E9 receipts are the tuning loop; promotion is opt-in and declared-only; every rule fails closed at admission, never reroutes. |
| Original build velocity (about 13,000 lines a day for 12 days) recurs without review depth | Waves gated by `check:complete`, snapshots, primitives check, and the invariant registry; no phase closes without its named evidence. |

## Explicit exclusions

- Automatic account rotation, pooling, proxying, or failover across accounts or providers, in any form, including any hint of an alternative route in a quota response.
- Holding, reading, copying, or forwarding any provider credential: OAuth tokens, `setup-token` output, `.credentials.json`, Keychain items, or the `api.anthropic.com/api/oauth/usage` endpoint.
- Spoofing Claude Code client identity or system prompt.
- Claude login and Claude usage refresh from the web app. Claude authentication remains local, foreground, and TTY-only.
- A browser device as execution custodian, device approver, or first device.
- Remote `file_change_approval` and remote `session`-scoped grants.
- Rendering or syncing anything beyond the compact projection without a new privacy review; a cloud projection of `oompa work` state is deferred (F10) with its reason.
- A learned model router or cost cascade.
- A generic workflow engine, agent catalog, or PTY injection.
- A Rust or Zig rewrite of product code.
- ACP as the internal seam.
- Renaming Oompa.

## Decisions taken in revision 2 (formerly open questions)

1. Compatibility window: none needed; the contract is additive only and nothing is renamed.
2. Web origin: separate origin `app.oompa.dev`.
3. Remote interaction decisions: yes for `command_approval` and `permission_approval`, `once` scope only, after the F9 policy note.
4. Analytics on oompa.dev: none client-side; server-side counts if the owner wants a number.
5. Presets: `routine` and `worker`; provider model ids never appear in public output.
6. Abstract before or after the second provider: after.

## Decisions the owner must make before wave 0

Taken on 2026-09-03: hosted sync goes live (F0) as soon as its two external inputs exist; `release`-class work needs one independent review and no human gate while Oompa is a beta; browser key custody is per-tab, memory-only, opt-in persistence, never approver, never first device (F2).

1. Positioning: use "control plane for coding-agent subscriptions, Codex on macOS and Linux, Claude Code on Linux" now that the second provider has landed.
2. Hosted sync operation (F0): switch it on for the owner now, at what cost, run by whom. Without it the web app has no live evidence.
3. Release-class authority: decided on 2026-09-04. One independent review plus required repository gates and an exact workload identity are sufficient under the standing authority in [Hraness delivery autonomy](delivery-autonomy.md); a second conversational or mutable-variable gate is not required.
4. Owner dogfood commitment from wave 2b.
5. Browser as key holder: accept a browser device as a key holder (never an approver), or restrict browsers to read-plus-command with keys that expire per tab only.
6. Claude on macOS: decided after D2; if prompts occur, ship Linux-first.
7. F9 sign-off after the policy note is written.

## Adversarial review log

### Revision 1 reviews (2026-09-02)

Three reviewers examined revision 1: engineering feasibility (verified against the tree and the `claude-agent-sdk` package at 0.3.258, `sdk.d.ts` of 8,687 lines, since the package is not in the repo), product fit against the owner's stated asks, and security, invariants, and provider terms (Claude legal page re-fetched the same day).

| Finding | Source | Disposition in revision 2 |
| --- | --- | --- |
| Wave 2 scheduled feature work into the same files B3/B4 were splitting, contradicting D5 | Engineering B-1 | Waves 2a and 2b separated by file; one owner per god file (D6); day-one items sharing files assigned one owner. |
| C3 rewrote the strict `hra-work-local-v1` response document | Engineering B-2 | `work apply` exempt; work protocol changes scheduled as v2 under C9. |
| Envelope `version: 2` bump unnecessary and the largest compatibility risk; `session status` already has data-level `version: 2` | Engineering B-3, M-10 | No bump; additive only (D5). |
| F depends on hosted sync being live, which v1 says it is not | Engineering B-4, Product 4 | F0 added as an owner decision; F evidence deterministic-only until then. |
| E8 cited store paths that do no I/O; daemon-initiated git reads are a boundary change | Engineering B-5 | E8 rewritten as a daemon port with a design note, INVARIANTS row, threat review, effort L, tier P1. |
| E3 cited a symbol that does not exist; the real rule is `SELF_REVIEW` plus a trigger; needs the worker route recorded at claim | Engineering B-6, Security | E3 rewritten, effort M, depends on E9; differ-by-account only when two accounts were declared. |
| D3 status-line hook obsolete; the SDK emits `rate_limit_event` in-band | Engineering B-7 | D3 uses in-band events; no hook. SDK options verified. |
| Effort labels wrong for C5, D1, E3, E8 | Engineering M-1 | C5 L, E3 M, E8 L; D1 kept M because it is now additive-only. |
| D2 "byte-identical `src/codex`" contradicted by A3 and A9; `ProviderFailureCode` does not exist | Engineering M-2 | Baseline is the post-wave-1 tree; keyed by `CodexFailureCode`. |
| E1 required fields would reject existing documents | Engineering M-3 | Optional with `unclassified` default in v1; required in protocol v2. |
| No schema migrations, protocol versions, or Convex revisions listed | Engineering M-4, Missing 2-3 | Schema and protocol register added. |
| H2 misstated what the supervisor provides; B6 injected `recoveryDirectory` into code H2 deletes | Engineering M-5 | H2 names the dropped guarantees; B6 no longer touches `runBoundedProcess`. |
| H1 dropped the release gate without a binding replacement | Engineering M-6 | CI-run readback added to H1. |
| Plugins consume and implement routing and were not in the plan | Engineering M-7 | Workstream P added. |
| Acceptance cycles and untestable items unmarked | Engineering M-8 | `live` markers added; B7 snapshot harness split out ahead of C3. |
| Missing INVARIANTS rows, AGENTS.md maintenance, release and rollback, daemon self-observability, versioned `oompa schema`, baselines | Engineering Missing 5-12 | Invariant registry table added; AGENTS.md updates in B4, D3, D4, F1; semver and downgrade line in the register; `oompa daemon status --json` extension in A1; `oompa schema` versioned in C5; baselines in B6 and wave 0. |
| Fourteen wrong or imprecise citations | Engineering Wrong facts | Corrected in place (A2, A8, A9, E2, E3, E8, D2, C1, audit table). |
| Claude and web delivered last, behind refactors they do not need; D4 probe scheduled at week 9 | Product 5-7 | Claude adapter before port extraction (D1 order); probe in wave 0; web in waves 1 through 2b. |
| Web under-delivers on "same features": approvals last, work state not acknowledged, UX spec outside the repo | Product 1-3 | `once`-scope decisions in F4 (wave 2b); F10 lists the work projection as deferred with reason; UX contract committed as `kb/notes/web-ux.md`. |
| D1 renamed public vocabulary for zero external callers | Product OE-1, Engineering B-3 | Additive only. |
| E4 promotion collides with immutable routes; coordinators declare five fields | Product 9-10, Security Blocking 2 | Promotion opt-in and declared-only, fail-closed; `effectClass` and `lane` derived by default. |
| Sprint contract and release human gate named but not itemized | Product 9 | Both in E1. |
| E6, E10, E9-full, H2 over-built for a solo owner | Product OE-2, OE-3, OE-5 | Tiered P2; E9 split lite and full. |
| Marketing acceptance was a word count; positioning hard-paired with Codex | Product 11, matrix 6 | 60-second quickstart, thesis-after-one-pass, agent-first line, compared-with section, provider-neutral positioning; demo in wave 0. |
| No priority tiers; 17-item wave | Product 7, matrix 7 | Every item tiered; waves capped at 12. |
| G2 and H2 dependency cycle | Product 4 | G2 depends on nothing; H2 depends on G2. |
| `claude setup-token` in Oompa custody violates the legal page and the plan's own exclusion | Security Blocking 1 | Struck; exclusion broadened. |
| `session wait` contradicts OBS-008 | Security Blocking 3 | Renamed `session poll-until` with its own row. |
| `file_change_approval` for Claude flips OBS-010 without a clause | Security Blocking 4 | Per-provider clause, Codex-still-rejects test, protected channel only, no persistent grants (D3). |
| Browser device could approve other devices; phishing plus approval confusion | Security Blocking 5 | `deviceClass: browser` cannot approve or be first; fingerprint required at approval (F2). |
| A3 and H2 silently downgraded the v1 reaper finding | Security Blocking 6 | Finding amended explicitly; reaper source retained for live acceptance. |
| E5 could become a rotation prompt; capability row false | Security table | No alternative route in response or brief; row updated; `provider_pushed` never blocks. |
| C4 echo needs bounds and path restrictions; C10 history needs sensitive-line exclusion; D1 public ids reveal provider; E9 receipts need local-only, retention, purge; A8 could prune reconciliation evidence; B6 knob reachable; C3 free-text fields | Security table | All incorporated in the respective items. |
| Web threat matrix gaps: navigation exfil, extensions, service workers, clipboard, accessibility APIs, previews, "zero server changes" overstated | Security matrix | F1, F2, F3 extended; PRIVACY paragraph; D3 wording corrected. |
| Gate diet keep-list omitted eight proven guarantees; `bun add -g` losses unstated; `self-update` unguarded | Security gate diet | H2 keep-list completed; G2 documents `--ignore-scripts` and post-install manifest check; `self-update` reuses installer custody. |
| Five P3 security items dropped | Security other | A10 added to wave 0. |
| Terms classification: allowed, gray, disallowed | Security terms | D1 records the reading, the concurrency cap, and the `apiKeyHelper` option; exclusions extended. |

Not adopted from the reviews: the product reviewer's suggestion to drop A8 entirely (kept at P1 because unbounded ledger growth slows every `oompa status`); the security reviewer's suggestion to make Codex decisions the only remote kind until Claude ships (F4 is provider-neutral by construction).

### Revision 2 verification (2026-09-02)

A consolidated verification pass checked closure of every revision-1 blocking item, internal consistency, citations, and P0 startability. Verdict: ready with edits. It found 19 of 21 blocking items closed and two partial, 15 consistency defects, 7 citation errors, and 8 P0 items missing a decision needed to start. Revision 3 applies every required edit:

| Finding | Disposition in revision 3 |
| --- | --- |
| P0 items C3 and D3 depended on P1 items B7 and B4 | `B7a` (snapshot harness) and `B4a` (mutation ledger and compose) split out as P0 rows; B7 and B4 remainders stay P1. |
| G5 preceded its dependency C5 | G5 moved to wave 2b. |
| Wave 0 exceeded the cap; wave 4 scheduled feature work into files B4 was splitting | G7 to wave 1; G3 and G4 share an owner; B4 to wave 3; D4 and E8 target post-split files under one owner in wave 4; cap restated as owner slots. |
| Guiding D3 understated Convex changes; Guiding D5 contradicted D1's public-id rename after go-live | D3 sentence rewritten; the rename moved into F0 before any hosted deployment exists; register row added. |
| Profile provider column unregistered; E3 schema bump unstated | Register rows added at `user_version` 29 and 30; E3 states its bump. |
| Item id `P1` collided with tier `P1` | Workstream renamed `X`, item `X1`. |
| Citations: `state-store.ts:3768`, `cli.ts:4654-4657`, `convex/authDelivery.ts:268`, adversarial invariant 17 lives in `kb/notes/agent-first-coordination.md:321`, reaper finding at `oompa-v1.md:639`, `@hraness/ui` exports `ListBox` not `GridList` | Corrected in place. |
| P0 items not startable: D1 and D3 (profile creation, preset mapping, `cwd`, provider column), E1 (default rule values), A10 (GCM budget action), F2 (server-side first-device refusal), G2 (`self-update` was one clause) | Each now carries the missing decision; `self-update` is its own item G9 at P1. |
| Outcome 2 overclaimed `error.*` fields on every response | Corrected to failures only. |
| Web UX note contradicted itself on `y` and named a primitive `@hraness/ui` lacks | Note corrected. |

Not adopted: moving E1's dependency to C1 was adopted; the suggestion to accept 15 wave-0 items was not, wave 0 is 11 slots.

Revision 3 is ready to implement once the owner decisions listed above are recorded.
