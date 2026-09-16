---
title: Session compaction control
description: Phased plan giving Oompa a provider-neutral session.compact effect — Codex thread/compact/start, Claude /compact steering, a durable compaction timeline event, and an opt-in token_usage-triggered auto-compaction policy.
type: plan
status: in_progress
area: oompa
tags:
  - bun
  - cli
  - codex
  - claude
  - compaction
  - context-management
relations:
  related-to: [ plans/oompa-v1, plans/oompa-v2, plans/model-routing-autonomy ]
---

# Session compaction control

Status: in progress (2026-09-14). External driver: Gobstopper (`docs/oompa-contract.md` there) consumes the numeric seam this plan adds; Oompa keeps full authority — Gobstopper never touches a live provider process.

## Outcome

Oompa can request provider-native compaction of a live session on both providers through one durable command, records every request and outcome in the provider-neutral timeline, and optionally dispatches that same command automatically when a session's `token_usage` crosses a configured threshold. Oompa never parses provider transcript files; compaction is always delegated to the provider's own machinery (`thread/compact/start` for Codex, a `/compact` stream-json steering write for Claude Code, verified admitted by the pinned 2.1.x runtime).

The plan is complete when:

1. `oompa session compact <session>` dispatches a bound, receipted mutation to the live provider binding of either provider and reports a closed result shape on stdout.
2. A provider `thread/compacted` notification (Codex) or `compact_result` fact (Claude) lands in the session timeline as a `compaction` event, so `oompa session events` shows the full requested → completed arc including compactions Oompa did not start.
3. Auto-compaction is off by default; when enabled, a `token_usage` event at or above the configured trigger produces exactly one `session.compact` durable command per usage bucket, fenced to the session's current authority generation.
4. `bun run check` passes; every new operation declares effect, deadline, serialization, and lost-response policy per `src/codex/AGENTS.md`.

## Constraints

- Keep the raw JSON-RPC call private; every used operation declares effect, deadline, serialization, lost-response, and reconciliation policy (`src/codex/AGENTS.md`).
- Never parse provider transcript files (`src/codex/AGENTS.md`, `src/AGENTS.md`).
- Timeline stays provider-neutral: both providers reduce to the same `compaction` event vocabulary (`src/daemon/AGENTS.md`).
- Receipt before dispatch; idempotency key; bind to exact authority generation; reconcile uncertain outcomes without replay (`src/AGENTS.md`, `src/daemon/AGENTS.md`).
- Auto-compaction must never fire during an in-flight turn and must bound its own dispatch rate.
- No transcript content, reasoning, or provider payload text in the `compaction` event — outcome enums and numeric token fields only.
- Live sessions stay on provider-native compaction. Custom transcript surgery remains Gobstopper's offline concern, never wired into this path.

## Verified provider facts

- Pinned `@openai/codex` 0.153.2 binary contains `ClientRequest::ThreadCompactStart` / `ThreadCompactStartParams` and emits `thread/compacted` notifications (already in the notification table as `"ignored"` at `src/codex/protocol.ts:211`).
- Generated schema (`codex app-server generate-json-schema`, v2 surface): `ThreadCompactStartParams = { threadId: string }`; `thread/compacted` params are `ContextCompactedNotification = { threadId, turnId }`, marked **deprecated** — the current signal is a `ThreadItem` of type `"contextCompaction"` arriving through the normal item stream. Route the deprecated notification AND make sure `contextCompaction` items degrade gracefully (bounded notice or a compaction fact), never an unhandled-shape fault.
- Claude Code 2.1.270 stream-json accepts a `user` line whose text is `/compact`: it emits `status: "compacting"`, a `compact_result` system fact, and a post-compact `init` — no restart or argv change needed. On a nearly empty session it returns `compact_result: "failed"` with `compact_error` — a normal outcome, not a protocol error.
- Claude `steer()` requires an active turn (`src/claude/client.ts:343`); `/compact` for an idle session is a fresh user-line write and needs a path that does not require `activeTurnId`.

## Phases

### Phase 1 — Codex compact operation + compaction event type

Deliver the provider-neutral `compaction` event and the Codex RPC operation.

- `src/domain/session-events.ts`: add a `compaction` variant to `sessionEventBodySchema` — fields limited to `outcome: "requested" | "completed" | "failed"`, `trigger: "manual" | "policy" | "provider"`, optional bounded `strategy` label, optional nonnegative `preTokens`/`postTokens`, optional bounded provider request/turn id. No text payloads.
- `src/codex/protocol.ts`: add `"thread/compact/start"` to `CodexMethod`; add `OPERATIONS` entry `operation("thread/compact/start", "thread-mutation", 30_000, "reconcile")`; change the `thread/compacted` notification disposition from `"ignored"` to `"routed"`. Verify `ThreadCompactStartParams` field names against the pinned protocol (expected `{ threadId }` — confirm via the vendored schema or a mock-transport round-trip test).
- `src/codex/client.ts`: add a fenced `compactThread(threadId)` method on the session client following the existing `thread/read`-style shape (`boundedIdentifier`, generation fencing, error mapping).
- Route the `thread/compacted` notification through the existing routed-notification path (session-effects/session-program) into a fact the service can persist as a `compaction` event with `trigger: "provider"` when no matching request exists.
- Tests: `src/codex/protocol.test.ts` (method union, descriptor, notification disposition), `src/codex/client.test.ts` (request shape, fencing, lost-response policy), session event schema round-trip in `src/domain/session-events.test.ts`.

