# Current Oompa canonical alias release

Oompa v0 status: retired on 2026-08-27. This procedure is current-project-only.

This runbook can reassign the single Vercel alias record `oompa.app` between two exact deployments of the current Oompa Vercel project. It does not add, change, or remove DNS, move project-domain ownership, deploy source, configure Convex, create a tag, publish a release, or operate another alias.

## Authorization boundary

The user's standing authorization for task-owned Hraness delivery includes this exact current-project alias transition when it is a documented release or deployment step already inside the task's scope. Do not ask for a second conversational confirmation. If the task did not authorize production delivery, the target represents a material product decision not already made, required credentials are missing, or the requested effect extends to DNS, project-domain ownership, another alias, or a retired resource, stop and obtain the missing authority instead of treating this runbook as permission.

The fresh plan and passing preflight narrow existing task authority; they do not create broader authority. The designated custodian passes the exact `requiredConfirmation` value emitted by preflight to `--confirm-exact`. The command accepts that internal machine token only when it is byte-for-byte equal to the record and UUID derived from the protected plan. The authorized transition includes automatic restoration of `oompa.app` to the plan's exact current-project source deployment if an acknowledged target cannot be proved. It does not authorize Oompa v0, another alias, DNS, or project-domain ownership.

Execution has exactly one designated writer custodian: one supported Darwin or Linux host and one persistent operating-system account holding the reviewed file-backed Vercel session, protected Convex session, and durable state directory. The local lock cannot fence another host or account, and the alias API has no expected-source compare-and-swap. Do not run this operator or another alias writer from a second host or account while a plan or recovery is live. Other devices may inspect evidence, but they may not dispatch provider writes.

## Fixed identities and denylist

The only accepted authorities are:

- GitHub repository `hraness/oompa`, numeric ID `1343008607`;
- Vercel team `hraness`, stable ID `team_UAd1iD2XogJlbFg4h14mRaPM`;
- Vercel project ID `prj_8ciIt9t9foE3utG45frRN7cxckjS`;
- Convex team ID `513923`, project ID `2854545`, and the exact default production deployment named in the plan; and
- canonical alias `oompa.app`.

The following retired Oompa v0 identities remain one-way safety tombstones:

- GitHub repository ID `1334876494`, retained only as archived `hraness/hra-v0` history;
- Vercel project ID `prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr`;
- Convex project ID `2680173`; and
- Convex production deployment ID `4677913`.

The new plan schema accepts only the current numeric identities, so none of those retired resources can become a target, source, fallback, staging surface, or recovery authority. The historical implementation in `scripts/domain-cutover.ts` remains non-operational design evidence: its executable and public operator entry points return `operator_retired`, and it has no built-in provider runner. Historical tests can exercise its parser and state machine only by supplying their own explicit effect capability. Do not invoke or import it for provider work.

A normal source and every target must be an exact Vercel `source: "git"` GitHub deployment of repository ID `1343008607`, ref `main`, and the plan commit. Contradictory hybrid source metadata is rejected. One narrow source-only compatibility form exists for the current public alias when that alias still names a pre-integration Vercel CLI deployment. The plan must opt into `vercel.sourceProvenance` with the exact closed values `kind: "vercel-cli-public-marker"`, `actor: "cursor-cli"`, `gitCommitRef: "HEAD"`, and `gitRootDirectory: ""`. This does not admit a CLI target. It binds the source to the exact deployment ID, hostname, plan commit, Vercel `source: "cli"`, null `gitSource`, matching deployment metadata, the strict public marker, and an alias read-marker-read sandwich. A plan without that object retains the GitHub-only source contract.

## Retired receipt-less record compatibility

The one terminal receipt emitted by the short-lived receipt-less reconciliation implementation belongs to the `hra.sh` alias era. This operator now binds `oompa.app`; the earlier `oompa.dev` plan and `hra.sh` records are historical and no longer readable through it; an intent whose receipt does not match the current receipt schema fails closed with `durable_state_invalid` and exit `75`, and the files stay untouched on disk.

