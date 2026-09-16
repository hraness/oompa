# Claude Code stream-json fixtures

`cli-host-tools-2.1.260.txt` records the exact package and executable digests
used to prove that the pinned runtime exposes the append-system-prompt and MCP
configuration flags HRA needs for session-bound host tools. It retains the
complete snapshot paragraph because passing an append changes the default
snapshot behavior and resume semantics.
Its exact SHA-256, together with the handshake fixture digest, is pinned in
`src/claude/pin.ts` so edits require an explicit evidence review.
`mcp-handshake-2.1.260.jsonl.txt` is the exact three-frame startup request
sequence the pinned native CLI sent to a local stdio capture server. It proves
the requested MCP revision and client identity before the bridge admits calls.

`stream-json-compaction-2.1.270.jsonl.txt` is a curated reconstruction of the
`/compact` steering sequence verified on Claude Code 2.1.270: `status:
"compacting"`, the `compact_boundary` marker, the `status` envelope's
`compact_result`/`compact_error` outcome fields, the post-compact `init`, and
a second compaction failing on a too-short conversation. Session and event
ids are synthetic.

Captured 2026-09-03 for the D3/W3 Claude adapter spike documented in `../claude.md`. `output-json-unauthenticated.jsonl.txt` and `output-json-authenticated.jsonl.txt` are `claude -p --output-format json` results from this machine (Claude Code 2.1.260); `stream-json-single-turn.jsonl.txt` is one `claude -p --output-format stream-json --input-format stream-json --verbose --max-turns 1` run on this machine. `bb-control-protocol-examples.jsonl.txt` is a curated, redacted subset of the `control_request`/`control_response`/subagent `system` events recorded in `get-bb/bb`'s `packages/provider-bridge-protocol/recordings/claude-code/{approval-allow,approval-deny,user-question,subagent}` fixtures (MIT licensed), reformatted one JSON object per line. All files have absolute filesystem paths replaced with `<redacted-...>` placeholders; no credentials or private session content are included.
