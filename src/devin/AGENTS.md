# Contents

- Pin owns the exact externally installed Devin CLI version, Astra model family, ACP protocol version, and the shape of the `--version` line.
- Runtime locates and version-admits that executable, constructs the exact ACP argv, and filters an ambient environment for the usage driver.
- Process owns the isolated HOME/XDG environment and direct Bun child-process bridge.
- Auth projects status to a boolean and runs interactive login with terminal-signal custody.
- Protocol validates ACP v1 values from `unknown` and projects a small bounded fact vocabulary.
- Client owns one ACP process, serializes writes, correlates requests, and refuses concurrent prompts.
- `usage-panel.ts` parses the panel the pinned CLI renders for `/usage` into a closed observation: weekly and optional daily windows with used and remaining percent and a resolved reset instant, the banner plan name, and an optional extra-usage balance. Every other shape is an explicit `unknown` with a closed reason.
- `usage-driver.ts` drives the CLI on a pseudo-terminal far enough to render that panel and then exits it. It types only `/usage`, Enter, `/exit` and Enter.
- `usage-panel.fixture.json` is the reviewed capture from the pinned build plus labelled synthetic variants. It is not packaged.

# Guidelines

- Keep this provider boundary self-contained. Wire values never cross it; only projected Devin facts do.
- Require Devin CLI `3000.10.27`, ACP v1, and model `gpt-6-astra`; fail closed on drift.
- Pin one exact Devin CLI version for the usage reader too. The `/usage` panel is a human-facing surface, not a published contract; re-capture the fixture before changing the pin.
- Override HOME and every XDG directory for ACP sessions. The usage driver is the one exception: it reads the caller's own login, so it filters the ambient environment through the reviewed allowlist instead.
- Never submit a prompt from the usage driver. It waits for the input prompt before typing a slash command, sends nothing else, and fails closed when the workspace-trust prompt appears instead of bypassing it interactively.
- Never read, copy, return, or log credentials or account identity. Retain only the parsed observation and the exact version line; never forward the Devin credentials file or a session identifier from the panel.
- Bound each inbound line and every projected string, array, identifier, and number.
- Parse panel output from `unknown` with explicit bounds. A missing, repeated-but-different, or malformed line produces an `unknown` observation with a closed reason, never a partial or inferred value.
- Ignore unknown vendor notifications only after validating and bounding the JSON-RPC envelope.
- Reject malformed recognized ACP frames and close the client rather than parsing them hopefully.
- Keep queueing and steering policy outside this directory. One prompt per session may be active.
- The usage reader is not yet wired into the daemon, CLI, or storage; later phases of `kb/plans/devin-provider.md` wire it with independent review.
- Tests use fake processes and protocol peers. Never issue a paid prompt from the test suite.
