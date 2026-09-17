---
name: oompa
description: Drive the Oompa CLI from another agent. Read status and events with --json, keep every mutation idempotent, and follow the shared Hraness credits handoff when hosted autorespond needs payment.
---

# Oompa

Oompa is a Bun CLI and local daemon that runs isolated Codex, Claude Code, and
Devin sessions with a provider-neutral transcript and optional encrypted sync.
Use `--json` on every command whose output you read; stdout carries one
versioned JSON document and stderr carries diagnostics. `oompa --help` lists
the command groups and `oompa help <group>` details one group.

Rules that apply to every command:

- Do not replay a failed or ambiguous mutation under another account. Inspect
  it first; reuse the same `--idempotency-key` only for the same request.
- Exit codes: `0` success, `2` invalid input, `4` not found, `5` unavailable,
  `6` interaction required, `7` recovery required, `1` any other failure.
- Approvals and answers a session is waiting for belong to the person unless
  autorespond is configured for that session.

## Hosted autorespond and credits

Prose autorespond can answer approval-only assistant turns through Oompa's
hosted backend, metered by prepaid Hraness credits held by the machine
(`oompa autorespond gateway set --hosted`). When that backend refuses a reply
for want of credits, `oompa autorespond status --json` exits `1`, sets
`error.code: "credits_required"`, and prints exactly one
`hraness-credits-required-v1` line on stderr. Follow
[references/credits.md](references/credits.md) for the four steps: show the
person the link and the price, offer to email the link, run `oompa credits
wait` after payment, then rerun `oompa autorespond gateway set --hosted`.
Never enter card details and never open the link yourself.