Validation: `bun test ./src/domain ./src/codex --isolate --max-concurrency=1` and `bun run typecheck`.

### Phase 2 — Claude /compact steering write

Deliver the Claude half behind the same event vocabulary.

- `src/claude/client.ts`: add `compact()` — writes one `claudeUserLine("/compact")` when the client is open and no turn is in flight; refuses with `INVALID_INPUT` on a closed client or an active turn (documented: compaction while a turn runs is not a supported v1 semantic).
- `src/claude/protocol.ts` / `assembler.ts`: parse the pinned stream-json compaction facts — `system` subtype carrying `status: "compacting"`, `compact_result`/`compact_error`, and `compact_boundary` if emitted — into a bounded compaction fact; unknown/again shapes degrade to the existing bounded-notice path, never throw on a live session.
- Surface the fact so the daemon persists `compaction` events (`outcome: "completed" | "failed"`, plus `trigger: "provider"` for provider-initiated compaction).
- Tests: `src/claude/client.test.ts` (write shape, refusal states), protocol/assembler tests for each compaction fact shape including the `compact_error` failure path.

Validation: `bun test ./src/claude --isolate --max-concurrency=1` and `bun run typecheck`.

### Phase 3 — session.compact command end-to-end

Deliver the durable command, runtime port method, and CLI surface.

- `src/daemon/ports.ts`: add `compact(input: { authority; providerThreadId; signal })` to `SessionRuntimePort`; implement in the Codex runtime adapter (via the live connection's `compactThread`) and the Claude runtime adapter (via `client.compact()`).
- `src/domain/contracts.ts`: add `session.compact` to the `LocalCommand` union — `{ kind: "session.compact", session: selectorSchema, idempotencyKey }`. Strategy selection stays out of v1: the provider's native compaction is the only dispatched effect.
- `src/daemon/service.ts`: dispatch — persist the command receipt bound to the session's current authority generation before dispatch, resolve the live provider binding, call `port.compact`, persist a `compaction` event with `outcome: "requested"`, `trigger: "manual"`. Reconcile a lost/indeterminate dispatch against the session's event stream before any retry; no speculative replay.
- `src/cli/parser.ts`: add `oompa session compact <session>` with `--idempotency-key` and `--json`, closed result `{ ok, sessionId, provider, requestId }`; update schema/help surfaces so `oompa schema --json` exposes it.
- Tests: contracts schema tests, parser tests, service dispatch tests (receipt-before-dispatch, generation fencing, idempotent redrive, refused-not-live session).

Validation: `bun test ./src --isolate --max-concurrency=1` and `bun run typecheck`.

### Phase 4 — Opt-in auto-compaction policy

Deliver the token_usage-triggered policy, default off.

- `src/domain/compact-policy.ts` (new pure module): `evaluateAutoCompact({ totalTokens, modelContextWindow, triggerTokens, minIntervalMs, lastCompactionAt, now })` → `{ action: "compact" | "observe", reason }`. Pure, total, bounded — colocate property tests.
- Managed config: an `autoCompact` section — `{ enabled: false, triggerTokens: 250_000, minIntervalMs: 300_000 }` defaults — parsed from `unknown` with bounds through the existing config path.
- At the `token_usage` persistence boundary (`service.ts` ~`#persistSessionEventWrites`): when enabled and policy says compact, enqueue the durable `session.compact` command with `trigger: "policy"` and an idempotency key derived from `(sessionId, turnId || usage-bucket)`; persist `compaction` `outcome: "requested"`, `trigger: "policy"`. Never dispatch while a turn is in flight; the dispatch itself is what rate-limits, not the observation.
- Tests: policy module property tests; service-level test that a crossing usage event enqueues exactly one command and a second event in the same bucket does not.

Validation: `bun test ./src --isolate --max-concurrency=1` and `bun run typecheck`.

### Phase 5 — Docs and closeout

- Update this plan's status/log, `kb/plans/AGENTS.md` Contents line, and `docs/providers/` compaction notes for both providers.
- Run `bun run check` as the final gate; record evidence here.

## Implementation log

- 2026-09-14: plan written; branch `devin/session-compaction` cut from `claude/oompa-v0.8.0` (435c2a43) in the `hra-worktrees/oompa` worktree.
