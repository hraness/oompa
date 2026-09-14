# Hosted sync deployment

Hosted operations run the official Convex CLI as an ordinary bounded child process and work from macOS or Linux with only Bun and an authenticated Convex CLI session. The Linux-only authority supervisor requirement and the separate authorization phrase were retired on 2026-09-03 by the owner's decision to run hosted sync as a beta; every identity guard, readback proof, and denylist below still applies. DNS records, domain assignments, and the production alias are separate procedures (see `docs/domain-cutover.md`). This runbook targets current Oompa only. The retired Oompa v0 Vercel and Convex resources are not fallback or rollback authorities.

Use this sequence only in the existing current Oompa Convex project. A recovery creates one distinct, non-default production deployment in that project; it never creates a replacement project. The setup helper refuses an existing Oompa environment by default and does not support overwrite.

Never copy retired Oompa v0 data, deployment URLs, deploy keys, authentication keys, HMAC material, Resend credentials, environment values, or backups into the current project. Do not recreate or select a retired resource.

The provider identity guard pins the intended Convex team to numeric ID `513923` and provider slug `cclrte`. Retired Oompa v0 Convex project ID `2680173` and production deployment ID `4677913` remain permanent denylisted safety tombstones; neither may be recreated, renamed into, or selected by this runbook. The current source repository has GitHub repository ID `1343008607`, and the current web project has Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`. Provider names may change. The team identity and numeric resource IDs do not.

Browser app project. The web app at `app.oompa.app` is a second Vercel project in the same team, separate from the website project above so the two never share an origin, a cache policy, or a Content Security Policy. It has no framework preset, root directory `app`, build command `cd .. && bun install --frozen-lockfile --ignore-scripts && bun run build:app`, install command `true`, and output directory `dist`; source files outside the root directory are enabled because that exact build intentionally enters the repository root. Its tracked ignore command is exactly `test "$VERCEL_ENV" != "production"`, so Vercel builds production and ignores previews. The app requires no deployment-secret input: its Convex deployment origin is pinned in source at `app/src/env.ts` and in the `connect-src` allowlist of `app/vercel.json`. It was created on 2026-09-04 as Vercel project `prj_3olYDT29BrwKO9PLByVq9HlgRkdA` in team `team_UAd1iD2XogJlbFg4h14mRaPM`, alongside the website project `prj_8ciIt9t9foE3utG45frRN7cxckjS`. Its production branch remains `main`; the current canonical domain decision is `app.oompa.app`, selected on 2026-09-10. Every production build must receive Vercel's exact lowercase 40-character `VERCEL_GIT_COMMIT_SHA`; a missing or malformed value stops the build. The bundle publishes that commit, repository identity, and package version at the no-store path `/.well-known/oompa-app.json`, which is excluded from the SPA fallback.

Live projection. Besides the compact stream of completed turns, the daemon streams the current turn's assistant text (and reasoning summaries only when show-thinking is enabled for the session, default off) to the `detail` stream about once per second in redacted, encrypted batches of at most 8 KiB. Detail chunks carry the `live_tail` retention class: each row expires six hours after it is written, a session keeps at most 200 rows, and the `live_tail_chunks` maintenance category sweeps expired rows behind a detail stream epoch so digest-chain verification of the surviving tail stays valid and both the chunk quota and the per-user `live_chunk` resource counter are released. Raw reasoning is never uploaded.

Interaction detail. Version 2 compact `interaction_state` detail carries a `label`, bounded `headline`, bounded redacted `detailMarkdown`, and one nested `remotePolicy`. That policy is the only remote action authority. It contains an ordered subset of `decline | answer`, the absolute local deadline, closed reason codes, and the exact bounded question contracts required by `answer`. A missing policy, an unknown policy version, legacy version 1 detail, a non-pending state, or an expired deadline exposes no control. The app and CLI never reconstruct authority from the interaction kind, summary, legacy `commandClass`, `availableDecisions`, or legacy question list.

Every projected string is bounded, checked for absolute paths, terminal controls, projection markers, and secret-shaped content, then re-checked by the compact parser before it is written or read. A failure drops the whole detail block and therefore every remote control. The projection never carries exact command text, affected paths or diffs, requested permission values, the MCP server name, protected answers, or a secret question's text. Command, permission, and file-change requests can only be declined remotely. `answer` is available only for a complete non-secret closed-choice user question set whose provider adapter proves that every decision-relevant field crossed without sanitization or truncation and that the response translation is exact. Free-text and Other responses and every MCP form answer stay on the execution machine. The execution daemon recomputes the same policy from the live interaction and injected clock immediately before dispatch, after the separate session, revision, lease, and device checks.

Push wake and sync cadence. Besides its poll timer, the daemon holds one websocket subscription to the pending commands addressed to its own device, presenting the same bearer token from the same custody slot as the HTTP transport and refusing under the same deployment fence. A change to that set wakes the sync cycle immediately, so steering, declines, and eligible closed-choice answers from another device apply in well under a second instead of waiting out the interval. The subscription carries no authority: every command it announces is still claimed, bound to the exact authority generation, and settled by the ordinary cycle under its idempotency key, so a wake that races the timer costs one extra cycle and never a second execution. When the socket fails, one diagnostic is reported through the ordinary cycle diagnostics that `oompa sync now` prints, the daemon falls back to polling, and it reconnects with a doubling backoff from one second capped at thirty. The timer itself is adaptive: one second while another device is present in presence or a local session is mid-turn, fifteen seconds otherwise. The device-presence probe is cached for ten seconds so the fast cadence does not list devices every second. `oompa sync status` reports the current interval, why it was chosen, and the push-wake state.

Each Convex CLI invocation is bounded in runtime and output and receives only an allowlisted child environment. A timeout reports exit 124 and an output overflow reports exit 1; both are ordinary command failures that the helpers classify without a provider retry. Hosted bootstrap and invitation results retain the protected invite file after capability commit, and attested deploy results retain the final evidence path and its `.intent`. Durable intents and receipts, provider idempotency, and exact reconciliation remain mandatory for every ambiguous Convex result; no local custody claim proves that a remote effect did not occur.

## Migrate staged prerelease secret pointers

This compatibility operator is only for repository checkouts that ran an unpublished prerelease Oompa v1 build on macOS when the default secret backend was Keychain. No Oompa v1 beta containing that default was published. This command is therefore a repository-operator migration for staged prerelease state, not an installed-product feature, a daemon fallback, or a reason to make the daemon read Keychain.

Run the read-only inspection from the exact source checkout first:

```sh
bun run operator:migrate-legacy-secrets preflight
```

Preflight reads the private pointer metadata and current `secret-values` files only. It does not acquire daemon authority, create a directory or file, read Keychain, copy a value, delete an entry, or perform another mutation. `ready` with `nextAction: "execute_migration"` means at least one current pointer still lacks its exact file-backed value. `already_complete` and `not_required` need no migration. Unsafe, unknown, locked, malformed, non-owned, multiply linked, permission-inexact, oversized, replaced, or digest-conflicting metadata is a refusal. Output contains counts and a closed status only. It never contains a secret value, digest, slot, Keychain account, nonce, or local path.

Stop every Oompa process, then run the explicit foreground mutation:

```sh
bun run operator:migrate-legacy-secrets --execute
```

Execution first acquires and holds Oompa's exact daemon lifecycle authority in maintenance state. A live or starting daemon causes `daemon_running` before any Keychain access. While that authority remains held, the operator re-reads every current pointer, reads only missing values from Bun's legacy `sh.hra.control-plane.v1` service, checks each value against the pointer digest, and validates all missing values before copying any. It publishes each value at the unchanged immutable account name through the current `FileSecretBackend`, then reopens every required file through the protected descriptor boundary and proves all pointer digests again before releasing authority and reporting success.

The operation is safe to replay after a crash or refusal. Exact copies are accepted without another Keychain read, missing copies resume, and an existing conflicting or unsafe file stops the run without overwrite. A pointer change during execution is a refusal even when an earlier copy succeeded; stop Oompa and replay so the current complete pointer set can be proved. The operator never deletes or changes an entry in the legacy Keychain service. Keep those entries as recovery evidence until the prerelease installation is no longer needed, then review any manual cleanup separately.

## Replace a quarantined current target

Use this exceptional preproduction recovery path only when the active task already authorizes hosted delivery and the current default production deployment is unsuitable for bootstrap. It stays inside the current project and never reads, selects, imports, recreates, or modifies a retired v0 resource. The retired `approve both` phrase is not a recurring authorization gate.

Log in with the Convex CLI first. Its global `config.json` must be a regular, single-link, mode-`0600` file. Do not supply a deploy key or deployment selector through an environment variable, `.env`, or `.env.local`. Choose one UUIDv7 replacement ID and one unused absolute evidence path whose existing parent is an invoking-user-owned mode-`0700` directory. Both values remain fixed across the whole transaction.

Create and receipt one distinct non-default production target from the exact current-default tuple:

```sh
bun run hosted:replace-target -- create --execute \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The operator first proves that supplied tuple is the current default, writes a protected create intent and dispatch receipt, creates only a production deployment with a unique `oompa-replace-…` reference and `isDefault: false`, then reads the reference, new target, and old default back. It emits one closed JSON record. A `created_receipted` result means the new target is distinct and non-default while the supplied target remains default; record only the returned target tuple in the private release record.

Read durable replacement state with the same tuple, replacement ID, and evidence path:

```sh
bun run hosted:replace-target -- status \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

For `created_receipted`, `demoted_receipted`, and `complete`, status performs the corresponding remote read through an ordinary bounded child before reporting that state. Other intent or dispatched states describe protected local evidence only and make no remote success claim. A `*_dispatched_reconciliation_required` result must be resumed with the same `create --execute` or `switch --execute` command, never with a new replacement ID or evidence path. The operator reconciles the recorded phase before any recorded successor mutation.

After the create receipt is current, switch the project default with the same values:

```sh
bun run hosted:replace-target -- switch --execute \
  --replacement-id <UUIDV7> \
  --evidence-path /protected/release/convex-replacement.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

Convex requires the former default to be demoted before another production deployment can be promoted. The operator persists separate demote and promote dispatches, verifies the deliberate no-default intermediate state, and then promotes the replacement. It never promotes after an indeterminate demotion and never demotes again after an indeterminate promotion; a resumed switch reconciles the recorded phase first. Do not run deploy, configure, bootstrap, invitations, a DNS change, or an alias change while the project has no default. `complete` is emitted only after the replacement is read back as default and the former target as non-default.

This changes Convex default selection only. It does not change Oompa's checked source target, release evidence, site environment, user deployment custody, DNS, domain assignment, or production alias. Bind the returned target tuple into a separately reviewed source release before treating it as Oompa's hosted-sync endpoint.

## Create fresh state

Record the exact clean 40-character lowercase Git commit. Deploy that source before any authentication or invitation write. Substitute the verified current target tuple and exact commit below:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit 0123456789abcdef0123456789abcdef01234567
```

The helper requires `HEAD` to equal that commit and the entire checkout, including untracked files, to be clean before and after deployment. It refuses any caller team ID except `513923`, then reads the authenticated Convex management API before and after the mutation and requires team slug `cclrte`, team ID `513923`, the exact project, deployment, production type, generated deployment name, URL, and two matching default-production facts: the deployment reports `isDefault: true` and the project names that deployment as `prodDeploymentName`. It rejects selectors such as `prod`, `local`, and `team:project:prod`, and rejects the retired Oompa v0 numeric IDs.

The helper creates a private exclusive environment file containing only `CONVEX_DEPLOYMENT=prod:<generated-name>`. Convex uses that value as project context and deploys to the project's current default production deployment, so the matching default-production readbacks are part of the target guard rather than an informational check. After Convex resolves the actual deployment credentials and before it pushes, its mandatory `--cmd` exposes the resolved canonical cloud URL only to a silent local assertion. That assertion must match the exact expected deployment URL or the deploy stops before `runPush`; a later default change cannot redirect the already-resolved credentials. The helper disables Convex's optional pre-command WorkOS provisioning because Oompa does not use Convex AuthKit and no provider mutation may precede this assertion. It otherwise invokes `convex deploy --env-file` with confirmation disabled, strict typechecking, code generation disabled, sanitized inherited environment variables, bounded provider output, and a ten-minute deadline. Provider output is suppressed. A failure, changed default, resolved-target mismatch, or dirty postflight leaves the deployment quarantined for inspection; do not retry it.

## Release deployment evidence

The ordinary first deployment above installs the tracked `releaseAttestation:read` query in its explicit unbound state. The query exposes only schema identity and binding state. It contains no credential, provider response, deployment selector, or secret. A transport failure, missing function, malformed response, or timed-out query is ambiguous and never counts as an unbound runtime.

Create release evidence only from a clean detached worktree at the exact source commit. The evidence directory must be canonical, invoking-user-owned, and mode `0700`; each output path must not name a symlink or unsafe existing file. Bind the first release deployment as the bootstrap phase:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit <BOOTSTRAP_COMMIT> \
  --phase bootstrap \
  --evidence-path /protected/release/bootstrap-deploy.json
```

