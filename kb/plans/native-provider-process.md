# Native provider process ownership

Design: [issue 198](https://github.com/hraness/oompa/issues/198).

Outcome: production provider adapters use a qualified native process owner for physical process and pipe lifetime. Existing TypeScript owners retain provider RPC, persistent sessions, account/profile authority and durable recovery. The actual shutdown path consumes native join evidence separately from root exit. Shared extraction follows two real consumer integrations. The byte-process protocol is [defined here](../../native/process-kernel/protocol.md).

The first adapter is Codex. Its official JavaScript launcher starts the native provider, so immediate-child exit is insufficient custody evidence. Preserve the pinned launcher, forced file credential stores and environment allowlist. Claude follows separately because durable PID/start identity must continue to identify the actual provider. The scripts-only experimental direct-child controller and Linux authority supervisor retain their current separate scopes.

## Phases

| Phase | Outcome | Depends on | Write owner |
| --- | --- | --- | --- |
| 1 | Native byte-process implementation with actual Mac/Linux fixtures | None | Native implementer: `native/process-kernel/` Rust source/tests only |
| 2 | Production Codex adapter and session close consume native evidence | 1 wire contract | Integrator: `src/native-process/`, `src/codex/`, affected daemon tests |
| 3 | Verified package/install binaries and required native CI | 1, 2 | Integrator: manifests, locks, build/package/install scripts, workflows |
| 4 | Second runtime integration and common process extraction | 1–3 and second consumer qualification | Integrator after independent seam review |
| 5 | Claude and remaining native platform integration | 3, 4, identity/recovery review | Assigned per adapter and platform |

Phases 1 and 2 may proceed concurrently after the wire contract is frozen; their write scopes are disjoint. Manifests, lockfiles, protocol changes, plans, generated files and aggregate validation have one integration owner. Provider credentials and live accounts are outside ordinary tests.

### Phase 1

Status: In progress.

Acceptance: strict bounded codec; exactly one provider writer; original bytes and ordering preserved; actual full-write acknowledgement; responsive cancellation during backpressure; launcher/native-child topology in the claimed scope; separate root, EOF and join observations; no reused-PID signaling; controller/helper failure cannot manufacture success. Monotonic bounded shutdown retains unresolved ownership. No runtime compiler requirement.

Focused validation: `cargo test --locked --features native-fixtures --manifest-path native/process-kernel/Cargo.toml -- --test-threads=1`; `cargo clippy --locked --features native-fixtures --manifest-path native/process-kernel/Cargo.toml --all-targets -- -D warnings`; real native process tests through the installed host scheduler. These commands need the actual native platform where their claims apply.

### Phase 2

Status: In progress.

Acceptance: real `launchPinnedCodexAppServer` composition uses the native adapter; `CodexProcess` root-exit semantics remain explicit; shutdown and failed-launch cleanup consume native join evidence; unknown writes remain indeterminate without replay; current authority is checked at the existing dispatch boundary; failed close remains retryable and the daemon retains its unjoined-process barrier. No replacement custody database.

Focused validation: `bun test ./src/native-process ./src/codex --isolate --max-concurrency=1`; affected Codex daemon lifecycle tests; `bun run check:effect-architecture`; `bun run typecheck`; `bun run lint`. Native process suites use the host scheduler. Pure fake-process tests do not establish native qualification.

Remaining production composition must preserve this order:

1. Admit the released helper and recover native records under the held daemon
   lock before publishing a generation or calling `nextDaemonGeneration`.
   Recovery owns startup cancellation; await its completion before closing the
   store. Give the total startup deadline room for both bounded recovery and
   normal initialization.
2. Share one daemon-owned process registry across managed and personal Codex.
   Retain each constructed native handle before awaiting readiness or client
   initialization, including launches that fail before a client exists.
3. Close native admission synchronously when shutdown begins. Start registry
   cleanup alongside service cleanup so a manager waiting for a pending launch
   cannot prevent that launch from stopping. Join all launch and settlement
   callbacks before closing the store or releasing the daemon lock.
4. Commit the stopped marker only after the exact native custody census is
   empty. Unproved callback completion requires the failed shutdown path;
   unresolved durable custody cannot produce a successful stopped receipt.

These lifecycle requirements do not enable the staged adapter. The immutable
dependency pin, installed image admission and production bundle configuration
remain prerequisites for selecting it.

### Phase 3

Status: In progress. Package assembly, artifact admission, installed-archive qualification and the separate native release workflow are implemented. Actual complete qualification, installed-package execution, protected tag creation and immutable publication are pending.

Acceptance: platform artifacts are bound to exact source, toolchain and locked dependency identities; installed production constructors resolve verified immutable bytes without cargo or runtime download; package inventory and installer verification include the exact admitted artifacts. Unsupported platforms fail before execution. Required CI covers the new native source and actual integrated fixtures without removing old coverage.

Validation: native build/install fixture; `bun run check:package`; `bun test ./scripts/release-workflow.test.ts --isolate --max-concurrency=1`; existing installer/package tests and all relevant native acceptance. Complete current-head/current-base `Required` CI is the final source aggregate under CONTRIBUTING.md; keep its full matrix and browser gate. Packaging and native capability proofs remain separate.

### Phase 4

Status: In progress. The shared process mechanism and consumer adapters are staged. Neither a released dependency nor independently installed production use is admitted yet.

Acceptance: an independently installed second runtime calls the same released native component with its own provider policy and journals. Shared scope types do not weaken consumer confinement. No sibling path imports or coupled main branches. Independent adversarial review confirms that common APIs represent matching mechanisms. Both consumer aggregate, package and native gates pass.

### Phase 5

Status: Not started.

Acceptance: Claude launch/start identity and recovery retain their actual provider binding. Mac, Linux and Windows have explicit capability matrices and native adverse-path/install evidence. Windows Job Object, handle and ACL semantics are independently qualified. A portable build alone is insufficient. Existing live provider and daily-driver requirements remain applicable and incomplete until proved.

## Measurement and delivery

Record cold/warm launch and bounded write latency, idle CPU, total process-tree memory, peak memory and process/handle growth on identical credential-free fixtures before and after. Judge correctness by preserved behavior and stronger consumed custody evidence; make speed claims only from measurements. A smaller helper without reduced whole-tree cost is not an efficiency result.

Root remains the integration owner. Native author owns focused checks; an independent reviewer challenges exact diff, resource ownership, recovery and platform claims. Run required final gates after convergence, then deliver through task-owned commits with agent co-author attribution, PR review, exact-head/current-base Required CI, and applicable immutable release/install acceptance. No phase is complete from unused source or a nonproduction-only constructor. Artifact admission and live activation stay distinct under the release policy.

## Implementation log

- 2026-09-13: started from exact main `ebf3cab73a2b05a0270b6052eabd410992dddbd1`; managed local-efficiency guidance checked current. Independent scope review replaced the tooling-only first slice with production Codex transport. Second-consumer review required separate root/join evidence, readiness before the authority fence, out-of-band owner-loss handling and separate operation/custody outcomes. Native source and TypeScript wire/adapter work have disjoint owners. Abrupt helper-death durable identity/recovery remains a required admission item, not a completed property.

- 2026-09-13: added durable schema-61 reservation/Prepared/Ready/release states in the existing StateStore; 16 focused tests and 80 assertions passed. Activation requires a committed Prepared anchor before provider execution. Added strict TypeScript transport and 24 pure tests (213 assertions) for commit ordering, unknown writes, operation/custody separation, delayed consumers, helper-exit deadlines and false no-start evidence. These are not native qualification or production integration. Independent review invalidated the initial stopped-supervisor fixture: it resumed the helper before checking cleanup. The stronger same-birth check exposed a Mac hangup-observation bug; native repair and requalification are in progress. Added a real Rust-to-TypeScript transport verifier; its execution remains pending the native repair.

- 2026-09-13: subsequent native repairs and actual transport checks passed; the first complete release qualifier then failed at notice collection after its native checks. The notice collector now authenticates cached Cargo archives against the lockfile and verifies the complete notice census, without assuming vendored metadata exists. Its parser and collection tests pass after independent review. That repair still needs a fresh complete qualification; retained partial outputs cannot admit an artifact.
- 2026-09-13: implemented the shared artifact resolver, deterministic package assembler, strict archive parser and actual installed-package gate. Source tests cover private image identity, preserved old images, exact client and native inventories, notices, malformed archives and independent process outcomes. The release policy requires all four configured POSIX targets: macOS and Linux on arm64 and x64. The Windows process implementation remains a separate requirement.
- 2026-09-13: implemented separate qualification, assembly, installed-target, attestation and publication jobs. Attestation joins every installed receipt to the one archive. Publication verifies the exact signature, predicate, source and original producing attempt; retries retain that provenance. Each mutation records intent and consumes fresh workload authority at dispatch. A missing draft after a possibly dispatched create cannot authorize another create. Publication must preserve numeric asset identity, download and hash the exact bytes, observe an immutable release and leave CLI Latest selection intact.
- 2026-09-13: owner tag-policy admission verifies full administrative protection settings; workload publication uses the ordinary repository token and checks current source, tag, run, attempt and unchanged release-control files. This split avoids assuming that the workflow token can read hidden ruleset bypass settings. Native tag protections and the tag-creation flow still need delivery. Source and mocked-provider tests do not establish live publication, installed execution or daily-driver readiness.
- 2026-09-13: added a daemon-owned native composition registry. It retains full
  launches before factory execution and exact process handles before readiness,
  checks admission immediately before helper dispatch and client publication,
  and retries failed durable release without relaunching. Unproved observer or
  late-client cleanup permanently refuses a successful close for that daemon.
  Eighteen synthetic tests with 115 assertions, focused TypeScript and lint
  checks, and independent source review passed. The store now checks native
  custody in the same transaction as its stopped marker; the CLI reports a
  failed shutdown when that marker refuses. Added storage cases await execution.
  Production registry/recovery wiring and real native qualification remain
  incomplete, so the adapter is still inactive.
