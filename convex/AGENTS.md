# Contents

- `schema.ts` defines Oompa cloud identity, device, envelope, projection, lease, command, and retention state.
- Auth modules implement verified-email login and device enrollment.
- Sync and command modules authorize exact device and lease generations. Session commands are lease-fenced; device commands are addressed to a device and fenced by that daemon's boot authority instead.
- `commandLifecycle.ts` exposes a bounded read-only authority-reduction quota diagnostic. It shares current ledger validation with quota accounting, emits aggregate ceiling counts and keeps unknown byte costs explicit.
- `quota.ts` audits predecessor ledger upgrades and exposes bounded read-only corruption reason counts through the same classifier; diagnosis never grants repair authority or changes stored counters.
- Tests prove rate limits, transactions, encryption boundaries, recovery, and retention.

# Guidelines

- Use one Convex Auth credentials provider. Do not add a second identity provider or accept email as authority after login.
- Store only purpose-separated challenge digests. Codes are one-time, rate-limited, and expire.
- Treat the authenticated user plus active device plus current auth epoch as the minimum write authority.
- Never accept plaintext session content, provider credentials, raw protocol data, raw reasoning, approval secrets, arbitrary tool output, or environment values.
- Keep functions strict and bounded. Reject unknown fields, stale revisions, stale leases, and replayed idempotency keys.
- Close an effect that may already have begun as `ambiguous` under a strictly later authority. Never let a recovery path publish `applied` for an effect it did not observe.
- Add a table only with an explicit entry in every exhaustive hosted map: lifecycle policy, quota genesis, account deletion, device revocation, and the maintenance categories that sweep it.
