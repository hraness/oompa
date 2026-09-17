# Codex provider notes

## Compaction (shipped, `session.compact`)

Oompa compacts a live Codex session through the app-server's own `thread/compact/start` request: the provider's native compaction, never transcript surgery. Verified against the pinned `@openai/codex` 0.153.2 binary and its generated JSON schema (`codex app-server generate-json-schema`):

- `ClientRequest::ThreadCompactStart` takes `ThreadCompactStartParams = { threadId: string }`. The operation is declared `thread-mutation` with a 30s deadline and reconcile-on-loss policy (`src/codex/protocol.ts`), called through the fenced `compactThread(threadId)` client method.
- The legacy `thread/compacted` notification (`ContextCompactedNotification = { threadId, turnId }`) is deprecated in the v2 schema but still routed: it maps to a `compaction` timeline event. The current signal is a `ThreadItem` of type `"contextCompaction"` arriving through the normal item stream; both shapes reduce to the same provider-neutral event.
- A compaction requested through `oompa session compact` or the per-session auto-compact policy (`oompa session compact-policy <session> on`) is recorded `outcome: "requested"`, `trigger: "manual" | "policy"` before dispatch; provider-initiated compaction records `trigger: "provider"`. An indeterminate dispatch reconciles against the session's event stream rather than replaying.
- Both providers admit compaction only between turns; a request during an in-flight turn is refused before the effect begins.