The bootstrap pre-read must positively return the tracked unbound attestation. Oompa records a protected intent before deployment. It creates a private temporary tree with `git archive` from the exact clean commit and refuses an archive that already contains `node_modules`, a symlink in any package, assertion, or CLI ancestor, or an unsafe lockfile. Inside that tree, the pinned Bun 1.3.14 runtime runs `install --frozen-lockfile --ignore-scripts --backend=copyfile` as an ordinary child with explicit runtime and output limits. The explicit copyfile backend prevents installed package bytes from sharing hard links with Bun's cache or another dependency tree. The install must finish successfully, leave `bun.lock` and `package.json` byte-identical, and produce a local Convex CLI beneath the private source root. Oompa captures type, device, inode, and link-count identities for the private archive root, source and package inputs, assertion path, installed Convex package ancestry, manifest, and CLI; every captured regular file must have exactly one link. It rechecks the complete identity set immediately before launching the ordinary bounded provider child. A detected symlink, hard-linked file, ancestor replacement, or file substitution refuses before launch. Provider execution uses that archived CLI and assertion rather than the operator checkout's mutable dependency tree. Oompa then overlays only `convex/releaseAttestation.ts` with the bound source commit, fresh runtime revision, deployment time, and null predecessor, and deploys from that tree. An install refusal cannot reach provider execution. Reported process-cleanup failures retain the private source root; failed filesystem removal retains the affected recovery paths. The operator checkout remains unchanged. The postflight query must return that exact attestation on the same fixed numeric target tuple before final evidence is published.

These identity checks detect substitutions visible at their explicit checkpoints. They are not a filesystem sandbox against hostile code already running as the same operating-system user, which could race pathname access after a check or modify an inode in place. Do not run the release operator beside untrusted same-UID code. The ordinary child runner does not prove the lifetime or cleanup of install or provider descendants. Its exit status is not evidence that a remote effect did not occur; durable intents and exact target and attestation reconciliation remain required.

Deploy each candidate from its exact clean detached commit and bind it to the receipt for the deployment that is currently live. The first candidate names the bootstrap receipt. Every later candidate names the immediately preceding candidate receipt:

```sh
bun run hosted:deploy -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --source-commit <N_COMMIT> \
  --phase candidate \
  --previous-deploy-evidence /protected/release/<CURRENT_DEPLOY_RECEIPT>.json \
  --evidence-path /protected/release/candidate-<N_COMMIT>-deploy.json
```

The candidate intent requires its `before` attestation to equal the predecessor receipt's `after` attestation, requires the predecessor and candidate to name the same fixed target, names the predecessor evidence digest, advances deployment time and runtime revision, and binds `runtimeSourceCommit` to `N_COMMIT`. Choose a new, unused, source-qualified evidence path for every candidate. Never rename or overwrite an earlier receipt. A reviewed exact protected-main commit may be deployed as a candidate before a Git tag, GitHub Release, or npm publication exists. If hosted evidence is cited for a tagged release, the final deployed source commit must equal the tagged commit. When protected `main` advances after a candidate deployment, deploy another candidate from the new exact commit and chain it from the currently live candidate receipt. Do not bootstrap again. Losing CLI output never authorizes a speculative redeploy. A retry may finalize only when the durable intent, current runtime attestation, fixed target, and prior evidence still match exactly. Drift or an ambiguous provider read is a refusal. An exact completed evidence file replays through read-only attestation and target checks without deploying.

There is one exceptional fresh-source supersession path for a bootstrap or candidate intent that cannot deploy its source. Use it only with independent evidence that the failed Convex process stopped determinately before the remote `/api/deploy2/start_push` mutation boundary, local process cleanup is proven, the exact numeric target is reverified, and a fresh authority read exactly equals the failed intent's recorded `before` attestation. Launching Convex, performing read-only target resolution, or completing the non-activating `/api/deploy2/evaluate_push` provider validation does not disqualify this path. Any possibility that the `start_push` request began prohibits it. Keep the failed source-qualified evidence path reserved, and keep its `.intent` byte-for-byte unchanged as quarantine evidence. From a newer exact clean fixed commit, choose a different source-qualified evidence path in the same protected release directory and run the same phase under the single release authority. Bootstrap again only while the runtime remains unbound. For a failed candidate, the runtime must remain bound to the failed intent's `before` attestation, and the fresh candidate must name the same protected, completed, currently live predecessor receipt that the failed candidate named. Never use the failed intent, its incomplete evidence path, or any synthesized replacement as predecessor evidence, and never bootstrap over a bound runtime. Never delete, rename, overwrite, or retry the failed path from the newer checkout. Once the fixed deployment binds, its changed attestation makes the old intent inert and any replay of the old path fails closed. An ambiguous mutation boundary, changed or unreadable runtime, unproven cleanup, target drift, predecessor drift, reused path, or missing old intent prohibits supersession.

Deployment intents and final documents use canonical SHA-256 JSON, bounded no-follow reads, exclusive mode-`0600` files, descriptor and path identity checks, file and directory sync, and atomic no-replace publication. Retain the `.intent` beside its final evidence until the release is complete.

### Upgrade predecessor quota ledgers before capacity repair

The memory schema adds a quota category and a per-user resource counter.
Existing accounts need an explicit additive upgrade before ordinary writes or
command-capacity repair can use the new schema. Deploy the checked forward
candidate first, retain both its protected deployment evidence and its exact
predecessor evidence, then run the quota operator from that clean source:

```sh
run_quota_upgrade() (
  unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD \
    DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
    DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH \
    DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH &&
  command bun --no-env-file --config=/dev/null \
    ./scripts/verify-app-source-launcher.ts quota-upgrade "$@"
)

run_quota_upgrade status \
  --source-commit <CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --previous-deploy-evidence /protected/release/previous-deploy.json \
  --deployment steady-otter-321 \
  --team-id 513923 --project-id 2854545 --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

`status` makes bounded reads and reports closed schema-3 aggregate counts:
`legacy`, `legacyEmptyLiveTail`, `unmarkedCurrent`, `incompleteEmptyMemory`,
`current` and `corrupt`. These six counts sum to `scanned`. It does not publish
an intent, upgrade an identity or clear the command-capacity hold. If
the audit reports corruption, stop and diagnose a forward repair; never
reinitialize existing quota authority or infer a missing counter's value.

Repeat that read command with `diagnose` instead of `status` to identify the
closed reason counts. It uses the same source, candidate, predecessor, target
and runtime checks. It reports the first classification failure per identity:
missing or duplicate authority, invalid counters or markers, exceeded ceilings,
inconsistent totals, incomplete schema shape, or unexpected legacy detail or
memory data.
For an incomplete shape, `missingShapes` groups identical marked or unmarked
ledgers by their missing categories and resources. It also distinguishes absent,
zero and nonzero retained memory counters, without exposing their values. Each
group comes from the same validated rows as its failure; there are at most eight
groups per page. The groups account for exactly the `schema_shape` count. A
missing counter alone remains unknown, even when the remaining memory counter
is zero. Incomplete-memory eligibility additionally requires both owner memory
indexes to be empty in the same read. Such ledgers count as
`incompleteEmptyMemory`; ones with owner data report `incomplete_memory_present`.
The exact older layout described below counts as `legacyEmptyLiveTail` only
when both memory indexes and the owner detail-stream index are empty.
`legacy_chunks_present` refuses that layout when any owner detail chunk exists;
`legacy_memory_present` refuses it when memory data exists. The diagnostic emits
no identity, raw counter, cursor or content. Global service-authority
corruption still refuses the scan. Counts are consistent within each bounded
page; a multi-page scan is not a single snapshot. Diagnosis publishes no repair
evidence and authorizes neither repair nor activation. Both read commands
reject mutation acknowledgements and an output evidence path.

For an admissible legacy, empty-live-tail predecessor, unmarked current or
incomplete-empty-memory ledger, repeat the same command with `repair` instead
of `status` and add
`--evidence-path /protected/release/quota-upgrade.json --execute --acknowledge-forward-only`.
The operator re-audits before writing, binds a protected intent to the exact
candidate, predecessor, target and runtime, and upgrades at most eight
identities in each atomic page. An exact eleven-category, six-resource legacy
ledger receives the two zero memory counters and an identity-row version marker.

The `legacy_empty_live_tail` disposition handles only the exact older unmarked
eleven-category, five-resource ledger, missing the `memory` category and the
`live_chunk` and `memory_space` resources. It requires no owner detail chunk:
`sessionChunks.by_user_and_stream` reads at most one row for that user and
`stream: "detail"`. Expired chunks, chunks without an expiry and orphan chunks
all disprove zero, even if no session head remains. Compact-only history is
preserved and does not block this transition. The mutation also proves that
both owner memory indexes are empty in the same transaction. It adds exactly
three zero authority rows and the identity marker; marked or partially filled
variants of this older layout refuse.

A complete unmarked current ledger receives only the marker. An
incomplete-empty-memory ledger receives only its missing `memory` category and/or `memory_space` resource.
This completion requires all fixed predecessor rows, only an absent or current
identity marker, zero retained memory counters, and no owner `memorySpaces` or
`memoryOperations`, including orphan operations. It adds an absent marker and
preserves a current marker. These partial or marked forms never count as legacy.
Existing fields, counters, IDs, timestamps, service totals and limits remain
unchanged; no user content is deleted. Other missing authority and nonzero
retained memory counters refuse. Fresh identities carry the marker from
initialization.

The operator rechecks that eligibility in each atomic mutation. A read-only
eligible result does not authorize using stale counters or ignoring later owner
data. Schema-3 page counts distinguish `changed` identities, six-resource legacy
`upgraded` identities, five-resource `upgradedLiveTail` identities, newly `marked`
identities and `repairedMemory` completions. The protected intent and receipt
bind schema version 3 and fixed policy `empty-live-tail-memory-authority-v1` to
the exact source and deployment. Historical schema-1 and schema-2 evidence is
retained and never reused or reinterpreted as authority for this policy. The
stored identity marker remains `quotaSchemaVersion: 2`; the wire version change
does not alter current ledger accounting.

After two complete clean audits, the operator publishes a protected completion
receipt. An interrupted invocation retains its intent; the same bound repair
first audits current state and never guesses whether an earlier page committed.
Exact completed replay performs the audits without repeating mutations.
Provider errors, binding drift or unproven process cleanup remain failures.
Retain recovery paths and resolve the existing recovery journal before resuming.

This receipt proves only the quota schema upgrade. It authorizes no daemon,
provider writer or capacity activation. Continue with the command-capacity
operator below; its two-pass evidence, activation and target-marker gates are
unchanged. Do not downgrade to code that does not understand the new ledger
shape. Do not invoke the internal migration manually or bypass the source
launcher with a package-script alias.

### Converge command lifecycle capacity before writer rollout

The additive command-lifecycle and durable-job-capacity deployment is a
forward-only boundary as soon as it admits one command, creates one command
lifecycle/security reservation, creates any account-deletion or
device-revocation capacity row, adds an inline account-deletion reserve, or
accepts a capacity-backed deletion or revocation job. Account capacity consists
of either the dedicated identity/job pair or the legacy inline subject reserve
and dedicated job row described below. Device capacity is a
device/job/security/receipt quartet for each non-revoked device. That is true
for marker-absent traffic and migration repairs, not only after a marker-2
browser or daemon goes live. Once any such capacity exists, never redeploy
a pre-capacity hosted predecessor: it cannot consume command reservations
during settlement, account for the new physical job shape, exchange the
authority-reduction rows, or erase every obligation during account deletion.
Once an inline subject reserve exists, the same restriction applies to every
pre-inline schema and runtime, including versions that support dedicated
capacity rows: they cannot preserve or consume the inline field.
Repair forward from the exact currently live candidate instead.

Run the capacity operator after the candidate deployment and any required
quota-ledger upgrade, and
before upgrading current daemons/executors or declaring current command
writers available. The Vercel app can auto-build from `main` before this gate;
an early UI deployment is not capacity readiness. Fresh marker-2 enqueue is
refused before any command, quota, or security write until the hosted candidate
has consumed the protected capacity evidence and stored its exact activation
tuple. A marker-2 prepare or new effect-start transition is refused by the same
exact-runtime gate. The operator publishes the final activation receipt only
after reading that tuple back and re-proving its bindings; the receipt records
the already-active gate and is required before declaring writers ready, but its
local publication does not open the runtime gate. Exact same-key replay,
terminal and cleanup paths, and marker-absent compatibility traffic remain
available while the gate is closed. New identities/devices admitted by the candidate receive
their physical authority-reduction sets atomically;
anything admitted before candidate cutover remains explicit scan debt. Do not use a
package-script alias or invoke the TypeScript operator directly. Define this
stage-zero wrapper from the exact clean candidate checkout; it removes every
supported Bun/native injection variable before the builtins-only launcher is
evaluated. The launcher raw-proves the requested commit, creates a private
detached tree, performs the pinned Bun 1.3.14 frozen copyfile install with
scripts disabled, re-proves that tree, and runs the operator only from it:

```sh
run_command_capacity() (
  unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD \
    DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
    DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH \
    DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH &&
  command bun --no-env-file --config=/dev/null \
    ./scripts/verify-app-source-launcher.ts command-capacity "$@"
)

