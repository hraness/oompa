---
title: Oompa knowledge base
type: index
---

# Oompa knowledge base

## Plans

- [Oompa v1](plans/oompa-v1.md)
- [Cross-platform daily driver](plans/cross-platform-daily-driver.md)
- [Personal-home session adoption](plans/session-adoption.md)
- [Oompa v2](plans/oompa-v2.md)
- [Model routing and bounded autonomy](plans/model-routing-autonomy.md)
- [Oh memory and session civilization](plans/oh-memory-civilization.md)

## Notes

- [Agent-first coordination substrate](notes/agent-first-coordination.md)
- [Oompa seed prompt](notes/oompa-seed-prompt.md)
- [Web surface UX contract](notes/web-ux.md)

<!-- kb:catalog:start -->
## Note catalog

### Notes

- [[notes/agent-first-coordination|Agent-first coordination substrate]] — The durable, bounded Oompa protocol for coordinating parallel Codex sessions.
- [[notes/codex-schedules|Codex scheduled tasks (automations) ground truth]] — Where Codex Desktop stores recurring automations, how they land in sessions, and why their metadata stays private except for a narrow local adoption age gate.
- [[notes/codex-subagent-activity|Codex subagent activity on the pinned app-server]] — What Codex 0.153.2 does and does not expose about spawned subagents over the app-server protocol, and exactly which parts Oompa projects as subagentactivity.
- [[notes/conversation-scheduled-tasks|Conversation-bound scheduled tasks]] — Oompa will support scheduled task creation, inspection, editing, pausing, resuming, and deletion as local session tasks. A session task is owned by one immutable Oompa session and may…
- [[notes/oompa-seed-prompt|Oompa seed prompt]] — The written product seed for a minimal multi-account Codex CLI.
- [[notes/web-ux|Web surface UX contract]] — The keyboard-first, TUI-style interaction contract for the Oompa browser surface, an enrolled device that renders the compact projection and submits remote commands.

### Plans

- [[plans/auth-hardening|Authentication review and hardening]] — Status: implementation, independent review, current-main integration, and immutable artifact admission complete. Live provider and runtime rollout gates remain separate. The…
- [[plans/effect-provider-session|Codex provider-session Effect runtime]] — Design: issue 118.
- [[plans/devin-provider|Devin provider and preset authority]] — On 2026-09-06 the user made verified remaining account quota and reset reporting a condition of provider support. Current official CLI/ACP documentation does not provide that…
- [[plans/ui-marketing-docs|Oompa product website and documentation]] — Status: implemented; final integration and delivery pending. Owner: Hraness. Source checked: 2026-09-08. Reassess: 2026-10-20.
- [[plans/oompa-v1|Oompa v1]] — Status: in-progress. Release plan for a persistent Codex and Claude Code control plane for humans and agents, with isolated profiles, a provider-neutral transcript, bounded work coordination, durable…
- [[plans/oompa-v2|Oompa v2]] — Status: proposed. Proposed plan to make Oompa a provider-neutral control plane for humans and agent swarms, covering the agent CLI contract, a keyboard-first web surface, robustness and…
- [[plans/hra-web-v1|Oompa Web v1: session grid, steering, autorespond, open beta]] — Status: proposed. Plan for the first real Oompa web app (a mobile-friendly grid of live sessions with steering, approvals, model choice, archive), the session-state classifier and autoresponder that…
- [[plans/delivery-autonomy|Hraness delivery autonomy]] — Status: active. Active plan for reducing routine Codex, Claude Code, npm, and GitHub approval interruptions without weakening repository or provider gates.
- [[plans/hosted-bootstrap-memory-status|Include memory tables in hosted bootstrap status]] — Status: in-progress. The bounded projection must observe every hosted table, including and . An otherwise empty deployment with an orphan memory row must be inconsistent. A valid initial bootstrap…
- [[plans/model-routing-autonomy|Model routing and bounded autonomy]] — Status: in-progress. Active phased plan for Ultra defaults, conservative shadow routing, notification timing, shared remote-action policy, and evidence-gated autonomy.
- [[plans/oh-memory-civilization|Oh memory and session civilization]] — Status: in-progress. Active delivery plan for stable two-authority Oh memory, attributed same-project session coordination, provider-native Oompa tools for Codex and Claude Code, encrypted…
- [[plans/canonical-profile-persistence|Persist exact historical profile identity]] — Status: complete. Persist the seven already represented provider/model/effort identities across sessions and Work without changing public selectors, runtime evidence or model admission. This is the…
- [[plans/session-adoption|Personal-home session adoption]] — Status: completed. Delivery plan for automatically adopting Codex and Claude Code sessions from the owner's normal provider homes without weakening Oompa session authority.
- [[plans/attention-email-key-separation|Separate attention email credentials from sign-in]] — Status: in-progress. Isolate attention delivery credentials and prove configuration before consuming an outbox attempt.

<!-- kb:catalog:end -->