## Fresh plan for each release

Do not use a checked or previously preflighted plan for a later deployment. After the reviewed operator is on `main` and its exact production deployment is ready, prepare a private schema-version-1 plan at `<absolute-path-to-fresh-plan>`. Keep that file outside the repository as a single-link mode-`0600` regular file owned by the designated operating-system account. It must bind:

- the exact source deployment ID, automatic hostname, commit, and explicit source-only CLI provenance object when the current alias requires that compatibility form;
- one different `READY` GitHub `main` target deployment, automatic hostname, and source commit from repository ID `1343008607`;
- current Convex production deployment ID `5089017`, generated name `qualified-hummingbird-537`, and URL `https://qualified-hummingbird-537.convex.cloud`; and
- a newly generated lowercase canonical UUIDv4 idempotency key.

The alias operator never changes Convex; exact live default-production readback is a release-authority prerequisite. The fresh UUID is part of `requiredConfirmation`, so an old machine token cannot authorize a new plan. Never edit a plan or reuse its key after preflight. Discard it, prepare a replacement, and preflight that replacement before execution.

## Provider readback contract

Use Bun 1.3.14. Both the executable entry point and the explicit-capability test boundary reject any other Bun version before argument recovery, provider reads, or durable alias state mutation. The canonical `--vercel-auth-file` and retained `--vercel-auth-fd` paths support Darwin and Linux by making bounded HTTPS requests directly to fixed paths at `https://api.vercel.com`, with the stable Vercel team ID in every request. They reject redirects, non-JSON responses, oversized bodies, and responses outside the strict endpoint schemas. Neither path starts a Vercel subprocess or performs Vercel CLI discovery. A separate explicit `--vercel-cli` compatibility path remains available only on Linux under the repository's PID-namespace authority supervisor. Do not use that legacy path for this Darwin-capable procedure. Any credential-bearing provider subprocess remains authority work with no process-group fallback.

Select one reviewed file-backed Vercel session for the designated operating-system account and name its exact absolute path with `--vercel-auth-file`. The operator opens that file itself after scheduler admission. It requires a current-user-owned, single-link, mode-`0600` regular file, refuses symlinks and special files, and uses a nonblocking no-follow open. It compares the path and held descriptor identities around two bounded matching reads and rejects any Darwin extended ACL. Credential files are limited to 8 KiB; plan and recovery-evidence files are limited to 32 KiB. File paths must be absolute, normalized, control-free and at most 4,096 characters. Each input accepts either its file flag or its descriptor flag, never both; file paths must be distinct.

The operator recognizes only the bounded session token and optional expiry, clears read buffers and closes its credential descriptor before bounded-process journal recovery or any provider call. It sends the token in the Vercel authorization header and never writes it to output, logs, argv, the plan, intent, or receipt. An expiring token must have at least 15 minutes remaining at the start of each preflight or execution invocation; a shorter, malformed, or expired session is refused before recovery or provider work. The operator does not refresh the token or discover one from an environment variable, inherited `HOME`, default CLI configuration path, Keychain, or another ambient account source. Review the exact file, keep the same file and operating-system account through preflight and execution, and never pass the token itself as a command-line value.

Existing `--vercel-auth-fd`, `--plan-fd` and `--recovery-evidence-fd` inputs remain available to callers that already preserve and review those descriptors. File inputs do not reuse their descriptor numbers. In particular, the host scheduler uses descriptor 3 and, on capability lanes, descriptor 4 for its leases; it does not forward arbitrary caller input descriptors. Use file inputs with a direct Bun child; do not overwrite lease descriptors or add a shell or package-script wrapper to carry private inputs.

Preflight and execution read the following state from the providers instead of trusting names or a prior observation:

