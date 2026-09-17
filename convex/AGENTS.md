# Contents

- `schema.ts` defines Oompa cloud identity, device, envelope, projection, lease, command, and retention state.
- Auth modules implement verified-email login and device enrollment.
- `authorityReductionCapacity.ts` preserves dedicated deletion reserves for new identities and uses versioned padding on an existing unique active subject plus a job reserve for legacy backfill. Inline reservation charges bytes without another identity record; consumption proves the subject patch does not grow, and cleanup releases the full padded subject exactly once.
- Sync and command modules authorize exact device and lease generations. Session commands are lease-fenced; device commands are addressed to a device and fenced by that daemon's boot authority instead.
- `commandLifecycle.ts` exposes a bounded read-only authority-reduction quota diagnostic. It shares current ledger validation with quota accounting, emits aggregate ceiling counts and keeps unknown byte costs explicit.
- `quota.ts` audits predecessor ledger upgrades and exposes bounded read-only corruption reason counts and missing-shape histograms through the same classifier. Its distinct empty-memory completion requires both owner memory indexes empty and inserts only absent memory authority rows. The older unmarked five-resource predecessor additionally requires the indexed owner detail stream empty before adding zero live-chunk authority; compact history and existing counters remain intact. Diagnosis never grants repair authority or changes stored counters.
- `autorespond.ts` serves `POST /v1/autorespond`, the hosted prose responder: it authenticates by the forwarded credits device token, holds and settles one `assistant_reply` on the Hraness credits service, calls the Vercel AI Gateway with the operator's key, and passes a shortfall through as `402 credits_required`. It writes no table; its bounds are registered in `costs.json` and its variables in `.env.example`.
- Tests prove rate limits, transactions, encryption boundaries, recovery, and retention.

# Guidelines

- Use one Convex Auth credentials provider. Do not add a second identity provider or accept email as authority after login.
- Store only purpose-separated challenge digests. Codes are one-time, rate-limited, and expire.
- Treat the authenticated user plus active device plus current auth epoch as the minimum write authority.
- Never accept plaintext session content, provider credentials, raw protocol data, raw reasoning, approval secrets, arbitrary tool output, or environment values.
- Keep functions strict and bounded. Reject unknown fields, stale revisions, stale leases, and replayed idempotency keys.
- Close an effect that may already have begun as `ambiguous` under a strictly later authority. Never let a recovery path publish `applied` for an effect it did not observe.
- Add a table only with an explicit entry in every exhaustive hosted map: lifecycle policy, quota genesis, account deletion, device revocation, the maintenance categories that sweep it, and the `costs.json` cost-discipline registry checked by `check:cost-surfaces`.
