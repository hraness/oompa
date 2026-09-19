# Contents

- The daemon hosts the local command authority, long-running provider processes, and opaque session-memory lifecycle coordination.
- `custody-engine.ts` holds the one process-wide local-custody engine: it prefers the packaged Rust sidecar and falls back per operation. Custody checks whose callers branch on `ENOENT` keep the direct TypeScript imports because the sidecar reports a missing path as a `CustodyError`, not an `ErrnoException`.
- One session has one exact provider binding at a time. A durable switch journal alone may replace that binding; existing effects and interactions retain their original authority. The service selects the captured provider's `SessionRuntimePort` for start, turns, steering, interrupt, projection reads and interactions. Provider facts use one neutral timeline vocabulary.
- The Unix socket transports one bounded authenticated request at a time.
- The explicit live-acceptance daemon composition exposes a structural observer for actual personal-provider children. Its acceptance implementation and bounded status policy live under `scripts/`; the reusable exact-child adapter lives under `src/claude/`.
- `devin-runtime-adapter.ts` implements the neutral seam for the pinned `devin acp` server on top of `src/devin/`. It is a constructed port with its own tests; the service does not select it until the Devin plan's third phase lifts the retired-provider refusals.
- Autorespond decides who answers an approval: the protocol path answers provider requests, the prose path answers an assistant turn that asks only for consent through the responder port.
- Gateway key custody keeps the responder credential in one user-only file, never in a journal, log, or projection.
- Attachment ingest resolves a filesystem path into local content-addressed custody; attachment resolution turns a message's digest references back into bytes for the provider adapters.

# Guidelines

- Keep the timeline provider-neutral. Admit providers by reducing their facts to the existing vocabulary and widening durable evidence so their reviewed profiles round-trip unchanged, never by branching the reducers, projections, or classifier.
- Authenticate with an ephemeral capability stored in a user-only file. Never accept a socket, capability, or state root through argv or environment overrides in production.
- Validate owner, mode, type, link count, containment, and canonical path before using an endpoint.
- Use absolute wall-clock deadlines, close admission before shutdown, abort in-flight reads, and join every owned task before storage closes.
- Serialize mutations by their authority key. Allow bounded independent reads that cannot observe torn state.
- Keep explicit sessions and work routes pinned. A managed Codex session may follow a durable automatic account decision only after exact reset handling, fresh source and target rereads, complete switch recovery, and revision revalidation. Never rotate Claude accounts or derive a replay from provider failure, classifier text, stale observations, or ambiguous effects.
- Never trust a responder's text. Autorespond sends one fixed approval sentence, or a literal proven byte-exact inside the assistant's own message, and every attempt leaves an evidence row with no message text, literal, or credential in it.
- Reconcile facts-memory creation, accepted-head ancestry, historical exact-head fork, and whole-directory cleanup by immutable owner/session/epoch binding. Fence parent cleanup behind unresolved child forks, admit live TTL from current host time, and clean every terminal commit immediately plus restart-safe isolated scans. Do not expose semantic-store selection or purge through commands or tools.