1. Convex management API readback must prove the plan's exact numeric team, project, production deployment ID, generated name, canonical URL, `isDefault: true`, and matching project `prodDeploymentName`. The protected Convex CLI config path is derived from the operating-system account record rather than inherited `HOME`; its held file must be current-user-owned, single-link, regular, mode `0600`, stable across the bounded read, and free of any Darwin extended ACL.
2. Vercel project readback from `/v9/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS` must return the exact project and team IDs and `autoAssignCustomDomains: false`.
3. Vercel deployment readback from `/v13/deployments/<deployment-id>` must prove each exact deployment ID, automatic hostname, current project ID, and `READY` production state. The target always proves Vercel `source: "git"`, GitHub repository ID `1343008607`, `main` ref, and the plan commit. The source proves the same GitHub tuple unless the plan explicitly carries the closed CLI source provenance object; only then must it instead prove Vercel `source: "cli"`, exact actor `cursor-cli`, exact ref `HEAD`, empty root directory, and `meta.gitCommitSha` equal to the source commit in the plan. Vercel's live CLI-deployment shape omits `gitSource`; the parser normalizes only that omission or an explicit JSON `null` to the internal null value and still rejects every non-null lookalike.
4. Authenticated alias readback from `/v4/aliases/oompa.app` must return one exact `(alias, projectId, deploymentId, deployment.id, deployment.url)` tuple matching the plan source or target. When the source uses the narrow CLI form, the same exact source tuple must still hold after the public marker read.
5. Public `https://oompa.app/.well-known/hra.json` readback must be strict schema version 2, generation 1, product `Oompa`, repository ID `1343008607`, path `hraness/oompa`, version `0.1.0`, and the commit belonging to that exact alias tuple.

The protected automatic target hostname is not treated as public product evidence. Before mutation, the exact `READY` GitHub `main` deployment record is the target provider evidence. A CLI deployment can never satisfy target authority. After mutation, the public marker must bind `oompa.app` to the target commit; failure to prove that marker invokes recovery.

Provider output is parsed from `unknown`, bounded, and reduced to closed result fields. An accepted mutation response must contain the documented `uid`, `created`, and exact `alias: "oompa.app"` fields. The initial target response must also report `oldDeploymentId` equal to the plan source; an automatic source-restoration response must report it equal to the plan target. Missing, null, or unplanned prior authority fails closed. Do not use `--debug`, `--verbose`, `--token`, `--force`, remove-then-add, the friendly `vercel alias set` command, a DNS command, a certificate command, or a domain-move endpoint.

## Read-only preflight

Run preflight as the designated Darwin or Linux writer custodian from a clean checkout containing the reviewed operator. Name the reviewed Vercel session and fresh private plan explicitly. When the host scheduler is installed, resolve its absolute command path and invoke it directly with the complete Bun child arguments, using shared mode and the applicable capability lane. Do not invoke the scheduler through a shell wrapper.

```sh
bun ./scripts/current-project-alias-release.ts preflight \
  --vercel-auth-file /absolute/path/to/reviewed-vercel-auth.json \
  --plan-file /absolute/path/to/fresh-oompa-sh-plan.json
```

Preflight performs no provider write. Its result uses `schemaVersion: 3`; version 3 replaces the retired conversational-approval action while retaining `requiredConfirmation` as the exact machine token. It first takes the designated custodian's same machine-local lock and inspects the protected ledger. A receipt-less current intent returns `unresolved_current_intent`, and a different receipt-less intent returns `unresolved_prior_intent`, before provider readback; neither can be reclassified as already committed. Exact source authority with no terminal record returns `status: "ready"`, `nextAction: "execute_with_machine_token_under_standing_task_authority"`, and `requiredConfirmation`. Exact target authority returns `status: "already_committed"` only when no intent exists or a valid target receipt agrees. An unplanned alias, marker mismatch, provider mismatch, unreadable response, unsafe project setting, wrong Convex default, terminal receipt mismatch, or retired identity blocks or refuses.

A preflight is a point-in-time observation, not a provider lock. Execution repeats every read before mutation. Record the complete exact plan, including its UUID, in the task evidence and retain the emitted `requiredConfirmation` as an internal machine token. No person needs to see, copy, reproduce, or separately approve that token when standing task authority already covers the transition.