run_command_capacity status \
  --source-commit <CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-<CANDIDATE_COMMIT>-deploy.json \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

To distinguish authority-reduction quota ceilings without attempting a repair,
use the same wrapper and exact candidate/target arguments with
`diagnose-headroom` in place of `status`:

```sh
run_command_capacity diagnose-headroom \
  --source-commit <CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-<CANDIDATE_COMMIT>-deploy.json \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

The diagnostic emits a separate version-2 result with
`state: "diagnostic_complete"`, `repairAuthorized: false` and
`activationAuthorized: false`. Completion means its bounded observations and
source/target checks finished. It does not mean quota fits, clear a prior
hard-quota hold or produce readiness evidence. Status and repair retain their
version-2 results and existing acceptance requirements.

Only aggregate counts leave the query. The seven fixed ceiling dimensions are
identity, job, device, security and receipt categories, user total and service
total. A missing legacy account set needs one new job record; its identity
reserve is added to the existing auth subject without adding an identity record.
Each missing non-revoked-device quartet needs four records. Exact record demand
is `accountPairs + 4 * deviceQuartets`. Padding demand remains
`(2 * accountPairs + 4 * deviceQuartets) * 2048` bytes, because the inline
subject reserve and dedicated account job each retain their own 2 KiB padding.

`recordsBlocked` is exact for completing that identity's missing sets from the
observed ledger. `bytesBlockedByLowerBound` proves a refusal only when the
required padding already exceeds a ceiling. The inline reserve's actual stored
byte growth is charged to identity; the diagnostic does not invent its metadata
cost. All other byte cases remain `bytesUnknown`, including equality at the
padding floor. Counts across ceilings can overlap, and service observations do
not simulate successively repairing every identity.

`ready` remains the existing capacity-classifier count, not quota admission.
Only `capacityMissing` identities have their quota ledgers evaluated;
`quotaAuthorityUnknown` preserves corrupt or missing ledger authority without
mislabeling it as a ceiling. The query creates no reservation, changes no quota,
and returns no identity, raw usage, timestamp or secret. Cursors remain private
transport state and are absent from emitted output.

Each page reads at most eight identities under one query snapshot. The operator
caps the scan at 626 pages and 5000 identities and refuses incomplete coverage.
Its `per_page_only` consistency does not promise a global snapshot or a stable
population across pages. Exact source, candidate evidence, runtime attestation,
numeric target and process-custody checks remain the same as the status path.
The command rejects execute, acknowledgement, retirement and readiness-evidence
flags. A completed diagnostic never falls through to repair or activation.

The status command enumerates every identity to prove its account pair and
every non-revoked device quartet, then enumerates both command tables in all three nonterminal
states and all five terminal states with provider pages capped at eight maximal
documents. Every internal page is fenced against the candidate receipt's exact
runtime attestation tuple, and each complete scan is sandwiched by raw source,
candidate-receipt, live-attestation, and numeric-target proofs. It reports
`authorityReductionServiceDebt`, `authorityReductionUserDebt`, and the
aggregate `authorityReductionCapacityMissingDebt`,
`authorityReductionOrphanCleanupPendingDebt`,
`authorityReductionOrphanCleanupEligibleDebt`, and
`authorityReductionTopologyBlockedDebt` classifications. The legacy
`authorityReductionUserCandidates` and
`authorityReductionUserCandidatesTruncated` fields remain present but are
always `[]` and `false`. Command-capacity stdout remains version 2. Protected
local readiness evidence and its activation receipt use schema version 2 with
`authorityReductionPolicy: "inline-account-deletion-backfill-v1"`. Historical
schema-1 local receipts cannot authorize this policy. The hosted readiness and
activation contract remains version 1, and the executor marker remains 2.
Status cannot infer a hard quota
without attempting a transactional reservation, so
`authorityReductionHardQuotaBlockedThisRun` is zero on a read-only run. The
remaining fields include `pendingPreparedDebt`, `lifecycleDebt` (unreserved `effect_started` rows),
`unsafeTerminalCleanupDebt`, informational `terminalReceiptDebt`, and bounded
typed command-retirement candidates. Authority-reduction output never includes
user ids, email addresses, timestamps, quota totals, or provider stderr. Never
query or mutate these rows manually in the dashboard or with a raw Convex CLI
call.

For ordinary debt with quota headroom, run the exact same wrapper with:

```sh
run_command_capacity repair \
  --source-commit <CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-<CANDIDATE_COMMIT>-deploy.json \
  --evidence-path /protected/release/command-capacity-<CANDIDATE_COMMIT>.json \
  --execute --acknowledge-forward-only \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

`repair` classifies and, in the same runtime-fenced server operation,
transactionally reclassifies each prospective mutation. It writes only the
exact `capacity_missing` state. For a legacy account without either reservation,
it adds `authSubjects.accountDeletionCapacity` to the unique active subject and
creates the dedicated account job reservation. The inline object contains
`version: 2`, `reservation` as exactly 2048 ASCII `0` characters, and `createdAt`.
The job row uses the same timestamp. Adding the inline object charges its exact
stored byte growth to identity and adds zero identity records. The job row is
charged normally. This preserves the 256-record identity limit and every other
quota; it does not remove auth records or other user data to create headroom.

Existing dedicated version-1 account pairs remain unchanged. Fresh identities
still create that dedicated pair atomically with admission. Every missing
non-revoked-device set receives the existing device/job/security/receipt quartet.
Each dedicated row retains its own 2 KiB padding plus charged document metadata.

Account deletion consumes an inline set by removing the inline reserve in the
same subject patch that disables the subject and advances its auth epoch. It
proves that the stored subject does not grow and exchanges the dedicated job
row for the deletion job. Mixed inline/dedicated identity reserves, partial
sets, duplicate subjects, mismatched timestamps or reservation drift refuse.
Dedicated account deletion and device revocation continue to exchange their
category-matched rows for the exact authority patch, job, security event or
idempotency receipt with a non-growing quota delta. The same repair installs the
physical session (352 KiB) or device (24 KiB) command lifecycle reservation and
the one-record security reservation before a legacy command may cross the
effect boundary. It also removes unsafe cleanup timestamps from unobserved
legacy terminals without adding bytes. It requires two complete, consecutive
zero-debt scans for authority-reduction capacity, pending/prepared,
effect-started, and unsafe cleanup debt before publishing the protected
no-replace capacity evidence. That first file is not rollout or effect
authority. The operator next asks the exact candidate runtime to store its
candidate, target, lifecycle-version, evidence-digest, and full release-
attestation tuple on the uncharged `serviceControl` singleton, exactly reads
that state back, re-proves every binding, and publishes the separate protected
`<evidence-path>.activated` receipt. Only that final receipt proves that the
current runtime will admit marker-2 work. Exact replay re-proves the binding,
repeats both scans, replays or verifies hosted activation, reads it back, and
verifies both protected files; target, source, runtime, candidate, or protected-
file drift refuses. A candidate redeploy changes the compiled release
attestation and makes the prior hosted marker inert until a new bound operator
run activates the replacement. Unfinished predecessor
account-deletion and device-revocation jobs are drained by their no-growth
compatibility paths; new jobs retain physical padding through every state, and
account deletion releases that larger job charge before inserting its smaller
completion receipt. Revocation never grows up to 10,000 session-head rows:
active or idle heads whose execution device is revoked are projected as
orphaned by every public session-head surface, while the stored spelling stays
byte- and record-neutral and all execution authority remains fenced.

A predecessor identity at a hard user, category, or service ceiling may lack
the bytes or records needed to create its physical authority-reduction rows.
The exact rolled-back quota outcome returns
`authority_reduction_hard_quota`. An exact disconnected predecessor OTP shape
returns `authority_reduction_orphan_cleanup_pending` until every relevant write
is strictly older than 24 hours, then
`authority_reduction_orphan_cleanup_eligible`. Every other invalid auth,
deletion-job, device, or partial-reservation shape returns
`authority_reduction_topology_blocked`. Unknown failures remain the generic
`provider_result_invalid`; provider details are never relabelled as quota.
Each outcome is a hard blocker for command-writer rollout and daemon upgrades,
and no capacity evidence or activation receipt is published.
Artifact publication remains independently gated by
[`docs/beta-release.md`](beta-release.md); it does not clear this rollout gate.
Successful per-user mutations and earlier
pages commit before a later user blocks. Repeating the identical bound repair
is idempotent and reclassifies current state before every write.

Handle each closed result separately:

- For `authority_reduction_hard_quota`, reclaim ordinary data only through an
  already-supported, separately authorized product path. The aggregate result
  neither identifies an identity nor authorizes erasure. Use
  `oompa auth delete --acknowledge-erasure` only while deliberately signed in as
  the current identity whose account the owner intends to delete. Never use it
  to guess which identity caused an aggregate blocker.
- For `authority_reduction_orphan_cleanup_pending`, leave the candidate live
  and observe the scheduled retention pass after the strict inactivity window,
  or let the known intended owner complete the ordinary OTP flow. Never guess
  the identity from the aggregate result.
- For `authority_reduction_orphan_cleanup_eligible`, observe another guarded
  status after the scheduled pass. Do not trigger maintenance manually.
- For `authority_reduction_topology_blocked`, stop. A source-qualified forward
  fix must prove the exact non-destructive state transition before any mutation.
- For `provider_result_invalid`, diagnose the guarded provider boundary without
  copying provider stderr into output or treating the failure as quota.

Do not upgrade an executor, announce current command availability, or treat an
already auto-deployed UI as ready. The operator does not expose untrusted provider output and
does not borrow from or raise a hard quota. Do not wait for unrelated 90-day
retention; retained encrypted history may have no expiry. Rerun the same repair
only after the applicable supported state change, or abandon the command-writer
rollout while leaving the additive candidate live. If code must change, chain a new
source-qualified forward-repair candidate from that live receipt; never
redeploy the predecessor. There is no supported manual dashboard edit or raw
Convex mutation.

The two zero passes are meaningful under concurrency: after the additive
candidate is live, every newly admitted identity/device receives its complete
capacity set in the admitting transaction, while an incomplete legacy
backfill remains visible debt. A concurrent delete/revoke consumes its set and
moves into a monotonically draining job, which is not new authority. Each scan
and mutation is internally fenced to the receipt's exact runtime, and the
operator re-proves source, candidate, attestation, and numeric target around
both full passes, hosted activation and readback, and both publications. Accept
the protected capacity evidence together with its exact `.activated` receipt
before enabling a current executor or treating an ordinary current writer as
effect-capable; the capacity evidence alone, a Vercel deployment, stdout
status, or one clean pass is never rollout authority.

The current Oompa credential store also binds the unique active unverified auth
subject to a newly inserted user in the same mutation that creates the user,
account, and deletion pair. A predecessor interruption that committed an
unverified user/account without that binding remains authority-reduction debt
even if its physical pair is complete, so it cannot produce false readiness.
A bounded retention scan preserves a fresh retry, live challenge/session,
device, verified identity, or any ambiguous relationship. Once every relevant
write is strictly older than 24 hours, it atomically releases the exact orphan
account, optional matching unbound subject, deletion pair, user, and quota authority. Until that cleanup
or a successful retry binds the subject, `repair` stays closed and no capacity
evidence or activation receipt is published. The existing bounded retention
cron runs every 15 minutes, but `orphaned_auth_users` receives only its fair
rotation within the shared 200-row limit and 20-row category quanta. Eligibility
does not promise deletion on the next run. Repeat guarded status only after
sufficient full rotations. Do not invoke broad maintenance manually: it spans
unrelated retention categories, is not bound to the candidate receipt, and may
delete unrelated eligible rows.

If an expired legacy `pending` or `prepared` row cannot acquire capacity at a
hard ceiling, select only an `eligible` typed candidate from status and add, at
most 64 times per batch:

