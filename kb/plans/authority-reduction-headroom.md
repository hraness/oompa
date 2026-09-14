---
title: Authority-reduction quota headroom and inline deletion capacity
status: implementation
---

# Authority-reduction quota headroom and inline deletion capacity

## Current evidence and scope

The protected quota upgrade from
[PR 207](https://github.com/hraness/oompa/pull/207), merged as
`899bfb6fe6e1235643d88239033140e833d74ea9`, is deployed and complete. Three
ledgers were upgraded and two complete audits found all four current. The
subsequent source-bound capacity diagnostic found three identities ready and
one missing an account pair and one device quartet. All four quota ledgers were
valid. Only `identity.recordsBlocked` was nonzero: that category already had
exactly its allowed 256 records. Other record-ceiling counts were zero.
This observation does not prove byte headroom or authorize activation.

The new source change stores the legacy account identity-patch reserve inline
on its existing auth subject. This removes the need for an additional identity
record while preserving the exact identity ceiling, actual stored-byte charging,
all other quotas and user data. Fresh identities and already complete dedicated
account pairs retain their existing version-1 representation. Device quartets,
command lifecycle reservations, cleanup debt and hosted activation guards
remain unchanged.

## Inline account-deletion backfill

Only exact legacy capacity backfill may add the optional
`authSubjects.accountDeletionCapacity` object. It contains `version: 2`,
`reservation` as exactly 2048 ASCII `0` characters, and `createdAt`. The
transaction also inserts the existing dedicated account job reservation using
the same timestamp. It charges the subject's exact stored-byte increase to the
identity category with zero added identity records and charges the job normally.
It does not reclaim auth records, delete content or raise the 256-record ceiling.

Classification requires one exact active bound subject, the canonical inline
reserve and its matching dedicated job row, with no dedicated identity reserve.
Mixed, partial, duplicate or drifted forms refuse. On deletion, the subject patch
removes the reserve while disabling the subject and advancing its auth epoch.
The stored subject must not grow. The dedicated job reserve is exchanged for
the deletion job with the existing quota and draining-job guards. Existing
version-1 pairs use their current exchange; new-user admission keeps creating
those pairs atomically.

Once inline data exists, repair forward from its attested candidate. Do not
redeploy any pre-inline schema or runtime, even one that supports the earlier
dedicated capacity rows.

## Diagnostic and evidence versions

The read-only `diagnose-headroom` result and server page advance to version 2.
For missing legacy sets, exact new-record demand is
`accountPairs + 4 * deviceQuartets`; identity record demand is zero. Padding
remains `(2 * accountPairs + 4 * deviceQuartets) * 2048` bytes. For the observed
one-account, one-device gap, that is five new records and a 12,288-byte padding
floor. Inline object metadata still contributes real charged bytes. The
diagnostic reports padding-only byte lower bounds and leaves other byte costs
unknown rather than treating an available record slot as repair admission.

Protected local readiness and activation receipts advance to schema 2 and bind
`authorityReductionPolicy: "inline-account-deletion-backfill-v1"`. Historical
schema-1 local receipts cannot authorize this policy. The hosted readiness and
activation contract stays version 1, and executor marker 2 remains unchanged.
The operator must still prove exact source, candidate, predecessor, target and
runtime, perform two complete zero-debt scans, store hosted activation, read it
back and publish the separate protected `.activated` receipt. A diagnostic or
first readiness file alone does not activate writers. See the
[hosted runbook](../../docs/hosted-sync.md) for the fixed invocation and guards.

## Current implementation and acceptance

Inline backfill, classification, consumption, headroom demand and versioned
operator evidence are implemented. The server suite passes 83 focused tests,
including nine new inline-capacity regressions; the final predicate-only lint
correction passes those nine again. The operator passes 32 tests, the headroom
contracts pass 29 tests, and release-workflow equivalence passes 33 tests.
Scoped lint and managed-baseline adoption pass. Independent full-change and
impact review passes. Local strict types pass. The additional native verifier passes nine focused
tests and independent review. Final Required CI, integration and supported
deployment remain pending. Live repair must then complete with unchanged data and quotas,
followed by two zero-debt audits and exact protected activation readback. This
plan does not claim hosted activation or daily-driver qualification complete.

The separate deletion-lifecycle live gate remains pending. The
[retention contract](../../docs/retention.md) requires fresh-deployment and live
completion acceptance before this change can replace the live candidate.
Focused tests, Required CI and the protected capacity receipts do not waive
that gate. Record the applicable live acceptance evidence before candidate
replacement; hosted repair and activation retain their additional guards.

Required focused evidence includes backfill at the identity-record ceiling,
actual byte-limit refusal with atomic rollback, repeated backfill, unchanged
fresh-user and dedicated-pair behavior, no-growth inline consumption, malformed
or mixed reserve refusal, adjusted record/padding conservation and historical
receipt rejection. Source checks cannot substitute for the later guarded live
repair and readback.

## Earlier diagnostic source evidence

The earlier diagnostic added a fixed eight-row query and closed
`diagnose-headroom` action, shared validated-ledger reads, exact capacity
classification and bounded operator parsing. It reported every applicable
category/user/service record blocker without emitting identity, raw usage,
timestamps or secrets. A zero attempted hard-quota failure was not treated as
proof of available headroom.

Focused validation passed 159 tests with 10411 assertions across quota,
lifecycle, operator and launcher suites. An explicit parsed-page type repaired
a TypeScript inference error; the affected operator/launcher replay passed
62 tests with 9735 assertions. Final narrow strict types and scoped lint passed.
The unchanged release-workflow contract passed 33 tests with 1222 assertions,
and the managed repository baseline was current. This prior evidence does not
qualify the new inline representation or schema-2 policy.

## Limits

A page is one query snapshot; a multi-page result is not a single transaction or
stable-population proof. Per-identity service observations do not prove that all
repairs fit together. Metadata costs inside the padding-only uncertainty range
remain unknown. Unknown authority or incomplete observation never becomes
readiness, repair permission or an automatic retry.

## Native deletion qualification

Independent operational review identified that the inline change also needs the
retained deletion fresh-deployment and live-completion gate. The broader Linux
scenario requires provider sign-ins and creates dedicated reserves, so it does
not exercise this legacy branch. The reviewed qualification path uses a fresh
official Convex backend, exact production handlers and cron intervals, charged
synthetic fixtures, public deletion requests and complete scheduled cleanup.
The [procedure](../../docs/deletion-backend-acceptance.md) separates this native
evidence from SaaS authentication and the later protected production activation.
The runner and isolated fixture are implemented. Nine focused tests with
69 assertions, scoped lint, public-text policy and independent source/impact
review pass. An actual native passing receipt remains pending. No earlier test
or capacity receipt closes this requirement.

Native setup exposed two verifier parsing errors: the official admin key carries
an instance prefix and delimiter, and macOS listener output includes descriptor
fields. Both now have exact-instance or exact-listener regressions. Failed runs
collected their process groups and retained private diagnostics. The runner
preserves bounded child errors after collection and reports closed setup phases.