## Checked execution

After a ready preflight under applicable standing task authority, the designated custodian must pass that invocation's exact `requiredConfirmation` value internally as one quoted argument:

```sh
bun ./scripts/current-project-alias-release.ts --execute \
  --vercel-auth-file /absolute/path/to/reviewed-vercel-auth.json \
  --plan-file /absolute/path/to/fresh-oompa-sh-plan.json \
  --confirm-exact '<exact requiredConfirmation from the immediately preceding preflight>'
```

The only provider mutation form constructed by the operator is the documented direct `POST /v2/deployments/<exact-deployment-id>/aliases` request with the JSON field `alias: "oompa.app"`, scoped to stable Vercel team ID `team_UAd1iD2XogJlbFg4h14mRaPM`. The deployment ID is either the exact plan target or, only after a protected target phase and durable source-recovery intent, the exact plan source. The bounded in-process transport never invokes the friendly `vercel alias set` command because that command can perform implicit domain and certificate setup beyond the one alias record. Each request carries its distinct plan- and effect-derived mutation key in an `Idempotency-Key` correlation header. The alias endpoint does not document deduplication for that header, so recovery safety does not assume provider-side idempotency. An uncertain target request is never redispatched and is never followed by an opposing source write; it becomes a durable hard stop. The request does not detach the alias first and cannot select another alias or project. After an acknowledged target response with exact prior-source provenance, one 60-second retry-admission deadline governs every attempt to obtain the complete target proof. The operator starts no new fast or complete sample after that deadline. A provider read already in progress completes or fails under its own stricter bounded transport or process timeout. Every exact sample requires the authenticated alias tuple and public marker to match before the operator rechecks the Vercel project, both deployments, current Convex default production, alias, and marker. Two consecutive complete samples must agree before the operator returns `status: "committed"`. A transient unplanned alias, marker mismatch, or closed provider-read failure resets the consecutive count and is retried within the same admission deadline. The operator never turns a mismatch into authority and never restarts the deadline between the fast tuple-marker check and full readback.

Execution derives a fixed `<system-account-home>/.local/state/oompa/canonical-alias-release` directory from the operating system account record, not from an inherited `HOME`. It requires a protected mode-`0700` directory and mode-`0600`, single-link regular state files. One inode-checked machine-local advisory lock serializes every plan for that designated host and account. It is not a distributed provider lock. While holding it, the operator scans the bounded directory and refuses a new plan behind any older unresolved intent. The 8,193 persistent-entry bound reserves the lock plus as many as four records for each of 2,048 terminal plans: `<uuid>.intent.json`, `<uuid>.target-phase.json`, the optional `<uuid>.source-recovery.json`, and `<uuid>.receipt.json`. Admission reserves the complete four-record plan capacity, so it cannot strand a later phase, recovery intent, or receipt. Scan startup permits only one transient 8,194th hardlink so it can finish a proved publication interrupted after its destination link was created, then requires the recovered directory to be back within the persistent bound.

For an exact source state, the operator completes one full provider read, including the second alias comparison required by an explicitly planned CLI source, durably publishes and rereads a self-digested intent, repeats the full provider read, and only then dispatches the target assignment. The intent binds the exact plan, optional source-only provenance, confirmation, observed source and intended target authorities, and distinct plan-bound mutation keys for target assignment and source restoration. A mutation is never dispatched after the lock identity is lost. Immediately after validating that the target response names the exact planned source as `oldDeploymentId`, the operator durably publishes and rereads a self-digested target phase record. That phase record binds the intent, plan, exact source and target, target mutation key, and accepted response evidence before target proof or source restoration can begin. Failure to prove the phase record durable is recovery-required and permits no opposing write. A completed stable target proof publishes and rereads a terminal target receipt that binds the target phase before success is printed.

