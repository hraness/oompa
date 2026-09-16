# Contents

- Pin holds the one exact Devin CLI version, the shape of its `--version` line, the Astra model family the ACP server is asked for, and the ACP protocol version.
- Runtime discovery locates and version-admits the pinned `devin` executable with the same allowlisted environment pattern the other adapters use, and builds the exact `devin acp` argv.
- Process owns the isolated HOME/XDG environment for a managed profile and the direct Bun child-process bridge with piped ACP stdio.
- Auth projects `devin auth status` to one non-identifying readiness bit and runs the interactive foreground login with terminal-signal custody.
- Protocol validates ACP v1 JSON-RPC frames from `unknown`, owns the closed method vocabulary, and projects a small bounded fact vocabulary.
- Client owns one `devin acp` process, frames NDJSON itself, serializes writes, correlates requests, holds permission requests until an offered option is chosen, and refuses concurrent prompts.
- `usage-panel.ts` parses the panel the pinned CLI renders for `/usage` into a closed observation: weekly and optional daily windows with used and remaining percent and a resolved reset instant, the banner plan name, and an optional extra-usage balance. Every other shape is an explicit `unknown` with a closed reason.
- `usage-driver.ts` drives the CLI on a pseudo-terminal far enough to render that panel and then exits it. It types only `/usage`, Enter, `/exit` and Enter.
- `usage-panel.fixture.json` is the reviewed capture from the pinned build plus labelled synthetic variants. It is not packaged.

# Guidelines

- Pin one exact Devin CLI version. Neither the `/usage` panel nor the ACP server's exact behaviour is a published contract, so refuse any other build and re-capture the fixtures before changing the pin.
- Keep this provider boundary self-contained. Wire values never cross it; only projected Devin facts and the usage observation do. No external ACP SDK: Oompa frames and bounds every line itself.
- Never submit a prompt from the usage driver. It waits for the input prompt before typing a slash command, sends nothing else, and fails closed when the workspace-trust prompt appears instead of bypassing it interactively.
- Override HOME and every XDG directory for a managed profile. Never read, copy, return, or log credentials or account identity; auth status projects one boolean.
- Parse from `unknown` with explicit bounds on every inbound line, string, array, identifier and number. A missing, repeated-but-different, malformed or unknown value produces a bounded notice or a closed refusal, never a partial or inferred value.
- Ignore unknown vendor notifications only after validating and bounding the JSON-RPC envelope. Reject malformed recognized ACP frames and close the client rather than parsing them hopefully.
- Keep queueing and steering policy outside this directory. One prompt per process may be active.
- Tests use fake processes and protocol peers. Never issue a paid prompt from the test suite.
- This layer is not yet wired into the daemon's provider selection, CLI, or storage. Retired-provider refusals stay in force until the plan's later phases lift them with append-only migrations and independent review.
