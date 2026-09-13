# Claude account ceremony: manual browser handoff

Status: implementation, independent source review and focused validation passed.
Combined-candidate Required CI and the real owner ceremony remain pending. No real
authentication or daily-driver activation is claimed.

The previous foreground login opened the default browser, so its existing cookies
could select account A during the intended B login. Separate Claude config and
temporary roots do not isolate browser cookies.

## Change and boundaries

- Preserve production login and its environment allowlist. Only the separate
  qualification foreground binding injects `BROWSER=/usr/bin/true` at actual spawn.
- Authenticate `browserMode: owner_manual` in fresh 22-step native checkpoints.
  Preserve historical version-2 bytes and refuse their absent mode for new admission.
- Give concise preparation guidance before all four logins, using Enter for
  readiness. Preserve post-login identity challenges and interruption arming.
- Have the owner open a fresh private session and copy Claude's printed URL
  unchanged. Do not launch or inspect a browser, credentials, or OAuth exchange.
- Keep failed dispatched runs retired and retained. Add no replay, logout, profile
  adoption or root removal route.

## Acceptance and delivery

The pin-source receipt binds the exact reviewed executable and the browser-opener
call chain. Pure tests cover fixed environment construction, readiness refusal,
historical receipt bytes and authenticated mode admission. The explicit Darwin
PTY fixture must show the actual synthetic child receiving exactly the fixed
opener, while ordinary foreground children receive none; all children and terminals
must join. The fixture never invokes Claude or a browser.

Complete focused types, lint, independent review and unchanged Required CI before
source integration. The owner launcher must bind the admitted source and installed
closure and invoke pinned Bun with `--no-install`. Rebind it only after admission;
do not reuse the previous failed run or silently enable an older launcher.
The subsequent owner ceremony is the separate live authentication gate.

## Focused evidence

The five-file pure suite passed 52 tests with 4,429 assertions. The final narrowed
readiness and environment suite passed 18 tests with 346 assertions after the
Enter-only UX and attacher-environment regression were finalized. Strict types and
lint passed for all affected TypeScript, with final checks for those narrowed files.
The explicit Darwin fixture passed six cases with 24 assertions: eight workers and
eight PTYs closed, five direct children joined, tooling cleanup was proven, and
the fresh synthetic root was removed. No provider or browser was executed.
Managed repository guidance is current. Independent review covered the implementation,
historical receipt compatibility and exact pinned browser-opener precedence.

The first-login-only runner and the 17-step session authentication owner still use
the ordinary foreground binding. The restart ceremony's session seed shares that
owner. This change qualifies no manual-browser behavior for those separate paths.