```text
--retire-no-effect-expired session:<COMMAND_UUID>
```

If a pre-reservation `effect_started` row cannot settle using its actual known
terminal delta, first reconcile the owning daemon's durable effect journal and
independently establish that replay is forbidden. Only an `eligible` status
candidate with exactly one matching enqueue event and no terminal event may be
selected with:

```text
--retire-effect-started device:<COMMAND_UUID>
```

Either irreversible form additionally requires all of:

```text
--retirement-evidence-path /protected/release/command-retirement-<BATCH>.json
--acknowledge-resultless-ambiguous-retirement
```

The operator publishes a protected, source/candidate/runtime-bound `.intent`
before the first irreversible mutation and an independent completed receipt
after the replay-safe batch, even when readiness still has debt and needs a
later batch. On interruption, rerun the identical arguments: the protected
intent supplies the exact sorted IDs, committed mutations replay exactly, and
a mismatch refuses. Effect retirement deliberately records a result-less
`ambiguous` operator abandonment, drops execution authority, converts the
unique enqueue audit row into the terminal audit row, and therefore loses the
separate enqueue audit fact. Missing, duplicate, expired, cross-table-colliding,
or relationship-mismatched evidence is a hard refusal. Never infer an ID from
the aggregate debt count.

`terminalReceiptDebt` can remain nonzero in readiness evidence. Current
requester lists prioritize capacity-backed receipts so an old receipt cannot
head-of-line block newer work, then expose legacy receipts with remaining
slots. Their proof-bound acknowledgement uses the actual delta: it fails closed
at a hard ceiling and succeeds after headroom returns. Revoked-requester legacy
rows retire only after both the command and revocation clocks reach 30 days;
acknowledged no-effect compatibility rows use a bounded persistent scan cursor
without rewriting the original acknowledgement timestamp. `legacyRevoked` and
`operatorAbandoned` are retained evidence counts, not executable debt.

Keep the candidate deployment receipt, every retirement intent and receipt,
the final capacity evidence, and its `.activated` receipt together under the
protected release directory. An early auto-deployed browser is not ready or
effect-capable merely because it exists: daemon upgrades, target marker
admission, and release availability remain behind exact hosted activation. A failure after
the forward-only boundary is repaired by another source-qualified candidate
chained from the live receipt; it is never grounds for predecessor rollback.

### Capture optional browser app source evidence

This verifier produces optional operator evidence for diagnosing the separately
deployed browser app. It is not a release gate, release authorization, or input
to `bun run release:tag`. It does not prove exclusive Vercel writer custody, an
atomic provider snapshot, or the absence of an unobserved move-away-and-restore
between reads. Do not describe the output as authoritative release evidence.

Run only the builtins-only launcher through the shell stage zero shown below,
from the repository root at the exact current protected `main`. The invoking
shell first removes runtime and native-library injection variables; Bun then
starts with dotenv loading disabled and `/dev/null` as its only Bun
configuration. The launcher refuses an invocation that does not retain those
exact runtime flags or that still carries an injection variable. Before it
opens the credential, the launcher requires
the canonical repository root, exact `HEAD`, a clean tracked-and-untracked
worktree, a transparent Git index with no `skip-worktree` or
`assume-unchanged` entries, and no effective repository or worktree
clean/smudge/process filter, external attributes file, automatic line-ending
conversion, forced checkout EOL, or symlink emulation. It requires the stage-zero
index manifest to equal the exact commit tree, then reads every tracked regular
file or symlink without Git checkout conversion and requires its raw Git blob
digest and executable mode to equal that commit. A `git status` result by itself
is never source proof. The exact fetch and push origin must also match, and a
public HTTPS readback must show that `refs/heads/main` still names
`--source-commit`. Both the fetch and push origin must be the literal canonical
`https://github.com/hraness/oompa.git`; SSH and alternate spellings are refused.

The launcher then creates a new private detached worktree, installs the
committed lockfile with `--frozen-lockfile --ignore-scripts --backend=copyfile`,
but first applies the complete source proof to the materialized worktree so Bun
cannot parse checkout-converted package or lockfile bytes. After installation it
repeats the configuration, raw-blob, index, origin, and protected-main checks in
both worktrees. In `prove` mode it next runs only `scripts/build-app.ts`, with
`OOMPA_RELEASE_COMMIT` fixed to that source and both Vercel marker variables
absent, and requires successful completion of the sealed production build.
It repeats both complete source checks after that build. Only then may the
fresh dependency tree receive the credential descriptor. Retained verification
performs no build. The launcher ignores ambient `TMPDIR` and creates
its directory as a direct child of the canonical root-owned sticky `/tmp`
directory, so another operating-system user cannot rename that entry. An attempted build that fails, signals, throws, or fails either post-build
source check retains that worktree and all builder recovery records. Its closed
refusal adds a bounded `retainedBuild` directory locator with `locatorOnly:true`;
this identifies the originally admitted scratch path, not current custody,
cleanup permission or permission to retry. Preserve and reconcile it before
any cleanup. After a successful build and source join, the launcher
removes its exact registered temporary worktree after the verifier returns,
verifies that Git no longer lists it, removes the same private directory
identity, and refuses if cleanup cannot be proven. Every child receives a fixed
minimal environment: provider tokens, hook
variables, proxy variables, custom CA paths, runtime preload options, and caller
`PATH` never cross the launcher boundary. Git hooks and filesystem monitors are
disabled explicitly, as are system and user attribute sources; an effective
repository/worktree transform setting is refused and any committed or
local-info attribute conversion is exposed by the raw-blob comparison. The
protected-main read uses the literal public HTTPS repository URL from `/`,
outside either repository's local configuration.

This boundary avoids executing ignored `node_modules`, ambient Bun preloads,
dotenv files, Bun configuration, or other ignored code from the invoking
checkout. It relies on the invoking shell having started without hostile native
injection, the pinned Bun runtime, system Git,
the committed lockfile and package-integrity checks, and the absence of a
hostile same-UID process racing the launcher's private temporary directory or
credential. After the shell stage zero, the first JavaScript entrypoint is the
builtins-only launcher file from the invoking checkout; its raw whole-tree check
happens before secret access but is not an independent pre-execution attestation
of that first file. It is not a sandbox and does not protect against a
compromised invoking shell, runtime, registry artifact accepted by the lockfile,
kernel, or same-UID account.

Put a short-lived Vercel access token outside the release evidence directory in
a regular invoking-user-owned file with one link, no ACL, mode `0600`, and at
most 8 KiB. Use a JSON object with `token` and, optionally, an integer
`expiresAt` Unix timestamp in seconds at least 15 minutes in the future:

```json
{"token":"<VERCEL_ACCESS_TOKEN>"}
```

Bind the observation to one exact deployment, lowercase 40-character commit,
and canonical stable release version:

```sh
(
  unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD \
    DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
    DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH \
    DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH &&
  command bun --no-env-file --config=/dev/null \
    ./scripts/verify-app-source-launcher.ts prove \
    --deployment-id <VERCEL_DEPLOYMENT_ID> \
    --evidence-path /protected/release/app-source-proof.json \
    --source-commit <EXACT_MERGED_COMMIT> \
    --release-version <EXACT_RELEASE_VERSION> \
    --vercel-auth-path /protected/credentials/vercel-auth.json
)
```

The launcher, not the shell or package runner, opens the credential after
sealing the source tree. It first checks the open descriptor's regular-file,
owner, link-count, mode, and size identity, then passes it to the internal
verifier on descriptor 3. The verifier repeats those checks, proves the absence
of an ACL, reads the bytes twice under an unchanged identity, validates the
bounded JSON and optional expiry, and closes its descriptor before any provider
request.
After the command returns, revoke the short-lived token and remove its file.
Never retain that file, raw provider responses, or provider-authenticated output
under the release evidence boundary.

The command uses authenticated Vercel readbacks to require team
`team_UAd1iD2XogJlbFg4h14mRaPM`, project
`prj_3olYDT29BrwKO9PLByVq9HlgRkdA`, its GitHub link to repository ID
`1343008607` on production branch `main`, a `READY` production Git deployment
at the exact commit, and the `app.oompa.app` alias attached to that deployment. A
project name, automatic hostname, or successful HTTP response is not a
substitute for those stable identities. The deployment must not be prebuilt,
and its best-effort provider `source` field must still say `git` as a
conservative refusal guard against manual CLI uploads; that field is not used
as standalone provenance. The current project must match the exact root,
framework, build, install, output, and outside-root-source contract above; its
dashboard ignore command may be unset because the tracked configuration owns
that setting, but any other value is refused. The effective deployment must
carry the exact tracked build, install, output, framework, and ignore command.
The v13 detail must report all six of those historical settings, including the
nullable dev command. A second bounded, cursor-paginated `/v7/deployments`
readback locates the exact deployment under project, commit, branch, target,
and state filters. Its optional settings may be absent, but every reported
setting must match, including root and outside-root values if present. Missing
historical root and outside-root settings are explicitly `not-attested`;
current project settings never fill them in. Mandatory public artifact equality
below establishes the served publication, without claiming the historical
build used a root setting that the provider does not expose. The exact project-domain
record must be verified,
unredirected, production-scoped, and directly configured through a Vercel
`A` or `CNAME` record rather than an HTTP proxy. The project must have no live
bulk redirects, active rolling release, live project routing rules, or active
valid WAF redirect rule. The alias must have no redirect or microfrontend
routing authority that could serve another deployment. Skew Protection must be
disabled: the project boundary must be absent and its maximum age absent or
zero. Otherwise an old document, a deployment-qualified URL or header, or the
Vercel deployment cookie can continue routing a client to an older deployment
even while the production alias points at the candidate, so the verifier
refuses that state.

Between two complete provider samples, the command fetches a freshly
cache-busted `https://app.oompa.app/.well-known/oompa-app.json` without Vercel
authentication and parses it as strict JSON. It requires exactly this document:

```json
{
  "generation": 1,
  "product": "Oompa App",
  "repository": {
    "id": 1343008607,
    "path": "hraness/oompa"
  },
  "schemaVersion": 1,
  "source": {
    "commit": "<EXACT_MERGED_COMMIT>"
  },
  "version": "<EXACT_RELEASE_VERSION>"
}
```

It also requires a standalone `no-store` response cache directive. The command
accepts only when both normalized provider samples are identical and name the
input deployment and commit, while the marker names the input commit and
version. Each sample records the alias UID and provider `updatedAt` millisecond
timestamp as change-detection signals. Vercel does not document that timestamp
as a unique monotonic revision, so those fields do not make the sequential
sample ABA-safe. A missing marker, an HTML fallback, an extra or malformed
field, a cache-policy failure, a commit mismatch, a project or deployment
build-setting mismatch, indirect or misconfigured DNS, a live bulk redirect,
an active rolling release, active Skew Protection, any live project route, an
active WAF redirect, an observed provider or protected-main change during the
at-most-five-minute sample, or a non-READY deployment stops the observation.

The same sample also compares every artifact in the fresh local app publication
with its exact public URL, plus `/` with the local `index.html`. All public
requests exclude credentials, refuse redirects and unexpected origins, use a
fresh nonce and enforce the seven source-defined security headers; both HTML
entry responses and the marker require `no-store`. Actual response lengths and
SHA-256 digests must equal the complete local inventory. The marker is compared
as exact canonical bytes as well as parsed identity. The local reader joins the
publication record to its actual package, lockfile, marker environment and full
`app/dist` inventory before and after network observation. The launcher's
successful sealed build supplies compiler-completion provenance; parsing a
publication record alone does not reconstruct that provenance.

The accepted inventory allows at most 64 files, 8 MiB per artifact, and 32 MiB
across all public artifact response bytes, including the additional `/` read.
All provider, marker and artifact requests share the 128-request, five-minute
observation budget and per-request deadline. Existing local builder readers
retain their own 4,096-file, 64-MiB-file and 256-MiB census limits; the smaller
public limits do not claim stronger local preallocation bounds. The receipt
contains the complete manifest and its digest, explicit byte counters and
source/package/lock/publication bindings. It proves equality for the named
publication and canonical entry only; it does not enumerate unlisted remote
files or prove their absence. Source and provider samples still cannot rule out
an unobserved move away and restoration between reads.

The bulk-redirect read requests page 1 with ten records per page. A response
without pagination is accepted only as the exact empty form
`{redirects:[],version:null}`, corroborated by an authenticated empty versions
list. The firewall configuration list supplies its full active configuration
for the existing identity and redirect checks. Only explicit
`{active:null,draft:null,versions:[]}` proves an unconfigured firewall; its
receipt records null configuration ID, version and enabled state together.
HTTP errors and missing fields never establish absence.

