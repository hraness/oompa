# Claude account ceremony: manual browser handoff

Status: the qualification-specific manual-browser implementation passed independent
source review and focused validation. The product foreground option below also
passed independent source review and focused validation. Combined-candidate Required CI and a
complete corrected owner ceremony remain pending; daily-driver activation is not
claimed.

On 2026-09-13 the earlier real ceremony authenticated A, but its ordinary browser
reused A during the intended B login. The owner correctly refused the distinct-B
attestation. Its processes joined and its owner released; the failed run remains
retained and recovery-only. This is partial authentication evidence, not completed
account isolation or evidence for the corrected handoff.

The previous foreground login opened the default browser, so its existing cookies
could select account A during the intended B login. Separate Claude config and
temporary roots do not isolate browser cookies.

## Change and boundaries

- Keep the qualification foreground binding separate from production login. It
  injects `BROWSER=/usr/bin/true` at actual spawn without widening the ordinary
  environment allowlist.
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

## Product foreground option

Normal `oompa account login <profile> --provider claude --manual-browser` now
selects the same fixed opener as an opt-in local presentation. The default is
unchanged. The CLI captures the closed mode before its first await and carries
it with the exact granted account, attempt, key and generation. The foreground
helper independently captures mode and profile before runtime resolution, then
adds only the fixed opener after ordinary environment allowlisting. Missing
opener or unsupported host refuses before launch without fallback. The daemon's
request, grant, completion and status schemas do not change, and recovery never
relaunches or infers mode from historical receipts.

The CLI writes concise intended-profile/private-session guidance before Claude
starts and adds no stdin owner. The managed Mac and Windows admission guards
remain in force. Parser, environment, mutation-during-await, signal/custody and
same-key recovery tests, plus the existing six-case Darwin foreground native
fixture, must pass on these changed inputs. No live provider handoff is exercised
by these checks. Source review, final package inspection and Required CI remain
separate delivery gates.

The product-option checks passed 101 parser/authentication/qualification-boundary
cases with 5,955 assertions and 27 focused CLI cases with 239 assertions. A
forbidden type-only provider import was removed from the CLI parser; its final
74-case parser rerun passed 5,357 assertions, and final strict types and lint
passed. The native fixture reran against the changed foreground helper and passed
all six cases with 24 assertions: eight workers and eight terminals closed, five
direct children joined, and the synthetic root was removed. Independent review
confirmed the type-only repair leaves runtime behavior unchanged. None of these
checks invoked Claude, a browser or real authentication; the CLI startup cases
used synthetic local state. Actual archive/installation validation, current-base
Required CI and the corrected owner ceremony remain pending.
