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

## Current diagnostic work

A live source-bound diagnostic reported one `schema_shape` failure. The existing
reason cannot distinguish a partially added memory ledger, lost marked memory
rows, or a missing older counter. A read-only shape histogram now projects the
marker, fixed ordered missing categories/resources, and absent/zero/nonzero
retained memory counters at that exact classifier failure. The operator rejects
noncanonical, duplicate, inconsistent or impossible groups and binds their total
to the shape-failure count. No second database read changes the observation.

Focused conservation and parser tests pass (44 tests, 4,647 assertions), as do
strict TypeScript, scoped lint and independent source review. Current-base
Required CI, deployment and live readback remain pending for this extension. This
diagnostic does not change the approved transition below: no missing counter is
inferred, written or reset, and diagnosis grants no repair or activation authority.

The memory schema adds a quota category and a user resource. Existing identities
with the complete predecessor ledger have eleven categories and six resources;
ordinary current quota mutations require twelve and seven. A credential-free
predecessor fixture reproduces `QUOTA_AUTHORITY_CORRUPT`. Adding exactly the two
new zero rows is a passing positive control. This upgrade defect is separate from
the existing authority-reduction hard-quota hold.

## Approved transition

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
- A complete marked current ledger is an idempotent no-op. Marked missing rows,
  partial additions, unknown or misplaced markers, duplicate or missing old rows,
  invalid counters and inconsistent quota authority refuse.
- Legacy zero usage requires both owner indexes to be empty, including orphan
  memory operations. Another owner's data does not block this migration.

Audit and repair share the same bounded classifier. It validates category and
resource uniqueness, configured limits, canonical byte/record pairs, safe totals
and service totals no smaller than the owner totals. This preserves existing
validated accounting; it is not a full recount of all historical documents.

## Server interface

Both entries require an exact **bound** compiled runtime attestation and accept
`expectedRuntimeAttestation` plus `paginationOpts`, with one through eight users
per page. Pagination accepts only `cursor` and `numItems`; caller range and read
overrides refuse. Server-owned read bounds and a returned-page length check
preserve the eight-user limit. Empty pages still require hard service authority.
The tracked unbound build refuses both operations. Internal server-test
functions accept an explicit fixture runtime so tests do not alter release
attestation files or weaken production entrypoints.

`quota:auditUserQuotaUpgradePage` returns `schemaVersion: 1`, `continueCursor`,
`isDone`, `scanned`, `legacy`, `unmarkedCurrent`, `current`, and `corrupt`. It writes
nothing and emits no identity or raw quota rows.

`quota:upgradeUserQuotaPage` returns `schemaVersion: 1`, `continueCursor`, `isDone`,
`scanned`, `current`, `upgraded`, and `marked`. `upgraded` counts identities that
received the two zero rows. `marked` includes those identities and complete
unmarked current identities. Every page is one atomic transaction; a corrupt
later identity rolls back earlier additions in the same page.

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