`--evidence-path` must be an absolute normalized path naming an absent direct
child of a protected mode-`0700` evidence directory. The command publishes one
schema-version-4 canonical, self-digested, mode-`0600`, single-link document
through no-follow and atomic no-replace checks, then syncs and revalidates it.
Earlier proof versions require a fresh observation with the current verifier.
It never overwrites or treats an exact replay as success. Standard output is
only a bounded non-secret echo for observation; shell redirection of stdout is
not evidence. Standard error is one closed refusal code. Neither stream
contains the access token or raw provider responses.

Revalidate a retained file from a fresh exact-current-main verifier tree with:

```sh
(
  unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD \
    DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
    DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH \
    DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH &&
  command bun --no-env-file --config=/dev/null \
    ./scripts/verify-app-source-launcher.ts verify-retained \
    --evidence-path /protected/release/app-source-proof.json \
    --source-commit <EXACT_CURRENT_MAIN_COMMIT> \
    --release-version <EXACT_RELEASE_VERSION>
)
```

This reads the protected file with descriptor and path identity checks, verifies
its strict schema and self-digest, and requires its internal marker, source,
version, timing, and current-main bindings to agree. If capture was interrupted
after atomic no-replace publication but before its temporary hard link was
removed, this retained verification accepts only the one exact two-link file,
removes that matching temporary link, syncs the directory, and then reports the
proof verified. It does not repeat the live Vercel sample. The retained read is
sandwiched between two exact current-main source checks. An advance of protected
`main` makes the current-main invocation refuse an older file; capture a new
observation if one is useful. Keep only the bounded optional proof, never its
credential, under the evidence boundary.

## Configure secrets

`bun run hosted:configure` accepts one strict JSON object with exactly these fields:

```json
{"attentionResendApiKey":"<attention-secret>","authEmailReplyTo":"ben@substrate.run","resendApiKey":"<sign-in-secret>","siteUrl":"https://oompa.app"}
```

`siteUrl` must be one HTTPS origin. For the Oompa `v0.1.0` authority it is exactly `https://oompa.app`, the final canonical origin. Do not substitute `https://hra.vercel.app` or an automatic deployment hostname: configuration is one-shot, while staging aliases move and rehearsal may replace candidate deployments. `resendApiKey` must be a Resend sending key. Oompa pins every OTP sender to `Oompa sign-in <oompa@auth.hraness.com>` in source; the operator cannot replace it with an environment value. `authEmailReplyTo` must be one lowercase canonical mailbox without an apostrophe that is monitored and verified to receive mail. The sending-only `auth.hraness.com` and `news.hraness.com` domains are rejected. If the runtime variable is absent, Oompa falls back to the receive-capable `ben@substrate.run` mailbox. The helper generates a fresh 2048-bit RS256 private key, its matching public JWKS, and a 256-bit HMAC secret locally with WebCrypto.

`attentionResendApiKey` is a separate sending key for attention email. Both
keys must use the strict `re_` token format, be 8 to 512 characters long, and
have different values. Keep the sign-in key scoped to `auth.hraness.com` and
the attention key scoped to `news.hraness.com` in the intended Resend account.
Local syntax and inequality checks do not prove provider account identity,
domain scope, verification, deliverability, or permission to activate sending.
Attention email retains `Oompa attention <notifications@news.hraness.com>` and
the subject `Oompa needs your attention`. Its body version 1 and idempotency
contract are unchanged. A missing, malformed, or shared attention key stops
the production drain before it claims an attempt; it does not fall back to
the sign-in key or consume a network retry. Configuring these secrets does not
enable attention notifications.

Pass the JSON from a protected secret source through standard input:

```sh
protected-json-source | bun run hosted:configure -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

An agent can use a private nonterminal descriptor. Invoke the entry point
directly so descriptor 3 is preserved on Darwin:

```sh
bun ./scripts/configure-hosted-sync.ts \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --input-fd 3 3< <(protected-json-source)
```

Replace `protected-json-source` with a password manager or equivalent process that emits the complete JSON document only into the pipe. Do not put any value in an argument, environment variable, shell assignment, temporary file, clipboard transcript, `tee`, or traced shell. Do not paste the document into a shell command. Keep shell tracing disabled.

The helper reads at most 8 KiB, rejects a terminal descriptor, and ignores inherited credential variables. Before and after the provider commands, it performs the same numeric management-API identity proof used by deployment. The only setup datum it gives Convex in argv is the exact generated deployment name. It first reads environment names with `convex env list --names-only`. It then sends one in-memory dotenv document to `convex env set` over a pipe without `--force`, and reads names again. Provider stdout and stderr are never forwarded. Success means all and only these Oompa values were submitted:

- `SITE_URL`
- `JWT_PRIVATE_KEY`
- `JWKS`
- `OOMPA_AUTH_HMAC_SECRET`
- `OOMPA_RESEND_API_KEY`
- `OOMPA_ATTENTION_RESEND_API_KEY`
- `OOMPA_AUTH_EMAIL_REPLY_TO`

If any target name already exists, the names response is ambiguous, Convex refuses the batch, or the final names readback is incomplete, the helper closes with a generic error. A failure after the batch may have left a complete or partial provider write. Do not retry or overwrite. Inspect names only, then replace the still-unused deployment if the result is uncertain.

### Migrate the Reply-To name on an existing deployment

Deployments configured before `OOMPA_AUTH_EMAIL_REPLY_TO` became required continue
to send with the source-pinned `ben@substrate.run` fallback, but hosted preflight
requires the replacement name to be present explicitly. Run this checkout-only
package entry from the exact clean candidate commit, after its attested candidate
deploy and before hosted status:

```sh
bun run hosted:migrate-reply-to -- \
  --source-commit <N_COMMIT> \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --evidence-path /protected/release/reply-to-migration.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The operator requires `HEAD` to equal `N_COMMIT` and the complete checkout to be
clean. It reads a protected, candidate-phase deploy receipt whose source and
target match, then proves the live release attestation equals that receipt. It
repeats the source, target, receipt, and runtime proof before mutation and before
publishing its own protected receipt. Keep the candidate deploy, this migration,
and then `hosted:status --require-passed` in that order.

The ordinary write preflight requires the exact predecessor name set:
`SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`, `OOMPA_AUTH_HMAC_SECRET`,
`OOMPA_RESEND_API_KEY`, and the retired `OOMPA_AUTH_EMAIL_FROM`; it also requires
`OOMPA_AUTH_EMAIL_REPLY_TO` to be absent. A missing old From name signals drift
from the known predecessor configuration and refuses before an intent or effect.
The migration never reads, sets, or removes the old value, so it remains
available to the predecessor runtime for immediate rollback. Unrelated provider
names are also left alone. This migration is additive and preserves that known
rollback configuration; it does not establish rollback readiness for any other
source or manually altered environment.

Before the only permitted write, Oompa publishes a mode-`0600`, single-link intent
beside the requested receipt path. It then sends only the source-pinned default
as one in-memory dotenv line to `convex env set` through standard input. It never
puts the mailbox in argv, the child environment, or output, and it never reads or
replaces JWT, JWKS, HMAC, or Resend values. Whether the set command returns zero,
nonzero, or loses its ordinary response after cleanup and target identity remain
proved, Oompa does not set again: it reads `OOMPA_AUTH_EMAIL_REPLY_TO` from the exact
target and requires byte-exact `ben@substrate.run` plus one newline, then reads
names and requires all seven names: the six-name predecessor set plus the new
Reply-To name. Only that proof, a fresh matching
release attestation, and unchanged protected intent permit the final receipt.

A restart with the same exact arguments is read-only. A matching intent can be
completed without another set only when the exact value and all seven names are
already present, including the retained old From name. A matching receipt is
replayed only after the same remote
proofs. A replacement name that predates the intent, a conflicting or missing
value, changed source, target, deploy receipt, runtime attestation, evidence
custody, authority containment, or unproven process cleanup fails closed. Keep
both the receipt and its `.intent`; do not delete or rewrite either to force a
retry.

### Prepare an existing deployment for a separate attention key

Existing deployments need a separately scoped attention key before the new
runtime can send attention email. The checkout-only helper below is
**preparation and read-only reconciliation**, not a migration writer. The
pinned Convex 1.45 environment importer reads existing names and then submits
an unconditional `{changes}` update. Its non-force mode cannot prevent a
concurrent insertion between those calls, so it does not provide atomic
add-only creation. The helper has no environment-write transport or apply
phase. It never overwrites a key or treats task ownership as exclusive
provider custody.

From the exact clean candidate checkout, provide one strict JSON document
through an anonymous shell pipe from a protected secret source. This operator
rejects terminal input, redirected regular files, named FIFOs, sockets, and
unproved descriptor identities before reading the secret. It retains the
8 KiB and 15-second input limits:

```json
{"attentionResendApiKey":"<attention-secret>"}
```

```sh
protected-json-source | bun ./scripts/migrate-hosted-attention-key.ts \
  --phase prepare \
  --source-commit <EXACT_CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --evidence-path /protected/release/attention-key-preparation.json \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The candidate receipt, source commit, current numeric target, runtime
attestation, and untouched inactive control must agree. The control must be
absent at generation zero with zero outbox and safety-fault occupancy. The
operator reads the existing sign-in key only into bounded process memory,
requires a strictly valid distinct intended key, and observes whether the
attention key is absent, equal, or different. Sequential samples detect
observed drift; they do not lock the provider or prove an atomic snapshot.

For a later read-only observation, repeat the same bindings and protected
input, change `--phase` to `reconcile`, add
`--preparation-evidence /protected/release/attention-key-preparation.json`, and
choose a distinct new `--evidence-path`. A changed binding or ambiguous state
refuses. Protected mode-`0600` observation evidence contains a
domain-separated intended-key digest but never a credential. Keep this
evidence private. Standard output contains only bounded non-secret status;
provider responses and key digests are not printed.

Both supported phases report `provider_add_only_unavailable` with
`effect: "none"`, `status: "refused"`, and exit one even when the observation
was saved. The protected document says `observed_only`, never applied or
migrated. An equal value is an observation, not proof that this operator
installed it. Do not reinterpret old Reply-To evidence or remove evidence to
force a write. A future provider-native conditional mechanism or explicitly
reviewed operational custody protocol requires a separate design and live
handoff. Until then, this command cannot complete key migration or authorize
attention activation. Sign-in credentials and delivery remain unchanged.

The initial untouched inactive cron is a quiet no-op, even before the separate
key is provisioned. Previously used, enabled, occupied, or ambiguous state is
not that initial state and cannot skip configuration validation before a claim.

### Install an attention key under operational custody

The separate `scripts/install-hosted-attention-key.ts` operator is for an
existing deployment. Its authority premise is **operational custody attested**,
not provider compare-and-set. Convex's ordinary environment update can overwrite
a concurrent value. Before installation, the deployment custodian must arrange
and attest a short installation window with dashboard, CLI, CI and delegated
environment writers quiesced. A local lock, scheduler grant, process census or
matching readback does not prove that premise. Do not manufacture a custody
attestation from those observations.

Use the exact clean deployed candidate and its protected deploy receipt. First
create an absent-key preparation with the observation-only operator above.
Retain one protected evidence directory for this target across custodians and
recovery attempts. The installer derives its intent slot from the numeric
target and fixed attention-key name, not the operation ID or secret. Changing
directories to evade an existing intent is outside the custody protocol.

The protected custody document binds the source, candidate, preparation,
numeric target, intended-key digest, operation, evidence directory and bounded
installation window. It explicitly records the competing-writer handoff. Its
digest is an integrity binding, not a provider signature or proof that the
operational statements are true. Keep the document and all key digests private.

The intent filename includes the fixed public environment name and hashes only
the exact target. Its non-attention environment digest is a domain-separated
HMAC-SHA-256 fingerprint keyed by the intended attention credential, covering
the target and every sorted non-attention name/value pair. It does not store
an unkeyed digest of other secrets. Retain the intended key for reconciliation;
rotating the administrative credential does not change this comparison.
Pre-release intent filenames and interrupted publications also block a new
installation. Preserve them for reviewed recovery with their original source;
the installer never renames, deletes or silently adopts them.

Supply the distinct attention key and the exact deployment's scoped admin key
through the protected anonymous-pipe input, never command arguments, child
environment variables or a checked-in file:

```json
{"attentionResendApiKey":"<attention-secret>","convexDeploymentAdminKey":"<deployment-admin-secret>"}
```

```sh
protected-json-source | bun ./scripts/install-hosted-attention-key.ts \
  --phase install \
  --source-commit <EXACT_CANDIDATE_COMMIT> \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --preparation-evidence /protected/release/attention-key-preparation.json \
  --custody-attestation /protected/release/attention-key-custody.json \
  --evidence-directory /protected/release/attention-key-installation \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

