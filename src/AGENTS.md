# Contents

- `cli/` parses commands and renders stable human or JSON output.
- `daemon/` owns the local socket, lifecycle, command dispatch, joins, and the opaque facts-memory broker seam.
- `codex/` owns the pinned app-server process and protocol adapter.
- `claude/` owns the pinned Claude Code process, its stream-json dialect, and the delta assembler behind the same runtime port.
- `domain/` owns identifiers, presets, projections, state transitions, encryption envelopes, and command outcomes.
- `storage/` owns SQLite migrations, repositories, secret custody, state paths, and facts-memory directory custody.
- `cloud/` owns the optional Convex client, sync projections, device enrollment, execution leases, and remote commands.

# Guidelines

- Keep `cli.ts` a thin composition entry point. Put behavior in owned modules with injected ports.
- Use closed command and result unions. Do not pass argv strings or provider method names into domain code.
- Parse all filesystem, database, socket, provider, cloud, and JSON values from `unknown`.
- Store a prepared receipt before every mutation. Bind it to the exact authority generation and reconcile indeterminate outcomes without replay.
- Use absolute, canonical, no-follow paths for durable state and profile roots. Require user-only permissions.
- Keep CLI and detached-daemon secret custody noninteractive. Use current-user-owned mode-0700 directories and descriptor-read mode-0600 immutable values; never silently overwrite or delete recovery evidence. Do not depend on a Keychain prompt from an unsigned interpreter process.
- Keep semantic facts, rules, projections, raw store handles, database locators, and purge authority behind the host-owned facts-memory broker. The Oompa control plane may retain only bounded opaque lifecycle authority and exact public heads or receipts.
- Force both pinned Codex credential stores to file mode at the process boundary and prove their effective values before account, plugin, or session effects.
- Preserve stdout for requested data. Send diagnostics to stderr. Never print secrets, provider payloads, environment values, or raw local paths in cloud-facing output.
- Bound lines, frames, pages, bytes, timers, retries, queues, and retained records.
- Keep runtime imports flowing one way: `domain` -> `storage` -> `daemon` -> `cli`, `cloud`, `codex`. Adapters reach the daemon through `import type` of `daemon/ports.ts`. `eslint.config.mjs` enforces the per-directory rule and `scripts/check-import-cycles.ts` proves zero file-level cycles; move a shared shape into `domain/` instead of importing upward.
