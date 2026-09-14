---
title: Hosted memory quota authority upgrade
description: Preserve predecessor quota accounting while adding proven-empty memory and live-tail authority through a bounded explicit migration.
type: plan
status: complete
area: oompa
tags: [convex, memory, quota, migration]
relations:
  related-to: [plans/oh-memory-civilization, plans/oompa-v1]
---

# Hosted memory quota authority upgrade

## Completed quota upgrade

[PR 207](https://github.com/hraness/oompa/pull/207) merged as
`899bfb6fe6e1235643d88239033140e833d74ea9` and the protected forward candidate
was deployed. The schema-3 operator completed the explicit additive repair of
three ledgers: `upgraded: 2` and `upgradedLiveTail: 1`. Two complete clean audits
verified all four ledgers as current, and the protected completion receipt was
published. Existing accounting and content were preserved.

Before repair, the v0.8.2 candidate at
`db5e4ba69e657ab179bbebffef1d13b4d0aa13ac` had reported two `legacy`, one
`current` and one `corrupt` ledger. Its diagnostic identified exactly one
unmarked eleven-category, five-resource ledger missing `memory`, `live_chunk`
and `memory_space`. Historical source confirmed that this shape predated
`live_chunk`, while detail chunks already existed. The reviewed schema-3 policy
therefore required bounded owner-index absence proofs before adding zero rows.

The focused operator suite passed 32 tests, including count conservation,
schema-1/schema-2 refusal, live-tail replay and lost-response reconciliation.
Quota, schema and live-tail suites passed 95 tests. Strict TypeScript, scoped
ESLint, baseline adoption and all 33 release-workflow equivalence tests passed.
Independent full-change and impact review passed, including caller isolation,
unchanged current ledger contracts and additive index deployment. Required
integration checks passed before merge.

Quota upgrade completion does not activate hosted command writers. The later
capacity diagnostic validated all four ledgers and found three identities ready
and one missing capacity, with an identity-record ceiling blocker. The separate
[authority-reduction plan](authority-reduction-headroom.md) tracks that repair
and its own protected zero-debt activation gates. No daily-driver qualification
is inferred from this quota receipt.

## Earlier memory-upgrade evidence

A live source-bound diagnostic reported one `schema_shape` failure. The existing
reason cannot distinguish a partially added memory ledger, lost marked memory
rows, or a missing older counter. A read-only shape histogram now projects the
marker, fixed ordered missing categories/resources, and absent/zero/nonzero
retained memory counters at that exact classifier failure. The operator rejects
noncanonical, duplicate, inconsistent or impossible groups and binds their total
to the shape-failure count. No second database read changes the observation.

Focused conservation and parser tests pass (44 tests, 4,647 assertions), as do
strict TypeScript, scoped lint and independent source review. That is the earlier
schema-1 diagnostic evidence; it did not qualify the later schema-2 repair.
The observed `schema_shape` reason alone does not establish repair eligibility.
Diagnosis grants no repair or activation authority.

The v0.8.2 source includes schema-2 empty-memory completion. The
classifier checks the two owner indexes before counting a ledger as
`incompleteEmptyMemory`; the earlier histogram did not perform that check.
Initial focused tests pass across quota, memory sync, upgrade and operator
contracts (110 tests, 6,469 assertions). The final upgrade/operator checks pass
53 tests with 6,357 assertions after adding partial-page lost-response recovery
and an audit-to-mutation data-change refusal. Focused TypeScript, scoped lint
and baseline adoption pass. Independent source review passes the complete
change. Independent caller review confirms that publication and deployment do
not invoke the repair: it has no product, startup, cron or deployment hook.
That source passed admission independently of live diagnosis and repair. No
hosted data was read or modified during its source preparation; the later live
readback is recorded above.

The memory schema adds a quota category and a user resource. Existing identities
with the complete predecessor ledger have eleven categories and six resources;
ordinary current quota mutations require twelve and seven. A credential-free
predecessor fixture reproduces `QUOTA_AUTHORITY_CORRUPT`. Adding exactly the two
new zero rows is a passing positive control. This upgrade defect is separate from
the existing authority-reduction hard-quota hold.

## Preserved predecessor transition

Ordinary mutations retain their strict authority checks. An explicit migration
validates one complete ledger shape and inserts only uncharged quota authority
metadata. It never reconstructs counters from missing rows or changes a quota.

- An unmarked exact predecessor ledger with no owner memory space or operation
  may receive a zero `memory` category and a zero `memory_space` resource.
- A complete unmarked current ledger may receive its version marker. Existing
  current memory usage is preserved.
- The version marker is `quotaSchemaVersion: 2` on the identity-category quota
  row only. Fresh identity initialization writes it. Every prior field, ID,
  counter and timestamp remains unchanged during migration.
- A complete marked current ledger is an idempotent no-op. Unknown or misplaced
  markers, duplicate rows, invalid counters and inconsistent quota authority
  refuse. Missing older rows require the exact live-tail classification below;
  partial or marked memory-only gaps require their separate classification.
  Neither broadens the original six-resource `legacy` disposition.
- Legacy zero usage requires both owner indexes to be empty, including orphan
  memory operations. Another owner's data does not block this migration.

Audit and repair share the same bounded classifier. It validates category and
resource uniqueness, configured limits, canonical byte/record pairs, safe totals
and service totals no smaller than the owner totals. This preserves existing
validated accounting; it is not a full recount of all historical documents.

## Empty-memory completion

The `incomplete_empty_memory` disposition accepts exactly five additional forms:
an unmarked ledger missing either memory row, or a current-marked ledger missing
the category, resource, or both. Every fixed predecessor row must exist exactly
once and pass the existing authority, timestamp, counter, ceiling and total
checks. All retained memory counters must be zero. Both `memorySpaces` and
`memoryOperations` must be empty through their owner indexes in the same query
or mutation transaction; an orphan operation refuses completion. Another
owner's records do not establish or prevent this owner's eligibility.

The mutation inserts only absent zero authority rows. It preserves every
existing category/resource ID and timestamp, all existing counters and service
rows, the users, spaces and operations, and an existing version marker. Only an
absent identity marker is added. A complete current ledger remains unchanged;
no missing old authority or nonzero retained memory counter is reconstructed,
reset or removed. Each page reclassifies current state, so a prior eligible
audit does not authorize a later changed ledger.

## Empty-live-tail completion

The `legacy_empty_live_tail` disposition accepts only the historical unmarked
eleven-category, five-resource ledger. The only absent authority rows are the
`memory` category and the `live_chunk` and `memory_space` resources. Every
existing row must pass the same uniqueness, marker, timestamp, counter, ceiling
and total checks as the other dispositions. Marked variants, partially added
rows, or any other missing authority refuse.

The classifier proves there are no owner detail-stream `sessionChunks` through
`by_user_and_stream`, restricted to the exact user and `stream: "detail"`, with
`take(1)`. Any detail row refuses with `legacy_chunks_present`, including an
expired row, a row without an expiry, or a row whose session head is absent.
Compact-only history remains admissible and unchanged. The classifier also
requires empty owner `memorySpaces` and `memoryOperations` indexes, including
orphan operations; memory data refuses with `legacy_memory_present`. Another
owner's records do not affect this owner's eligibility.

The mutation repeats all three absence proofs in the transaction that inserts
exactly the three zero authority rows and adds the identity marker. It preserves
all existing IDs, fields, counters and timestamps, service totals and limits,
users and content. It neither recounts nor removes chunks. The stored marker
remains `quotaSchemaVersion: 2`, because the completed ledger shape is unchanged.
A later detail or memory write invalidates a previously eligible audit; a corrupt
later identity rolls back the entire page.

After source admission and deployment, run the read-only schema-3 diagnostic
and audit against the exact candidate, predecessor, numeric target and compiled
runtime. The audit must establish supported ledger shapes and no corruption
before the explicit repair operator creates an intent. The server reclassifies
each page in its mutation transaction; the supported operator separately
enforces its protected intent. Older schema-1 and schema-2 operators, intents
and receipts cannot authorize this policy. Preserve previous intents and
recovery roots; changing the source or evidence path is not a recovery bypass.
Completion still grants no capacity headroom or writer activation.

## Server interface

All three entries require an exact **bound** compiled runtime attestation and accept
`expectedRuntimeAttestation` plus `paginationOpts`, with one through eight users
per page. Pagination accepts only `cursor` and `numItems`; caller range and read
overrides refuse. Server-owned read bounds and a returned-page length check
preserve the eight-user limit. Empty pages still require hard service authority.
The tracked unbound build refuses all three operations. Internal server-test
functions accept an explicit fixture runtime so tests do not alter release
attestation files or weaken production entrypoints.

`quota:auditUserQuotaUpgradePage` returns `schemaVersion: 3`, `continueCursor`,
`isDone`, `scanned`, `legacy`, `legacyEmptyLiveTail`, `unmarkedCurrent`,
`incompleteEmptyMemory`, `current` and `corrupt`. The six disposition counts sum
to `scanned`. It writes nothing and emits no identity or raw quota rows.

`quota:upgradeUserQuotaPage` returns `schemaVersion: 3`, `continueCursor`, `isDone`,
`scanned`, `current`, `changed`, `upgraded`, `upgradedLiveTail`, `marked` and
`repairedMemory`. `current + changed = scanned`. `upgraded` retains its original
six-resource legacy meaning; `upgradedLiveTail` counts five-resource completions;
`repairedMemory` counts only incomplete-empty-memory completions. `marked` counts
only newly added markers, including an unmarked completion. The detail counts
satisfy `upgraded + upgradedLiveTail + repairedMemory <= changed` and
`changed - repairedMemory <= marked <= changed`. This distinguishes already
marked repairs from newly marked identities without double-counting the page.
Every page is atomic; a corrupt later identity rolls back earlier additions.

The diagnostic uses the same schema-3 partition. Only remaining corruption
enters `missingShapes`; otherwise matching shapes with actual owner data instead
report `legacy_chunks_present`, `legacy_memory_present` or
`incomplete_memory_present`. Operator intents and completion receipts use
`schemaVersion: 3` and fixed
`repairPolicy: "empty-live-tail-memory-authority-v1"`. Schema-1 and schema-2
pages, intents and receipts cannot authorize this policy. Runtime attestations
and the stored quota marker retain their existing versions.
An interrupted operation retains its exact intent and is re-audited before any
idempotent page request. A lost response cannot produce a success receipt; an
exact completed replay performs readback only.

Closed refusals are `QUOTA_UPGRADE_RUNTIME_CHANGED` and
`QUOTA_AUTHORITY_CORRUPT`. Unknown database failures remain unknown. Migration
does not publish capacity evidence or activate hosted commands.

## Delivery and acceptance

Items 1 through 3 record prior source evidence. The schema-3 extension also
requires focused conservation, compact-only acceptance, detail-row refusal
(expired, orphan and missing-expiry forms), unrelated-owner isolation,
idempotency, page rollback and audit-to-mutation race tests. Operator checks
cover the six-way audit partition, `upgradedLiveTail` conservation and refusal of
historical schema-2 evidence; all 32 focused operator tests and 95 server
contract tests pass. Strict TypeScript, scoped ESLint, baseline adoption and
all 33 release-workflow equivalence tests pass. Independent full-change
and impact review passes. PR 207 passed its integration gate, merged and was
deployed; the protected repair and two clean readbacks are complete.

1. Reproduction is complete: two ordinary writes fail on the explicit predecessor
   shape; the same counters pass when both new rows are supplied.
2. Server implementation and focused conservation, corruption, atomic rollback,
   concurrency, pagination and runtime-fence tests pass. The focused quota,
   quota-upgrade and memory-sync suites pass 51 tests. Strict focused TypeScript
   and scoped ESLint also pass. This is credential-free source evidence.
3. The guarded operator and fixed immutable source-launcher mode are implemented.
   The operator binds exact source, candidate, predecessor and numeric target,
   audits before writing, retains a protected intent and requires two clean
   verification passes. Eighteen focused operator tests cover drift, uncertain
   responses, replay, bounded pagination and retained cleanup. Twenty-five
   launcher tests cover the preserved source and environment boundary, fixed
   command selection and neutral startup documentation. Neither status nor the
   completion receipt admits command activation.
4. Independent review and the repository integration gates passed for PR 207.
   This evidence admits its source and deployment, not a daily-driver claim.
5. Source qualification, supported deployment, read-only audit, bounded repair
   and two clean readbacks are complete for this quota policy. Hard-quota capacity
   repair and activation retain their separate guards and evidence requirements.