Installation revalidates exact source, candidate, target, runtime attestation,
absent attention key, prerequisite configuration and untouched inactive state.
It records a durable intent before making one application-level update attempt
for `OOMPA_ATTENTION_RESEND_API_KEY` only. The direct transport has no CLI or SDK
retry, redirect fallback or arbitrary environment patch. It bounds both the
response size and deadline. One application call is not an exactly-once network
guarantee. The other environment values, including the sign-in key, are compared
across readback without exposing their values.

A provider acknowledgement followed by matching readback is distinct from an
uncertain outcome. Once an intent exists, no later invocation may write; use
read-only reconciliation. Repeat the same bindings and protected input with `--phase
reconcile`, retaining the original custody document and operation identity.
Expiration stops a new installation, not intent-bound readback. A replacement
custody document cannot silently adopt an existing intent. Observations and
results append to a bounded sequence without replacing prior evidence; an
exhausted sequence requires reviewed recovery outside this installer.
An equal value means observed equal; it does not identify who wrote it. An
absent value after a timeout does not prove the first request cannot commit
later. A conflicting value stops recovery. Preserve the intent and results;
do not remove them, change the operation or key, or choose another directory to
force another write. Any separate corrective action needs a new reviewed
recovery handoff outside this installer.

The short custody window is an installation-admission deadline, not permission
to resume competing attention-key writes after an uncertain dispatch. Retain
custody, evidence and the attention-key write freeze until the outcome is
reconciled or custody is transferred through a reviewed recovery handoff.
Expiry alone cannot rule out a late provider commit.

Successful key installation does not enable attention or prove the Resend
account, sending-domain permission, recipient consent or delivery. Keep the
attention control inactive until those separate activation requirements pass.
The observation-only operator's existing `prepare` and `reconcile` outputs
remain observations and cannot be relabeled as installation receipts.

## Read hosted preflight status

Before a controlled live-acceptance run, an operator can read one bounded,
non-atomic preflight observation for the exact default production deployment:

```sh
bun run hosted:status -- \
  --source-commit <exact-40-char-lowercase-commit> \
  --deployment <CURRENT_DEFAULT_DEPLOYMENT_NAME> \
  --team-id <CURRENT_TEAM_ID> \
  --project-id <CURRENT_PROJECT_ID> \
  --deployment-id <CURRENT_DEFAULT_DEPLOYMENT_ID> \
  --deployment-url <CURRENT_DEFAULT_DEPLOYMENT_URL>
```

The command requires a caller-supplied exact 40-character lowercase source
commit and all five exact target fields, proves the default target immediately
before and after every provider read, and emits one JSON line. It does not
prove that the caller's checkout is clean or that the supplied commit is the
intended release. Every valid observation exits zero. Add `--require-passed`
when an agent needs a shell gate: it still emits the record but exits one
unless the status is `preflight_passed` or `live`.
Add `--require-attention-inactive` for the Phase 8B inactive-deployment gate.
That optional read calls one named internal projection and exits one unless the
global attention fields are absent at generation zero and both the notification
outbox and safety-fault tables have zero occupancy. The read is bounded to one
row per table and reports only zero-or-one occupancy; it does not expose a
candidate, recipient, delivery record, fault record, or execution lease. Keep
this flag on the inactive checkpoint only; a later reviewed enablement phase
must define its own production proof.
At this exact inactive checkpoint, `OOMPA_ATTENTION_RESEND_API_KEY` may be
absent when all six other managed names are present and
`--require-attention-key-ready` was not requested. The normal source,
bootstrap and admission checks still decide `preflight_passed` or `live`.
The environment observation remains unchanged: `missingRequiredNames` still
lists the absent attention key and `requiredNamesPresent` remains `false`.
Without the requested exact inactive observation, all seven names remain
required for a passing status. Disabled notification control, nonzero
generation, occupied outbox or safety faults cannot use this exception.
Add `--require-attention-key-ready` together with `--require-passed` to require
the current runtime's separate boolean credential check. Its named internal
query returns only `{dedicatedKeyReady}`, which hosted status exposes as
`attentionSending.dedicatedKeyReady`: both sign-in and
attention keys have the strict token format and their values differ. A false
value exits one even when the ordinary hosted state is `live` or the attention
control is inactive. Without this flag, status makes no credential-readiness
claim. A true value does not prove Resend account identity, key domain scope,
sender verification, consent, or notification enablement. Combine it with
`--require-attention-inactive` when checking a still-inactive configured target.
With `--require-passed`, this explicit key gate requires the attention
environment name as well as the separate credential-readiness result;
inactive control never substitutes for either check.
Malformed, unavailable, or ambiguous provider reads exit one; unresolved local
custody exits 75.

The record exposes only the release-attestation binding state, whether all seven
Oompa-managed environment *names* are present and which of those static names
are missing, a capped count of occupied bootstrap tables plus a closed
bootstrap classification, and the safe admission generation, state, and
new-identity admission value. When the inactive gate is requested, it also
includes the closed global-attention state, generation, zero-or-one outbox and
safety-fault occupancy, and the derived inactive verdict. The optional
credential check adds only the dedicated-key boolean; it exposes no key or
digest. A deployment that predates the new-identity
control reports no value, which the operator reads as `invite_only` exactly as
the authority does. It never
emits environment values, unrelated environment names, invitation material,
quota totals, user counts, or database rows. `CONVEX_SITE_URL` is
Convex-owned runtime configuration, not an Oompa-managed protected value, so it
is intentionally neither required nor reported by this command.

`preflight_passed` means the bound release attestation names the supplied
source commit, the managed names satisfy the requirements above, including
the narrowly defined inactive attention-key exception, and the deployment
presents the exact first-bootstrap authority frame with open generation-zero admission.
`live` means the same runtime and environment facts hold, the first invitation
was accepted (the control row carries a durable accepted timestamp ordered
after bootstrap completion), and admission is open at any generation. An
accepted deployment with frozen admission is `preflight_incomplete` with
`resume_admissions` as guidance. A bootstrapped deployment whose first
invitation is unaccepted but no longer in the exact first frame, for example
after a reissue or an admission transition, is `preflight_inconsistent`; the
reissue section describes the only reviewed recovery.
The JSON `releaseAttestation.state` is `current`, `other`, or `unbound`; Oompa
does not print the deployed commit. Its closed `nextAction` is guidance only,
not authorization for a mutation. This does not validate environment values or
sender verification, acquire a provider lock, send an OTP, or prove a live
encrypted-sync path. The reads are sequential and do not acquire a provider
lock or snapshot, so treat the result only as a bounded non-atomic prerequisite
for the controlled live-acceptance scenario.

This is provider-read-only, not filesystem-pure: it runs bounded Convex CLI
reads through the authenticated CLI session on macOS or Linux, and it must not
be used as an authorization shortcut for configure, bootstrap, DNS, or alias
changes.

## Establish hosted authority and issue the first invite

No authentication, OTP, invitation, device, or application write may happen before bootstrap. One request-bound mutation atomically establishes hard quota authority, open generation-zero authentication-admission authority, a durable binding to the first invitation digest, and the charged first invitation. Choose a new absolute output path in a private operator directory. The path must not exist. Run the one-shot bootstrap on the exact new production deployment:

```sh
bun run hosted:bootstrap -- \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/identity-invite
```

The helper uses authenticated CLI state, strips inherited Convex deploy credentials and any inherited value containing an invitation capability, bounds every provider call, and performs numeric target preflight and postflight. It performs this closed sequence:

- Read at most two `storageUsageService`, `serviceControl`, `maintenanceState`, and `authInvites` rows through one bounded inline query and require all four exact empty arrays. Scheduled maintenance is hard-gated on quota authority and may not create its cursor first.
- Resolve and open the output's existing parent as a no-follow directory, require that it is owned by the invoking user with exact mode `0700`, hold and repeatedly verify its owner, mode, device, and inode, then reserve the requested output with no-follow, exclusive creation and mode `0600`. Existing files, shared parent directories, and final-component symlinks are refused before mutation.
- Generate the 256-bit bearer capability locally. Derive its remote public ID from its purpose-separated SHA-256 digest, sync only the capability plus a newline to the reserved file, and verify the same single-link mode-`0600` inode. This protected local custody is durable before the first provider mutation. The capability never enters provider arguments, environment, stdout, or stderr.
- Run `quota:genesisHostedAuthority` with only the digest, derived public ID, and exact 24-hour lifetime. The mutation requires every covered authentication, invitation, device, application, quota, maintenance, and service-control table to be pristine. In one Convex transaction it creates the hard quota singleton, the open service-control singleton with the complete bootstrap binding, the first identity invitation, and its exact service quota charge. A concurrent request with a different full capability digest is refused. Replaying the exact request is neutral.
- Read all three rows again. Require exactly one strict `global` hard quota row charged for exactly one service-owned invitation and zero user data, one strict open generation-zero service-control row bound to this full digest, public ID, and lifetime, and one strict issued invitation with the same binding. Recompute the stored invitation's Convex logical size locally and require both aggregate and service byte counters to equal it.
- Read the exact numeric provider identity again after the mutation. A pre-custody failure removes only the inode this process reserved. Once custody is durable, every failure preserves the capability file for deterministic recovery.

Provider stdout, provider stderr, and the capability are never forwarded. Success returns one bounded JSON object with the safe public invite ID and non-secret invitation state. It attests that the request-bound hosted authority and exact quota charge were read back and that the capability reached the protected file. Record the public ID so the first invitation can be inspected or revoked without reading its capability.

A refusal means the deployment was dirty, another request won bootstrap, provider output was ambiguous, exact authority or quota readback failed, or the output could not be protected. Do not overwrite or discard a populated capability file. Reconcile the exact default deployment first, then recover only through the bootstrap operator with that same file:

```sh
bun run hosted:bootstrap -- recover \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-file /absolute/private/path/identity-invite
```

Recovery accepts only an invoking-user-owned, single-link, mode-`0600` regular file inside the same owned mode-`0700` directory. It rederives the full request binding, invokes only `quota:genesisHostedAuthority`, and requires the same exact three-row readback. It can finish a crash that happened after local custody but before the mutation, and it can reconcile a lost mutation response through exact durable state. It never calls ordinary `authInvites:recordIssue`. A different winner returns `bootstrap_authority_conflict`; the losing file remains intact and must never be passed to `hosted:invites recover`.

If no populated capability file exists and every pre-bootstrap authority remains empty, replace the still-unlaunched deployment and repeat the full fresh-state sequence.

One further state has a reviewed recovery: bootstrap completed, nobody accepted the first invitation before its 24-hour lifetime ended, and the protected capability file is gone. The deployment then holds valid quota and admission authority but no identity, and friend issuance stays locked forever because acceptance never happened. Reissue the first invitation instead of replacing the deployment:

```sh
bun run hosted:bootstrap -- reissue \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/identity-invite-2
```

The reissue pre-read must positively show one bootstrapped service-control row without an accepted timestamp, at most one invitation, and that invitation must be the bound first invitation and already expired. Scheduled maintenance may already have removed the expired row; then the quota counters must read zero records. Any admission generation is accepted, frozen or open, because admission is unrelated to the first invitation. Every other shape, including an invitation that is still active, refuses before a capability is generated or an output path is reserved. Custody then follows the same protected-file sequence as bootstrap. The operator runs only `quota:reissueHostedBootstrapInvite`, which in one Convex transaction requires zero identities and zero users, releases the expired invitation and its quota charge, inserts the new charged first invitation, and rebinds service control to the new digest, public ID, and lifetime. Replaying the exact request while the reissued invitation is active is neutral; a different digest while it is active is refused. The readback requires the same exact three-row binding as genesis except that the control row keeps its current admission generation, state, and mutation ID. A crash after custody recovers with `reissue --invite-file` and the same protected file. Reissue never unlocks friend issuance; only acceptance does.

Any other state is an incident and must remain quarantined for inspection.

## Accept the first invite

Read the capability file only into Oompa's protected authentication JSON input. Never print it, substitute it into argv, copy it into an environment variable, or route it through a log. Complete the verified-email code flow and confirm the identity and first device are active. Consuming this specific bound invitation atomically records a durable bootstrap-accepted timestamp in service control. Later friend invitation issuance depends on that durable fact, so maintenance may remove the terminal invitation receipt without relocking the service. Then remove the one-time capability file.

