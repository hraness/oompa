---
title: Hosted memory quota authority upgrade
description: Preserve predecessor quota ledgers while adding the two memory authority rows through a bounded explicit migration.
type: plan
status: in-progress
area: oompa
tags: [convex, memory, quota, migration]
relations:
  related-to: [plans/oh-memory-civilization, plans/oompa-v1]
---

# Hosted memory quota authority upgrade

## Diagnostic evidence and prepared follow-up

A live source-bound diagnostic reported one `schema_shape` failure. The existing
reason cannot distinguish a partially added memory ledger, lost marked memory
rows, or a missing older counter. A read-only shape histogram now projects the
marker, fixed ordered missing categories/resources, and absent/zero/nonzero
retained memory counters at that exact classifier failure. The operator rejects
noncanonical, duplicate, inconsistent or impossible groups and binds their total
to the shape-failure count. No second database read changes the observation.

Focused conservation and parser tests pass (44 tests, 4,647 assertions), as do
strict TypeScript, scoped lint and independent source review. That is the earlier schema-1 diagnostic evidence. Its current-base Required CI,
deployment and live missing-shape readback remain separate from the repair below.
The observed `schema_shape` reason alone does not establish repair eligibility.
Diagnosis grants no repair or activation authority.

A separate follow-up prepares schema-2 empty-memory completion. It remains
unmerged and unexecuted pending the exact live missing-shape evidence. The
classifier checks the two owner indexes before counting a ledger as
`incompleteEmptyMemory`; the earlier histogram did not perform that check.
Initial focused tests pass across quota, memory sync, upgrade and operator
contracts (110 tests, 6,469 assertions). The final upgrade/operator checks pass
53 tests with 6,357 assertions after adding partial-page lost-response recovery
and an audit-to-mutation data-change refusal. Focused TypeScript, scoped lint
and baseline adoption pass. Independent source review passes the complete
change. Integration remains held on the precise live diagnostic; no hosted data
was read or modified for this preparation.

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
  markers, duplicate or missing old rows, invalid counters and inconsistent quota
  authority refuse. Partial or marked memory-only gaps require the separate
  classification below; they never become legacy ledgers.
- Legacy zero usage requires both owner indexes to be empty, including orphan
  memory operations. Another owner's data does not block this migration.

Audit and repair share the same bounded classifier. It validates category and
resource uniqueness, configured limits, canonical byte/record pairs, safe totals
and service totals no smaller than the owner totals. This preserves existing
validated accounting; it is not a full recount of all historical documents.

## Prepared empty-memory completion

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

Before integration, obtain the exact deployed diagnostic shape and independently
review this bounded transition. After source admission and deployment, require
a fresh schema-2 audit against the exact candidate, predecessor, numeric target
and compiled runtime. It must establish the empty owner indexes and no other
corruption before the operator creates an intent. Preserve previous intents and
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

`quota:auditUserQuotaUpgradePage` returns `schemaVersion: 2`, `continueCursor`,
`isDone`, `scanned`, `legacy`, `unmarkedCurrent`, `incompleteEmptyMemory`, `current`,
and `corrupt`. The five disposition counts sum to `scanned`. It writes
nothing and emits no identity or raw quota rows.

`quota:upgradeUserQuotaPage` returns `schemaVersion: 2`, `continueCursor`, `isDone`,
`scanned`, `current`, `changed`, `upgraded`, `marked` and `repairedMemory`.
`current + changed = scanned`. `upgraded` counts only legacy transitions;
`repairedMemory` counts only incomplete-empty-memory completions. `marked` counts
only newly added markers, including an unmarked completion. The detail counts
satisfy `upgraded + repairedMemory <= changed` and
`changed - repairedMemory <= marked <= changed`. This distinguishes already
marked repairs from newly marked identities without double-counting the page.
Every page is atomic; a corrupt later identity rolls back earlier additions.

The diagnostic uses the same schema-2 partition. Only remaining corruption
enters `missingShapes`; a matching shape with actual memory data instead reports
`incomplete_memory_present`. Operator intents and completion receipts use
`schemaVersion: 2` and fixed `repairPolicy: "empty-memory-authority-v1"`.
Schema-1 pages, intents and receipts cannot authorize this policy. Runtime
attestations and the stored quota marker retain their existing versions.
An interrupted operation retains its exact intent and is re-audited before any
idempotent page request. A lost response cannot produce a success receipt; an
exact completed replay performs readback only.

Closed refusals are `QUOTA_UPGRADE_RUNTIME_CHANGED` and
`QUOTA_AUTHORITY_CORRUPT`. Unknown database failures remain unknown. Migration
does not publish capacity evidence or activate hosted commands.

## Delivery and acceptance

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
4. Independent review and the repository integration gates remain required.
   Server tests alone do not admit deployment or a daily-driver claim.
5. Source qualification, supported deployment, read-only audit, bounded repair
   and readback remain separate operational steps. Existing hard-quota capacity
   repair and activation retain their own guards and evidence requirements.