Before any automatic or explicit source restoration, the operator durably publishes and rereads a self-digested source-recovery intent. That record binds the original intent, target phase, exact source and target, source mutation key, and the closed recovery reason. The operator then dispatches at most one source assignment. A proved restoration publishes and rereads a terminal source receipt that binds both the target phase and source-recovery intent before the non-success `alias_reverted` result is printed. The receipt also records the last closed target proof phase and reason without provider output, credentials, response bodies, or other unbounded data. Receipts written before these additional bindings were introduced remain valid and replayable only under their original closed schema; they do not authorize phase recovery.

An exact target state with no durable intent is safe to classify read-only with the same plan and exact machine token. A valid terminal target receipt is also replayed read-only. A lost or invalid target-command response is not reconciled into a commit from readback because the provider does not document request deduplication or delayed-effect cancellation. It returns `target_result_ambiguous` or a closed provider-readback failure with exit `75`. If an intent exists without any terminal receipt, ordinary preflight and `--execute` perform no mutation and return `unresolved_current_intent` or `unresolved_prior_intent`. They never infer target success, repeat target, or oppose a possibly delayed target with source. Only the explicit `recover-source` operation described below may cross that boundary, and only after it proves a protected target phase for the exact original intent.

## Recovery design

The plan's current-project source deployment is the only automatic recovery target. Oompa v0 is never a fallback.

After an acknowledged target response whose `oldDeploymentId` proves the exact plan source and whose target phase is durable, failure to obtain two consecutive complete target-authority samples within the shared target deadline publishes the source-recovery intent and reasserts only the plan's exact source automatic hostname on `oompa.app`. It then requires the source response to prove `oldDeploymentId` was the exact target and uses a fresh bounded recovery deadline to obtain two consecutive complete source-authority samples, including the exact source alias tuple, source commit-bearing marker, Vercel project, both current-project deployments, and current Convex production target. Proven restoration records the target-phase-bound and recovery-intent-bound terminal source receipt, then returns `status: "reverted"` with nonzero exit; it never reports a release commit. An ambiguous target response performs no automatic restoration because the delayed target effect cannot be ordered safely against an opposing source write.

`recover-source` is the only explicit recovery mutation. Run it with the unchanged protected plan and the exact original machine confirmation:

```sh
bun ./scripts/current-project-alias-release.ts recover-source \
  --plan-file /absolute/path/to/unchanged-oompa-sh-plan.json \
  --vercel-auth-file /absolute/path/to/reviewed-vercel-auth.json \
  --confirm-exact '<exact requiredConfirmation from the original ready preflight>'
```

The recovery operation never dispatches the target assignment. Before writing, it revalidates the current project, both deployments, current Convex production target, and exact authenticated target alias tuple. The only admitted target-authority defect is `marker_mismatch`, and that mismatch is narrower than an arbitrary invalid marker: every marker field and the target commit must be exact except `version`, which must be noncurrent and stable across two complete observations. If the complete target authority including its current marker version is already exact, recovery refuses rather than undoing a proved release. It accepts only a protected target phase tied to the original intent and exact confirmation. For a normal current record, that phase comes from the previously accepted target response. A legacy receipt-less intent may instead use a separately reviewed compound phase attestation. The operator accepts only the single historical operator commit, source-blob OID, entrypoint SHA-256, and Bun version tuple explicitly allowlisted in the reviewed implementation; arbitrary syntactically valid provenance is refused before provider access. It then dynamically revalidates the exact protected intent, the provider `aliases-assigned` Activity event set, the authenticated alias record, and the exact target and source deployment alias lists. The Activity query uses the live-proven team-scoped `since` surface because provider-side `projectIds` and `until` filters excluded this manual event; it accepts uniqueness only while the complete returned page contains fewer than the 100-record limit and otherwise fails closed without mutation. Uninterrupted sole-writer custody is an explicit externally reviewed assumption carried in the protected, self-digested evidence; no machine-local lock can dynamically prove the absence of a writer on another host or account. That compound evidence establishes the exact target effect under the recorded intent; it is not represented as an `oldDeploymentId` response and does not weaken the response requirement for new executions. Missing, stale, ambiguous, or conflicting evidence is a nonmutating hard stop.

