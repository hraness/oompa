# Contents

- Identifiers and schemas define bounded product values and opaque facts-memory receipts.
- Reducers model profile, process, session, turn, queue, switch, sync, and recovery states.
- Presets compile user aliases against observed provider capabilities.
- Encryption models account-data keys, device envelopes, and encrypted projections.
- Attachments define the accepted media types, byte and count bounds, byte sniffing, the digest reference a message carries, and how a text-ish file folds into a prompt.
- Leaf utilities (`guards.ts`, `uuid-v7.ts`, `text-safety.ts`, `cloud-outcomes.ts`, `desktop-switch.ts`, which now only decodes the retained desktop-switch journal) hold the shapes and guards that storage, the daemon, and every adapter share without importing each other.

# Guidelines

- Make invalid states unrepresentable where possible and reject incoherent persisted rows otherwise.
- Keep transitions pure and exhaustive. Attach effect execution through ports outside this directory.
- Property-test parser totality, canonical ordering, revision monotonicity, transition legality, encryption round trips, tamper rejection, and idempotency.
- Keep account labels, provider identity, paths, and text out of content-free authority records.
- Facts-memory bindings are derived from the exact owner/session pair plus a monotonic host-owned expiry epoch. No agent-facing input may select an epoch, store, path, authority, rule set, or purge capability.