Continue launch acceptance with a second pending device approved by the active device against the key fingerprint that `oompa device list` shows for it, encrypted projection sync in both directions, usage upload cadence, session streaming, command custody, interaction resolution, revocation, and account deletion. Keep hosted invitations disabled. Hosted acceptance does not authorize domain movement or publication. Those effects use their own separately gated operators: current-package publication now uses the owner-authenticated local `release:tag` command plus the protected tag-push workflow, while domain movement remains outside this hosted-acceptance scope. Retired Oompa v0 resources cannot satisfy either operator's gates.

## Operate friend-beta invitations

Run the friend-beta operator only after the one-shot bootstrap and first-invite acceptance are complete. The server refuses new friend invitations until the durable bootstrap-accepted fact exists. This operator never creates or retries hosted authority. Do not run fresh `hosted:bootstrap` on an initialized deployment; use its dedicated `recover` command only for the original protected bootstrap file.

Issue one 24-hour identity invite into a new absolute path whose parent is an existing invoking-user-owned mode-`0700` operator directory:

```sh
bun run hosted:invites -- issue \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-output /absolute/private/path/friend-name.invite
```

The output path must not exist. The operator reserves it with no-follow exclusive creation, fixes and verifies mode `0600`, generates the capability locally, and durably commits it before provider access. Convex receives only the capability digest and deterministic public ID through an idempotent mutation. It never receives or returns the bearer capability. The operator never puts the capability in argv, an environment variable, terminal output, provider output, or a temporary file. Success prints one bounded JSON object containing the safe public invite ID and non-secret state. Record that public ID in the private release record, then deliver the capability file through the same protected authentication-input flow used for the first invite.

If issuance returns an indeterminate refusal after the capability file was committed, restore exact default-target certainty and recover from the same file:

```sh
bun run hosted:invites -- recover \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --invite-file /absolute/private/path/friend-name.invite
```

Recovery accepts only an owned, single-link, mode-`0600` regular file inside an owned mode-`0700` parent, holds and revalidates both inodes, reads the file without following links, and rederives the digest and public ID. It first reads status by that public ID. Existing issued, bound, consumed, or revoked state is returned without replay. If no row exists, it invokes the same idempotent record mutation and then requires a second status readback. A malformed or lost mutation response is therefore reconciled from durable remote state. Failure preserves the file and prints no capability.

Read status with the public ID:

```sh
bun run hosted:invites -- status \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --public-id invite_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP
```

Revoke the same invite when delivery is abandoned or access should end:

```sh
bun run hosted:invites -- revoke \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud \
  --public-id invite_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP
```

Status and revoke accept only the public ID, never the bearer capability. Revoke reads and validates identity-invite status before mutation. Every operation performs authenticated numeric target readback before and after its bounded Convex call, requires the exact Oompa team, project, production deployment, generated name, and URL, and refuses retired Oompa v0 project ID `2680173` and deployment ID `4677913`. Provider stdout and stderr are suppressed; failures return only a static refusal code.

If issuance is refused after protected custody commits, do not repeat `issue` with a new path. Reconcile the exact default deployment, then use `recover` with the preserved file. Keep the file until a strict result returns its deterministic public ID or the deployment is formally quarantined.

## Operate open sign-up

Two independent controls live on the single `serviceControl` row.
`authAdmissions` is the authentication-admission break-glass: `frozen` blocks
new OTP work, new auth sessions, refresh-session storage, invitation issuance,
and fresh device registration. It does not make ordinary device-authority
checks read service control, so an already-issued JWT and its active device
binding can keep using authenticated paths until that token expires. The
configured JWT lifetime is 15 minutes and refresh is refused while frozen.
This is therefore a bounded eventual cutoff, not an immediate whole-service
lockout, and it is never the way to close sign-up. This release has no global
authenticated-traffic kill switch.
`newIdentityAdmissions` is the narrow control: `invite_only` (the default, and
the meaning of an absent stored value) or `open`. It is read in exactly one
place, where a first `authSubjects` row would be inserted without an
invitation. Everything else is unchanged: a frozen deployment still refuses an
open sign-up before writing any row, identity invitations keep working while
sign-up is open, and a subject admitted without an invitation carries
`admittedBy: "open"` so no later step ever treats a missing invitation as
permission.

Both controls share one generation fence and one mutation identity, so a
change to either advances `authAdmissionGeneration` and an exact replay stays
recognisable. Read the current generation first:

```sh
bun run hosted:admission -- status \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

Open sign-up with the exact generation that status returned, a fresh UUIDv7,
and the explicit acknowledgement:

```sh
bun run hosted:admission -- new-identities \
  --new-identities open \
  --expected-generation <GENERATION> \
  --mutation-id <FRESH_UUIDV7> \
  --acknowledge-open-signup \
  --deployment steady-otter-321 \
  --team-id 513923 \
  --project-id 2854545 \
  --deployment-id 7654321 \
  --deployment-url https://steady-otter-321.convex.cloud
