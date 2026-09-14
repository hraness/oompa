# Roadmap

This page summarizes the active Oompa plans for readers who want the provider and product direction without the implementation detail. The plan files record exact status; a release-candidate row is not a claim that its immutable release has been published.

## Direction

Oompa is a control plane for Codex and Claude Code. Codex runs through Oompa's exact packaged pin. Claude runs through a realpath-resolved installed executable whose exact self-reported version must match Oompa's compatibility pin; Oompa does not authenticate those executable bytes against an upstream package digest. Both use user-selected isolated profiles. Oompa owns the provider-neutral conversation and control record while each provider owns authentication, native sessions, execution, tools, approvals, and hidden state. Codex is supported on macOS and Linux; Claude Code is supported on Linux while authenticated isolated-Keychain and detached-read acceptance remains pending on macOS. Humans get a terminal shell and a keyboard-first web surface; agents get the same machine-readable CLI and work protocol.

## Waves

| Wave | Focus | What you will notice |
| --- | --- | --- |
| 0 | Robustness, security, boundaries | Published: bounded daemon concurrency, offline status and work protocol, hardened local and release custody. |
| 1–2 | Live projection and browser control | Published: encrypted live session projection, provider interactions, autorespond, browser devices, and remote commands. |
| 3 | Provider seam | Published in v0.5.0: reviewed Codex and Claude Code ports, a pinned Claude dialect, provider-tagged sessions, and provider-specific presets. Claude execution was still refused in that release. |
| 4 | Claude Code execution | Included in the admitted v0.7.0 artifact; runtime rollout remains gated. Start, turn, steer, stop, interaction, projection, queue dispatch, foreground Linux sign-in, and bounded sign-in status run through the selected provider. Exact-session resume requires proven prior-process exit or an already-completed exact release. Native listing, rename, usage, web sign-in, and protected turn inspection remain unavailable. |
| 5 | Conversation portability | Included in the admitted v0.7.0 artifact; runtime rollout remains gated. Oompa provides a neutral transcript, local and remote provider switching, and trajectory or JSON export. Switching preserves the Oompa record, not provider-native hidden state or cached context. |

## What Oompa will not do

- Rotate, pool, or fail over between accounts or providers automatically.
- Hold, read, or forward any provider credential.
- Route through a learned model router or a cost cascade.
- Pretend provider-specific features have parity: Codex account, usage, plugin, and native transcript operations remain Codex-specific until an independently reviewed Claude Code contract exists.
- Offer Claude login from the web surface. Codex web linking uses its provider-owned device-code flow.
