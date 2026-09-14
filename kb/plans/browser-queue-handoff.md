---
title: Browser queue visibility and cooperative handoff
description: Advisory local scheduler visibility and exact-owner notices with unchanged admission and inherited custody.
type: plan
status: implemented
area: operations
tags: [scheduling, plugins, browser]
relations:
  related-to: [plans/delivery-autonomy]
---

# Browser queue visibility and cooperative handoff

Status: implementation and local qualification complete (2026-09-13).
Scope: [issue 199](https://github.com/hraness/oompa/issues/199), independently
versioned local-efficiency plugin 0.4.6. The Oompa product package and immutable
Slopcamera scheduler runtime pin retain their existing versions.

The wrapper reports long waits through a bounded, owner-private socket channel.
`oompa-host-queue` exposes the same versioned projection to Slopcamera and other
local callers. Reports are explicitly partial and owner-reported; availability
and custody are always unknown. A task UUID is shared only by an explicit
wrapper flag. No command, path, PID, environment value or private task title is
included. Observations never read or mutate admission ledgers or call
`assertOwned`, whose implementation can remove stale markers.

Registration and explicit `--prune-stale` repair only observation sockets: require
private ownership, an absent registered owner, an unreachable connection, age of at least 60 seconds, and unchanged
device, inode and modification time before unlink. Status itself remains
read-only. Unknown endpoints remain untouched; deleting a dead observation socket
cannot release the separate scheduler lease.
The refusal classifier admits `ECONNREFUSED`; only pinned Bun 1.3.14 on Darwin
and Linux also admits its `ENOENT` mapping, with the same exact socket readback.
A timeout never becomes refusal evidence. Unreachability is not owner-death proof.

The first CI candidate exposed retained stale sockets on Linux. The pinned
[Bun Unix connection implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/runtime/socket/Listener.zig#L865)
maps synchronous failures to `ENOENT` on both operating systems, including busy
listeners. The correction extends only the pinned Linux classifier and requires
`ESRCH` from signal-zero checks before and after probing. The immutable private
socket filename binds its random run ID to a bounded positive owner PID, which
never enters public projections. Live or reused PIDs and unknown results retain
the endpoint. All socket identity, age, timeout and privacy checks remain
required. Both operating-system CI suites qualify it.

Handoff is a bounded, idempotent notice addressed to an exact random run ID.
The owner records intent before attempting the notice. It may finish and collect
its bounded browser session and return its lease normally. No message interrupts
a child, releases a descriptor, cancels a waiter or changes queue order. Missing
observations cannot establish release because descendants may retain a lease.

Local acceptance evidence:

- Protocol/parser property laws, private socket bounds, deadlines, unknown/stale
  metadata, notice deduplication and read-only status: 35 focused tests passed
  with 7,179 assertions on Bun 1.3.14. These include private PID identities,
  live/reused owners, paused owners with queued clients, and disappearing sockets.
- Real immutable runtime, isolated holder and ordered waiters, middle waiter
  cancellation, handoff notice, surviving descendant after wrapper death,
  observation failure preserving child exit: 3 local native tests passed with
  33 assertions. Removing an unreachable observation socket did not admit the
  waiting command while the descendant retained its real lease.
- Existing wrapper/TTY, plugin/bootstrap, adoption and CI equivalence contracts:
  160 plugin tests passed; the 6 opt-in skips comprise 2 unchanged-runtime upgrade
  cases and the separately executed queue/TTY suites. All 13 native TTY cases
  passed with 174 assertions. TypeScript, focused ESLint and all 33 CI equivalence
  tests passed. Manifest and skill metadata validated. Managed repository policy
  checked current before editing.
- Independent complete-diff review resolved cancellation-during-CPU-wait and
  stale-endpoint recovery findings. Final review reported no open correctness,
  privacy, custody or gate-reduction findings.

Delivery requires the unchanged complete `Required` CI on the exact PR head and
current-base integration candidate, followed by marketplace/bootstrap installation
and command readback. The linked pull request and issue 199 carry that delivery
status and its exact commit/check/install receipts. Source implementation does not
activate the installed plugin; new tasks load the updated skill and prompt-only rule.
