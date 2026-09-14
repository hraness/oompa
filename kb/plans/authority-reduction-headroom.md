---
title: Authority-reduction quota headroom diagnostic
status: implementation
---

# Authority-reduction quota headroom diagnostic

The existing capacity audit reports missing reservation sets and whether this
run encountered hard quota during a repair. A zero attempted failure does not
identify available headroom, and aggregate service debt does not identify a
service-wide ceiling.

## Scope and decision

Add one read-only internal query and a closed `diagnose-headroom` action through
the existing command-capacity source launcher. Preserve status/repair schemas,
actual stored-row quota accounting, all ceilings and every activation guard.
No table, index, credential path, quota upgrade or deployment is added.

The query shares the validated current ledger reader and the exact capacity
classification. It reports all applicable category/user/service record blockers.
Required padding proves only a byte lower bound; other byte costs remain
unknown. No identity, raw usage, timestamp or secret is emitted. The diagnostic
cannot authorize repair, write readiness evidence or clear an operational hold.
See the [hosted runbook](../../docs/hosted-sync.md) for the fixed invocation and
interpretation.

## Implementation and acceptance

1. The fixed eight-row query, exact account-pair and device-quartet demand,
   shared ledger validation, strict aggregate parsing and finite operator scan
   passed independent source review. The final validation amendment is awaiting
   its evidence join.
2. Focused validation passed 159 tests with 10411 assertions across quota,
   lifecycle, operator and launcher suites. An explicit parsed-page type repaired
   a TypeScript inference error; the affected operator/launcher replay passed
   62 tests with 9735 assertions. Final narrow strict types and scoped lint pass.
   The unchanged release-workflow contract passed 33 tests with 1222 assertions,
   and the managed repository baseline is current.
3. Independent final evidence review and complete Required CI on the converged
   candidate remain required for source delivery. Runtime/deployment qualification
   and an actual guarded diagnostic remain separate and have not been performed.

## Limits

A page is one query snapshot; a multi-page result is not a single transaction or
stable-population proof. Per-identity service observations do not prove that all
repairs fit together. Metadata costs inside the padding-only uncertainty range
remain unknown. Unknown authority or incomplete observation never becomes
readiness, repair permission or an automatic retry.