```

Close it again with `--new-identities invite_only` and no acknowledgement.
The acknowledgement is required exactly for the `open` direction, as
`--acknowledge-resume` is for resuming admissions. The operator proves the
exact default target before and after every provider call, refuses a request
whose expected generation is stale, refuses a change the deployment already
has, and reconciles a lost response through durable state instead of replaying
blind. Deploy the authority change through the attested candidate chain before
opening admissions; opening sign-up against a deployment that still runs the
invite-only authority does nothing.

Abuse controls apply to every path, invited or open. One address may receive 3
codes per 15 minutes and 5 per 24 hours, and at most 10 for its lifetime while
it has never verified. The service admits 200 sends per hour, 1,000 per day,
and 200 newly admitted identities per rolling 24 hours, counted on the service
control row. Verification attempts keep their own limits: 100 per hour service
wide and 10 per 15 minutes per address. One verified email owns exactly one
identity: a second subject can never be verified onto the same address or the
same user. Budget a paid Resend plan before opening sign-up; the free tier
delivers 100 messages per day, well under the send ceiling.

## Beta free tier and service ceilings

One identity gets 200 MiB of server-visible logical bytes, 50,000 session
chunks, 20,000 live-tail chunks, 10,000 session heads, 16 devices, 32 Codex
accounts, 256 nonterminal remote commands, and 100,000 usage snapshots per
account. The deployment ceiling is 5,000 identities, 100 GiB, and 25 M
records. The identity count is deliberately oversubscribed against the byte
ceiling: 5,000 tiers of 200 MiB would be 1,000 GiB, so the service byte
ceiling is the real hard stop and must be raised before the service approaches
it. Worst-case usage telemetry for one Codex account before any row becomes
cleanup-eligible is 16,888,144 logical bytes, under a tenth of the tier; the
tier holds twelve such accounts at once.

Authority-reduction capacity is physical and is included in those same hard
totals: each identity has either two dedicated 2 KiB reservation documents or
an inline 2 KiB subject reserve and one dedicated job reserve. Each non-revoked
device has four reservation documents, with normal document metadata charged
in both forms. The reserved bytes slightly reduce space
available to ordinary data, then are exchanged category-for-category when an
account deletion or device revocation is accepted. Command lifecycle and
terminal-security reservations are likewise charged while the command is in
flight and consumed or released as its state shrinks.

These constants are hard authority. A stored counter above the constant reads
as corrupt and fails closed, so never lower a ceiling below what a deployment
already stores. Read current usage first, and deploy a tier change through the
attested candidate chain before it can matter.

## Device commands

A session command names a session and is fenced by that session's execution
lease. A **device command** names a machine and has no session: it is how a
browser asks a machine to start a session before one exists, to relay a
provider login, or to refresh usage. It lives in its own hosted table,
`deviceCommands`, with its own port (`convex/deviceCommands.ts`) and its own
authority model.

The lifecycle is the one every command already uses (enqueue, acknowledge,
prepare, effect started, settle, expire) with the same closed state union and
the same rule that an effect which may have begun is quarantined as
`ambiguous`, never retried. What differs is the fence. There is no lease, so a
device command binds the target daemon's own boot authority at `prepare`; only
a strictly later boot may take over a command that has not started, and a boot
that finds a command it left at `effect_started` may only close it as
`ambiguous`. That is what stops a `session_start` that may or may not have run
from silently starting a second session.

### Request commitment and rolling updates

Every enqueue carries a keyed request commitment over the request fields that
the execution daemon verifies. The requesting client computes an HMAC-SHA256
with the account key. Its message is
`hra-control-plane:<purpose>:v1:<json>`. A session command uses purpose
`command-enqueue` and the exact JSON object key order shown below. A device
command uses purpose `device-command-enqueue` and its separate exact order:

```text
session: {deadline, expectedTargetDevicePublicId, kind, payload, publicId, requestingDevicePublicId, sessionPublicId}
device:  {deadline, expectedTargetDevicePublicId, kind, payload, publicId, requestingDevicePublicId}
```

The `v1` in the HMAC message is the fixed keyed-digest framing version. It is
distinct from hosted request commitment marker 2 and local journal classifier
3.

The hosted enqueue authenticates the requesting device and stores that exact
requester with the target, payload, and digest. The daemon fetches the exact
row and recomputes the commitment from the stored requester. The hosted row
records wire marker 2. A current local journal entry records
`requestCommitmentVersion: 3`, meaning it verified that marker-2 requester
commitment and retained the exact requesting device. Local journal markers 1
and 2, plus pre-marker entries, are legacy recovery evidence, not current
execution authority.

Current verification runs first and is the only path that can reach a provider
effect. If it fails, a daemon may recognize the older HMAC, which omitted
`requestingDevicePublicId`, only to reach a non-executing terminal disposition.
That legacy digest is never trusted as requester authority and is never rebound
to the active browser or device. Apply this decision order:

- An already-hosted terminal row takes precedence. It confirms its hosted
  result and permits local journal retirement without replaying any local
  outcome.
- Otherwise, if the hosted row is nonterminal and either the local journal or
  hosted row records `effect_started`, the hosted command becomes result-less
  `ambiguous` and is never retried.
- A legacy local terminal outcome over a hosted nonterminal row is not trusted.
  The daemon discards that unauthenticated outcome and closes the hosted row
  result-less `ambiguous` with `LOCAL_EFFECT_RECOVERY_REQUIRED`.
- A fresh or local-`prepared` legacy request over a hosted `pending` or
  `prepared` command becomes `failed` with
  `LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT` through the table's dedicated
  `failPrepared` mutation.

When a fresh request's marker differs from the target's last stored registry
marker, it fails before a command, quota charge, or security event is inserted.
Each daemon publishes an internal
`deviceRegistries.commandRequestVersion` marker before command processing. A
fresh enqueue must exactly match its target: marker 2 matches marker 2, while an
absent request marker matches an absent registry marker. Exact idempotency replay
is resolved first, so a committed request remains replayable after its target
upgrades or downgrades; changing the marker under the same key is still an
idempotency conflict. The registry marker is not returned by `getRegistry` or
`listRegistries`. An old daemon's next registry write omits and therefore clears
the marker. If the current daemon cannot publish its registry, it skips both
session- and device-command processing for that cycle while unrelated sync may
continue.

The stored command marker is also checked at `prepare` and
`markEffectStarted`. A marker-2 row requires the current executor marker before
either hosted transition, even if a stale registry still advertises marker 2.
Legacy rows accept only the old-shaped executor marker. The current daemon uses
those transitions only for its legacy recovery flows; it never promotes that
evidence to current provider-effect authority. Because enqueue compares with
the last stored registry marker, a stale matching marker can admit a row during
an upgrade or downgrade window. That row still cannot pass `prepare` or
`markEffectStarted` under a mismatched executor, and recovery classifies it
without authorizing a provider effect.

Never edit or delete the local journal, local CLI outbox, current tab's retained
command handle, registry marker, or hosted row to work around a refusal. The
browser creates an idempotency key internally but does not expose or persist a
caller-reusable identity, ciphertext, or receipt proof. For a marker-2 session
or device command, enqueue retains the established marker-2 response shape: it
returns the command and authority fields, but does not echo the idempotency key
or request digest. After validating that exact response, the browser derives
the acknowledgement tuple from the exact request fields it just submitted and
sends it to the separate mutation. Two requester-only, bounded hosted queries
list the same browser device's server-stored unacknowledged session and device
proof tuples; the unlocked app drains each family sequentially, so a lost
response, tab close, or reload recovers acknowledgement without another enqueue
and without a Web Storage or IndexedDB command outbox. The recovery read is
inert and cannot start retention by itself. A different active device sees none
of those requester rows and cannot acknowledge them.

Marker-absent device requests retain their historical atomic enqueue-time
acknowledgement while old and current browser writers coexist. Marker-absent
session commands never had that compatibility behavior. They remain
unacknowledged evidence until the exact requesting browser device loads the
current app, at which point the same requester-only list supplies their stored
proof. Refresh already-open browser writers after the hosted rollout and
monitor unacknowledged rows until they drain. Inspect browser and device
commands through the app or corresponding hosted query; do not treat a browser
retry as exact replay.

The browser deployment is global and may happen automatically when the release
commit reaches the Vercel branch; there is no per-target browser or CLI enable
switch. That early UI is not command-capacity readiness or effect authority.
Until the hosted singleton contains the exact activation tuple and a target has
published its current marker, fresh marker-2 enqueue and new provider-bound
transitions remain fail-closed. Do not declare the writers ready until both the
protected capacity evidence and its `.activated` readback receipt are accepted.
Actively monitor expected refusals from ungated or mismatched targets. Old
clients and old targets may continue their absent-to-absent protocol during
this additive rollout, but any admitted command or capacity-backed job crosses
the forward-only boundary described below.

1. Deploy the additive Convex schema, per-target enqueue gate, executor marker
   checks, exact `get`, session-command `getForOutboxRecovery`, both
   `listUnacknowledgedForRequester` queries, exact receipt acknowledgement,
   `failPrepared`, and requester-authenticated `enqueue` functions first. Both
   legacy and marker-2 enqueue responses retain their prior exact shapes; proof
   fields stay in hosted command custody and are never added as response echoes.
2. While the additive candidate remains live, run the protected command-capacity
   `status`/`repair` workflow above against that exact source, deployment receipt,
   runtime attestation, and numeric target. Accept only its protected two-zero-pass
   capacity evidence plus the exact `.activated` receipt produced after hosted
   activation and readback. The first file alone is not readiness. A hard-full
   legacy owner, partial capacity set, unreserved
   command debt, unsafe cleanup shape, interrupted intent, candidate swap, or
   concurrent debt blocks this step. An auto-deployed browser remains non-ready
   and non-effect-capable while this step is incomplete.
3. Upgrade daemons independently only after capacity evidence and activation
   receipts are accepted.
   After starting the current daemon on each
   intended target, run `oompa sync now --json` on that machine. Do not declare
   current hosted command availability until every
   intended target's result has `ok: true`, `data.online: true`,
   `data.errorCount: 0`, and
   `data.commandRequestVersion: 2`. A pending device identity or failed
   registry publication leaves the last field null. This forces an observable
   successful marker-2 registry publication cycle; a current daemon publishes
   marker 2 before it processes either command queue. A downgrade clears
   eligibility on the next successful old-shaped registry write.
4. Declare the global marker-emitting browser and CLI hosted command path ready only after
   the capacity activation receipt and intended-target proofs above. Refresh already-open
   browser tabs so their requester-only receipt recovery runs. If the release
   deliberately exposes an ungated target, record that exception and monitor
   its expected marker-mismatch refusals; the hosted gate rejects them before
   command insertion. A stale matching marker may admit during a transition,
   but the executor checks stop it before prepare or effect start.

   Artifact admission is separate: a reviewed release may complete its
   [machine-enforced publication gates](beta-release.md) before hosted runtime
   readiness. Publishing that artifact does not clear capacity, activation or
   intended-target requirements, and does not authorize a daemon upgrade.
5. Let current daemons automatically classify and reconcile pre-existing
   legacy journals, outboxes, and hosted rows through the recovery-only paths
   above. Observe the result with `oompa sync now --json`, retained local command
   IDs, and the hosted command queries. Ordinary reconciliation never needs a
   manual close. The exceptional hard-ceiling cases identified by the protected
   capacity status may use only its typed, source/runtime-bound retirement flow
   documented above; dashboard edits and raw Convex mutations remain forbidden.
   Only a command proved `failed` before effect may be
   attempted again, under a new idempotency key and a current client. Never
   retry an `ambiguous` command. No account-wide drain or all-daemons-current
   barrier is required before declaring the already-deployed global writer ready
   once protected capacity activation and the intended target gates are complete.

Retain the additive functions, internal target marker, stored requester fields,
and legacy and version 2 parsing until all local journals and outboxes are
reconciled and every related hosted row is terminal or expired, and until no
deployed current client can create or call those recovery surfaces.

Hosted rollback is unavailable once the additive capacity candidate admits any
command or capacity-backed deletion/revocation job, or creates or repairs any
command reservation. Waiting for a marker-2 client or daemon is not a rollback
boundary. Oompa has no global writer-freeze command or drain receipt, and a
retained browser tab or CLI can still enqueue a request even after a visible
writer deployment is replaced. Never redeploy a predecessor commit or reuse a
predecessor deployment receipt. Instead, prepare a reviewed forward repair that
reverses the unwanted behavior while retaining the additive schema fields,
registry marker, enqueue gate, `prepare` and `markEffectStarted` checks, exact
`get`, session-command `getForOutboxRecovery`, `failPrepared`, legacy and
version 2 parsers, and every maintenance and recovery endpoint. Deploy that
exact commit as the next candidate chained from the currently live receipt.
Disabling known writer surfaces may reduce inflow but is not proof of
quiescence. Remove compatibility only after a separately reviewed server-side
admission fence and drain receipt
exist, no deployed current client or daemon can call version 2 or recovery
surfaces, all local journals and outboxes are reconciled, and every related
hosted row is terminal or expired. Without all of that evidence, keep the
compatibility surface and repair forward.

Local binary downgrade is a separate and stricter decision. The current daemon
writes local journal schema 5 and may migrate other local custody state. Once
it has started against a state root, never launch an older daemon against that
root, even if every hosted row is terminal or expired. Retain the current
binary and recovery endpoints while it remains deployed, and then until its
local journals and outboxes are reconciled.

### Kinds

| Kind | Payload | Result |
| --- | --- | --- |
| `session_start` | `{accountPublicId, projectPublicId, prompt, preset, presetContract?, provider}`; `presetContract` is required for High or Ultra and absent for stable presets | `{sessionPublicId}` |
| `account_login_start` | `{accountPublicId,handoffVersion?:2}` | current: `{handoffVersion:2,loginUrl,userCode,expiresAt}`, single use; legacy results remain parser-only during rolling deployment |
| `account_login_status` | current: `{accountPublicId}`; legacy: none | `{status, instruction}` |
| `usage_refresh` | none | `{accountsRefreshed}` |

Addressing is by the cloud public ids the device registry already projects
(`DeviceRegistryPayload.accounts` and `.projects`). A filesystem path is
refused by the payload parser, so a project root can never reach the hosted
deployment. Current `account_login_status` requests name the projected account
whose Settings row exposed the action. The machine reports only that account's
state and uses its exact public id in any local finish or cancel instruction,
so a pending login on a sibling profile cannot change the row's answer. The
account-less machine-wide shape remains accepted for legacy browsers during a
rolling deployment. The requesting browser decrypts this reusable result under
the exact device-command-result authority and renders the machine's bounded
status and instruction. It does not replace the result with a generic
acknowledgement.

`session_start` runs as start-then-send under one idempotency key. The two
local effects use keys derived deterministically from the device command's own
public id, so a replay reaches the same two local mutations. Once the start has
committed, a failure in the send is settled `ambiguous` and carries no session
id: the honest instruction is to look at the grid, not to retry.

### Guards

Every guard is local. Nothing hosted and no browser can change one.

| Guard | Refusal code |
| --- | --- |
| Per-device kill switch (`oompa remote deny device-commands`) | `DEVICE_COMMANDS_DENIED` |
| Requesting device revoked after enqueue | `REQUESTING_DEVICE_INACTIVE` |
| Account linking without the local opt-in | `ACCOUNT_LINKING_DENIED` |
| Account login start while the account is not exactly signed out | `ACCOUNT_LOGIN_NOT_AVAILABLE` |
| Account not in the projected registry | `DEVICE_COMMAND_ACCOUNT_UNKNOWN` |
| Account signed out on the machine | `DEVICE_COMMAND_ACCOUNT_SIGNED_OUT` |
| Provider does not match the projected account, or browser linking targets non-Codex | `DEVICE_COMMAND_PROVIDER_UNSUPPORTED` |
| Project not in the projected registry | `DEVICE_COMMAND_PROJECT_UNKNOWN` |
| Per-device daily cap (100 admitted commands) | `DEVICE_COMMAND_DAILY_CAP` |
| Incomplete or non-relayable login handoff | `ACCOUNT_LOGIN_RELAY_UNAVAILABLE` |

The cap is checked last, so a refused or malformed request never consumes the
day's budget. A browser device can never be a device command target
(`DEVICE_COMMAND_TARGET_NOT_EXECUTOR`) and can never execute the lifecycle
(`BROWSER_DEVICE_CANNOT_EXECUTE`).

Two further guards are not refusals. The first `session_start` from each device
raises a local notice on the machine, written once and never repeated for that
device; Oompa has no desktop notification facility today, so the default notice
is a daemon diagnostic and the CLI injects a real notifier when one exists. And
a browser-started session inherits its project's approval mode, applied before
the prompt is sent, so the first turn is already governed by it.

For Codex, a current browser sends `account_login_start` with
`handoffVersion: 2`, which dispatches the local `account.login` command in
device-code mode. The current web lane never requests browser mode. A
browser-mode loopback callback cannot be completed on another device, so Oompa
does not relay it.

The pending Codex response must carry both the verification URL and its
separate one-time user code. The URL must be exactly
`https://auth.openai.com/codex/device`, the value emitted by the pinned Codex
app-server. Query strings, fragments, alternate paths, ports, credentials, and
lookalike hosts fail closed. The user code must match the closed device-code
grammar. A missing or malformed value fails closed with
`ACCOUNT_LOGIN_RELAY_UNAVAILABLE`.

Oompa encrypts the URL and user code together under the account key in one
result. The hosted deployment stores only that ciphertext. The result expires
five minutes after hosted settlement and `deviceCommands:consumeResult`
releases it only to the requesting browser, exactly once, while erasing the
ciphertext in the same transaction. Convex returns that server-owned deadline
with the release, so machine or browser clock skew cannot extend the readable
window. Settings displays the code before the link for manual selection; it
does not offer a clipboard control or programmatically write the clipboard. It
keeps both account-row actions locked
while a login-start handoff is outstanding. The exact row unlocks only after
this tab consumes the single-use result, hosted expiry makes it unavailable, or
the command terminalizes without a handoff; a later start or status check cannot
supersede it. Once safely consumed and displayed, the code remains in memory
until its expiry or until the user starts a later action.

Both local gates still apply: device commands must be enabled and the machine
must have `oompa remote allow account-linking` set. Settings offers the flow only
for an account in that machine's encrypted registry after the registry reports
the opt-in. The daemon rechecks the requesting device, account public id, local
switches, and daily cap before starting the provider effect.

The request version makes mixed rollout fail before the wrong provider effect.
A current browser sends `handoffVersion: 2`; an older daemon rejects that
unknown shape before login starts. A current daemon refuses an unversioned
request with `ACCOUNT_LOGIN_RELAY_UNAVAILABLE` before starting any local login.
Current result parsing retains the legacy URL-only shape solely so a result
already produced by an older daemon can be consumed once and turned into a
machine-update instruction. This behavior is covered by focused parser,
adapter, bridge, and UI tests. It has not yet been accepted against production
or in a live two-device Codex login.

### Operator switches

```sh
oompa remote policy                      # what this machine currently allows
oompa remote deny device-commands        # stop accepting commands from other devices
oompa remote allow device-commands       # accept them again (the shipped default)
oompa remote allow account-linking       # permit relaying a provider login
oompa remote deny account-linking        # refuse it again (the shipped default)
```

Both switches are stored in `daemon_state` on the machine and published into
that machine's encrypted device registry, so the web settings screen shows the
current state and offers the CLI instruction rather than a button the daemon
would refuse. Device commands are allowed by default because a browser device
is already an enrolled key holder; account linking is denied by default because
relaying a login handoff is the one command that hands a provider authorization
path to another surface.

### Retention and erasure

`deviceCommands` is classified exactly like `sessionCommands`: quota category
`command`, retention class `command_recovery`, deletion order 10. A pending row
past its deadline is expired by the `pending_device_commands` maintenance
category. An ordinary requester-retained terminal row becomes eligible for
`terminal_device_commands` only after the exact requesting device acknowledges
its hosted proof, then remains for the same 30-day retention. Explicit
requester-revocation abandonment starts that clock without stamping a false
acknowledgement. A pre-rollout row whose requester was already revoked uses the
non-growing dual command/revocation-age rule, and a typed operator-abandoned
legacy effect uses its separate 30-day clock plus exact terminal security
evidence. A marker-2 browser recovers its ordinary proof from the
requester-only hosted list after a lost response; a marker-absent device
command keeps the mixed-rollout enqueue-time acknowledgement described above.
Account deletion
erases the table with the other command state, and device revocation cancels
pending rows the revoked device owns while quarantining any that had already
started.
