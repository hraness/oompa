# Security

Oompa coordinates Codex accounts on macOS and Linux and Claude Code accounts on Linux, and it can control active coding sessions on those supported provider surfaces. Treat a vulnerability that crosses a provider, account, device, process generation, filesystem root, or execution lease as security-sensitive.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, platform, reproduction steps, expected boundary, observed result, and whether credentials or provider mutations were exposed.

## Supported versions

| Version | Status |
| --- | --- |
| `v0.8.3` | Fully admitted beta. Supported and receives security fixes. Daemon and hosted command-writer rollout remains capacity-gated. |
| `v0.8.0` through `v0.8.2` | Canonical GitHub predecessors, superseded by `v0.8.3`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.7.1` | Superseded by `v0.8.3`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.7.0` | Superseded by `v0.7.1`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.6.3` | Superseded by `v0.7.0`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.6.2` | Superseded by `v0.6.3`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.6.1` | Superseded by `v0.6.2`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.6.0` | Immutable partial publication. The workflow did not complete final admission; unsupported. |
| `v0.5.0` | Superseded by `v0.6.1`. Unsupported. Do not bypass the update runbook to migrate. |
| `v0.4.1` | Superseded by `v0.5.0`. Unsupported. |
| `v0.4.0` | Superseded by `v0.4.1`. Unsupported. |
| `v0.3.0` | Superseded by `v0.4.0`. Unsupported. |
| `v0.2.1` | Superseded by `v0.3.0`. Unsupported. |
| `v0.2.0` | Superseded by `v0.2.1`. Unsupported. |
| `v0.1.6` | Superseded by `v0.2.0`. Unsupported. |
| `v0.1.5` | Superseded by `v0.1.6`. Unsupported. |
| `v0.1.0` through `v0.1.4` | Unsupported. These tags produced no admitted npm package plus GitHub Release pair; `docs/beta-release.md` records each outcome. |

Only the latest fully admitted beta receives security fixes.

## Product boundary

Oompa does not sync Codex, Claude Code, or Devin credentials, provider profile files, raw reasoning, approval secrets, environment values, or arbitrary tool output. Cloud commands do not bypass local provider permissions. Account and provider switching is explicit and never used to evade provider limits.

The CLI stores Oompa's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories must be owned by the current user with mode 0700. Value files must be single-link mode-0600 regular files and are read through bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. Oompa forces both pinned Codex credential stores to file mode and verifies their effective settings, so Codex credentials remain separately owned by each profile's isolated `CODEX_HOME`. Claude Code receives that profile's isolated `CLAUDE_CONFIG_DIR`. Historical Devin provider directories remain untouched. Oompa treats each whole provider directory boundary as provider-owned and never reads, copies, or forwards its credentials. Provider-managed system credential storage remains owned by the provider runtime.

Claude Code owns Claude authentication inside each profile's separate absolute `CLAUDE_CONFIG_DIR`. On Linux, Oompa resolves a regular-file Claude executable and admits only the exact self-reported version it pins, then the foreground login gives that path the terminal descriptors directly. This version check is a compatibility boundary, not a binary-provenance proof or protection against a malicious same-user PATH substitution. The status path bounds time and output, validates the admitted CLI's response, and exposes only `signedIn`. Oompa never opens, copies, renders, or uploads a Claude credential. Claude login has no web, device-code, detached-handoff, or background-cancellation path. Oompa refuses new managed Claude login, status-probe, session, and switch effects on macOS until authenticated testing proves isolated Keychain custody and detached-daemon reads without a prompt. Opt-in personal-home adoption is separate: it requires exact personal-account and prior-process liveness proof and never claims isolated managed-Keychain custody.

Devin execution is retired. Oompa preserves historical local sessions, unsettled authority, and provider-owned credentials without launching the CLI or treating legacy Codex shadow columns as active authority. Retired sessions cannot execute or participate in peer coordination. Only exact acknowledged cleanup of historical login fences remains available; it does not kill a process or establish provider-state success.

Codex web linking uses a versioned request for the provider's device-code mode. The HTTPS verification URL and separate user code are validated as one complete handoff, encrypted under the Oompa account key, readable once by the requesting browser, and erased from the hosted row on that read. A hosted settlement deadline blocks release after five minutes even when the machine clock is wrong. Local account-linking opt-in, registry membership, requesting-device authority, and daily command limits all apply before the provider effect.

Working-memory authority is host-derived from one exact account, session, and epoch. A new project canonical authority receives a random portable identity before Oompa creates its database. Agent commands cannot select either store, directory, authority, rule set, sync credential, or purge capability. Oompa's control databases retain exact local identifiers, digests, heads, receipts, encrypted hosted envelopes, and bounded lifecycle and recovery metadata, but not plaintext memory titles, summaries, or bodies. Release-verified public Oh v0.4.1 remains the semantic authority behind the stable `@hraness/oh/memory` export and a narrow broker port; `package.json` and `bun.lock` bind that exact immutable npm release.

The local Oh adapter confines each working store to one canonical current-user-owned mode-0700 session directory and each canonical store to one similarly private project directory outside Oompa's lifecycle SQLite. It enforces and reads back mode 0600 on the main SQLite file, observed WAL and SHM files, and its no-follow metadata sidecar. Working-memory cleanup quiesces the store, rejects links and path escape, revalidates the bounded tree, renames the whole directory to a host-derived quarantine, and removes that quarantine before committing a purge receipt. These path checks protect against accidental and cross-boundary traversal. They do not sandbox another process running as the same operating-system user, and they do not erase backups or filesystem snapshots.

Hosted canonical memory uses a random per-space data key wrapped by the Oompa account key. The service stores encrypted operation, head-proof, adoption-proof, and descriptor envelopes and compares purpose-separated keyed head tokens. None of those canonical-memory uploads exposes the raw Oh head, portable canonical identity, page body, project or session ID, local path, or encryption key as server-visible plaintext. Clients still treat decrypted hosted bytes as untrusted and verify exact Oh replay before import. An attached canonical mutation requires a live synchronizer and a fresh converged hosted head. Conflict or uncertain recovery fences canonical mutation instead of selecting a winner, while working-only reads and writes remain available.

Peer coordination is a separate, non-administrative authority. Actor and target sessions must be distinct, current, and in the same local project. Inspection requires both policies to remain above `off`; mutation requires both exact policy revisions to remain `coordinate`. Changing either policy revokes stale authority. Every peer message is wrapped as untrusted input and cannot resolve an approval, answer a protected question, change session policy, create Work membership, or inherit the source session's identity.

Peer mutation refuses a stale target revision, a causal cycle, or a ninth hop before any provider effect. Rolling actor, project, target-fanout, inbound-queue, and retained-ledger ceilings bound amplification. Complete replay and causal detail remains for at least seven days; active turns, unsettled effects, unresolved queue or mutation evidence, and recursively required ancestry stay pinned. Cleanup removes only closed terminal subgraphs, and capacity exhaustion fails closed instead of discarding recovery authority. The encrypted compact projection preserves legacy `actor: "autorespond"` for every non-owner message and carries peer or handoff detail in optional `actorKind`; a bounded future kind renders as `other sender`, never as the owner.
