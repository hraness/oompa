# Contents

- Pin holds the one exact Devin CLI version and the shape of its `--version` line.
- Runtime discovery locates and version-admits the pinned `devin` executable with the same allowlisted environment pattern the other adapters use.
- `usage-panel.ts` parses the panel the pinned CLI renders for `/usage` into a closed observation: weekly and optional daily windows with used and remaining percent and a resolved reset instant, the banner plan name, and an optional extra-usage balance. Every other shape is an explicit `unknown` with a closed reason.
- `usage-driver.ts` drives the CLI on a pseudo-terminal far enough to render that panel and then exits it. It types only `/usage`, Enter, `/exit` and Enter.
- `usage-panel.fixture.json` is the reviewed capture from the pinned build plus labelled synthetic variants. It is not packaged.

# Guidelines

- Pin one exact Devin CLI version. The `/usage` panel is a human-facing surface, not a published contract, so refuse any other build and re-capture the fixture before changing the pin.
- Never submit a prompt. The driver waits for the input prompt before typing a slash command, sends nothing else, and fails closed when the workspace-trust prompt appears instead of bypassing it interactively.
- Parse from `unknown` with explicit bounds. A missing, repeated-but-different, or malformed line produces an `unknown` observation with a closed reason, never a partial or inferred value.
- Retain only the parsed observation and the exact version line. Never read, copy, log, or forward the Devin credentials file or any session identifier from the panel.
- This layer is not yet wired into the daemon, CLI, or storage. Retired-provider refusals stay in force until the plan's later phases lift them with append-only migrations and independent review.