Only legacy compound attestation takes an additional evidence input. Use direct REST authentication and name the separately reviewed file with `--recovery-evidence-file`. It must satisfy the same current-user-owned, single-link, mode-`0600` regular-file and stable-read protections as the other inputs. Keep its exact provider, operator, and custody identifiers outside the repository and out of terminal output. The legacy Vercel CLI compatibility transport cannot attest provider Activity.

```sh
bun ./scripts/current-project-alias-release.ts recover-source \
  --plan-file /absolute/path/to/unchanged-oompa-sh-plan.json \
  --vercel-auth-file /absolute/path/to/reviewed-vercel-auth.json \
  --recovery-evidence-file /absolute/path/to/reviewed-compound-phase-evidence.json \
  --confirm-exact '<exact requiredConfirmation from the original ready preflight>'
```

After the protected phase is proved, recovery publishes and rereads the source-recovery intent before making one exact source assignment. Its accepted response must prove `oldDeploymentId` equals the plan target. Two consecutive full source-authority samples must then pass before the bound terminal source receipt is published. The first proven completion returns `status: "recovered_source"`; a later invocation may replay that exact terminal source receipt without mutation. A legacy source receipt without both phase-digest bindings remains `alias_reverted` and is never relabeled as an explicit recovery. Any ambiguous source result or incomplete proof remains recovery-required. Recovery cannot create a target receipt, turn target readback into a successful release, select another source, edit the original records, or authorize a new forward transition.

If source restoration or readback cannot be proved, the operator returns exit `75` with `status: "recovery_required"` and `code: "compensation_failed"`. A target-response ambiguity returns `target_result_ambiguous`. A direct-transport failure or legacy subprocess-custody failure after intent publication also returns exit `75` with its exact recovery paths. Every failure after an intent may have been published is recovery-required, including a failed second authority read and `intent_write_failed`. Resolve the relevant file-backed session, transport, or process custody before provider reconciliation.

Durable recovery codes are closed instructions:

- `alias_reverted` means the acknowledged target could not obtain two consecutive complete authority samples within its one deadline and the exact source was restored and re-proved. Preserve the terminal source receipt and its closed `rollbackDiagnostic`. The plan is terminal and must not be retried; diagnose the recorded phase and reason, then use a fresh reviewed and preflighted plan under applicable task authority only after the cause is resolved.
- `receipt_write_failed` means provider authority may already be exact target or restored source, but its terminal receipt was not proved durable. Preserve every state file. Ordinary preflight and `--execute` return `unresolved_current_intent` on the unchanged plan without a write. Use `recover-source` only when the protected target phase and all recovery prerequisites are present.
- `target_result_ambiguous` means the target request returned no accepted provider response. A later exact target readback cannot prove the request's prior authority or that no delayed effect remains. Preserve the intent and perform no opposing write.
- `target_phase_write_failed` means an accepted target response could not be bound into its protected phase record. The target effect may exist, but no source restoration is permitted. Preserve every record and stop.
- `source_recovery_write_failed` means the protected source-recovery intent could not be published and reread. The operator dispatches no source assignment after this failure. Preserve every record and stop.
- `recovery_evidence_invalid` means the supplied legacy compound evidence or its fresh provider readback did not match the closed attestation. No source assignment is permitted.
- `recovery_not_permitted` means live authority is not the exact recoverable target state, including when the target marker is already current. No source assignment is permitted.
- `unresolved_source_recovery` means a durable source-recovery intent exists without a terminal receipt. The source effect may have occurred or may still be delayed, so the operator performs no replay or opposing write.
- `unresolved_current_intent` is a hard stop for ordinary preflight and execution of the named plan. It is not authorized by editing or deleting the intent, reusing another UUID, or issuing a manual alias command. The explicit source-only recovery path is available only with the original exact confirmation and a protected, dynamically revalidated phase attestation.
- `receipt_authority_mismatch` means a terminal receipt and current provider authority disagree. Stop and investigate without another write.
- `durable_state_invalid` means the fixed directory, lock, intent, receipt, identity, digest, or bounded directory contents failed validation. Do not delete, rename, or edit the evidence to make the check pass.
- `durable_state_capacity_exhausted` is a designed stop after the ledger has reserved its lock plus as many as four records for each of 2,048 terminal plans. Do not remove history by hand. No new provider read or write is permitted until a reviewed operator revision adds a self-digested checkpoint or increases the bound while retaining every prior UUID and plan digest.
- `unresolved_prior_intent` means a different older plan has an intent without a terminal receipt. The error identifies that older UUID plus its exact intent and expected receipt paths. Stop behind that hard boundary. Do not start the new plan and do not delete or edit the older evidence.

For any exit `75`, stop release work, retain the unchanged plan and exact machine token, and preserve the fixed state directory. Re-running ordinary preflight or `--execute` may repeat readback, but a receipt-less intent remains a nonmutating hard stop for those operations. Use `recover-source` only after its protected phase prerequisite is established. Do not copy the intent to a second custodian, start a competing writer, or try a different UUID. Do not improvise a DNS change, domain move, deployment, detached alias command, Oompa v0 route, new plan, or manual recovery while authority is uncertain.

A completed source recovery is terminal for the original plan. Diagnose and resolve the recorded failure, wait for the reviewed operator and its exact production deployment to be ready, then prepare and preflight a fresh source-to-target plan. Earlier machine tokens and recovery evidence never carry into the fresh plan; standing task authority may continue to cover it only when the target and delivery outcome remain in the same authorized scope.

## Independent production verification

Preserve the configured response headers as well as the body bytes. The site uses explicit slash-normalization redirects instead of Vercel's automatic `trailingSlash` transform, which can place a terminal `/.well-known` route before custom headers. The example header pattern must include the empty trailing segment in `/examples/app/`, not only descendant assets. The pinned route-compiler regression tests cover this ordering and matching behavior; they do not replace live response-header verification. Record the final URL after clean-URL redirects when checking the example document.

After a committed result, independently repeat the filtered Vercel alias and deployment readbacks and fetch the public marker and release acceptance pages. Those observations do not expand the original authorization and must not perform another write.

If comparing public content with local generated files, use a clean checkout of the plan's exact target commit with the pinned dependencies. First check the tracked public sources, then render fresh output:

```sh
bun run build:site -- --check
bun run build:site
```

The `--check` command validates the tracked privacy output; it returns before rendering `dist/site`. The package README is independently authored and checked by package admission, not generated by the website. A passing site check does not prove existing generated site files belong to the current checkout. The normal build regenerates those files. Confirm the tracked checkout remains clean afterward.

A plain local build uses a `local` release marker unless an explicit build environment supplies the commit. Prove the public marker against the exact target commit and fixed marker contract above, not against that default local marker. Record the exact routes, content fragments and assets compared; matching selected page fragments does not prove whole-page or environment-specific analytics byte parity. Reload the real browser page before checking navigation, narrow layouts and sticky-header boundaries.

The mailing footer renders the same signup form on every navigable page without a client challenge script; no environment now gates a third-party script. Validate exactly the markup emitted by the pinned `@hraness/site-footer`, with one occurrence on each navigable page and none on `/preview/`; do not exempt arbitrary third-party scripts. Preserve exact owned stylesheet and script references. The homepage and six documentation pages load `/site.js`; `/privacy/` uses `/appearance.js` without `/site.js`, and `/preview/` remains inert.

If content comparison fails after a committed transition, retain the provider readbacks and terminal receipt and first verify the local commit and fresh render. A stale local build is not authority to replay a terminal plan, edit the ledger or issue another alias write. Diagnose any remaining product mismatch under the same release and recovery boundaries.
