# Darwin detached authentication process port

This qualification-only boundary starts five fixed detached operations against one exact
executable: `auth status --json`, `--version`, `auth login --help`, `auth logout --help` and
`auth logout`. It has no CLI, production import or live qualification authority.
The native tests execute only the compiled synthetic fixture. Foreground login
remains the existing provider-owned terminal and signal-custody path.

## Binding and observation

`bindDarwinDetachedAuthProcess` captures the canonical executable's digest,
device/inode, mode, owner, size and timestamps, two different nonoverlapping
private temporary-directory identities, and an immutable allowlisted
environment. The real `HOME` is preserved; `CLAUDE_CONFIG_DIR`, `TMPDIR` and
`NO_COLOR` are fixed by the binding. Each spawn rechecks executable bytes and
identities synchronously. Factory arguments and environment must match exactly.
The caller separately owns candidate/source admission, provenance/signature
verification, exclusive native ownership, persisted mutation intent, fresh
binding authority and any provider effects. This binding proves none of those
external facts and cannot restore authority from a serialized receipt.

The port uses direct Bun 1.3.14 `detached: true` with ignored stdin and separate
stdout/stderr. A retained child handle owns signals and exit. Before admitting
output, it observes the same Darwin PID/start identity in two
fixed, bounded `/bin/ps -p PID -o pid=,lstart=,tdev=` snapshots, and checks native
`getsid(PID)` and `getpgid(PID)` equal the child PID before and after inspection.
`tdev` must be exactly `??`, representing `NODEV`. The `tty` field is unsuitable:
it also prints `??` when device-name lookup fails. Native queries use only
`/usr/lib/libSystem.B.dylib`; no helper executes the target.

Apple's primary implementation defines the
[tdev keyword](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/keyword.c#L200)
and its [NODEV rendering](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c#L564).
The installed Bun declaration documents POSIX setsid semantics for `detached`.
The native fixture must corroborate the pinned runtime with its own session,
process-group, stdin-EOF and `/dev/tty` ENXIO checks. A declaration or fixture
self-report alone does not prove an unchanged provider's detachment.

## Bounds and collection

Only after detachment, exact child exit and both clean output EOFs does the
factory expose bounded output to the existing authentication and version
collectors. The native port retains at most 16 KiB of stdout and 4 KiB of stderr;
the existing collectors retain their independent parsing and size checks.
An observation deadline of 100 through 5000 milliseconds supports adversarial
fixtures. A real auth qualification mapping must also satisfy its separate
3000-through-5000-millisecond status contract.

Failure requests TERM from the retained child, waits at most 100 milliseconds,
then requests KILL if the child has not joined. Child, detachment inspection and
stream settlement have finite follow-up bounds. Reader cancellation is recorded
separately from clean EOF and cannot manufacture an admitted result. Missing
native collection leaves cleanup uncertain. Any unadmitted observation poisons
binding reuse, even when cleanup joins; the port never retries an operation.
No signal targets a process recovered only from a stored PID.

Each `ps` snapshot also owns and joins its exact child and both bounded pipes.
Inspector timeout or parse failure cannot substitute a settled rejection for
native collection. The final receipt includes inspector-start and inspector-join
counts and an explicit `inspectionComplete` flag. Counts are authoritative only
after inspection completes; any unknown inspector cleanup prevents the target's
cleanup proof.

`settlement` contains bounded byte counts, declared and elapsed deadlines,
observed EOFs, child join and detachment facts. `admitted` must be true and
`cleanup` must be `joined` before a future private observer maps these into the
pure qualification contract. Exit code alone is insufficient. Raw bytes remain
inside the private caller's streams and never appear in the settlement receipt.
No result proves provider credential principal, absence of graphical prompts,
credential isolation, descendant containment, remote effects, replay authority,
daemon recovery, platform-policy acceptance or daily-driver activation.

## Observed overlap of two status children

`observeDarwinDetachedStatusOverlap(first, second, {signal, deadlineMs})` accepts
only two distinct actual process instances created by this boundary, both still
active and running the fixed status operation. It accepts no PID, structural
process substitute or asserted observation. Each instance participates at most
once. Invalid admission leaves its existing caller responsible for the targets.

The observer owns at most three additional fixed
`/bin/ps -p PID -o pid=,lstart=,tdev=,state=` children in the order A1, B, A2.
Each row must identify its retained target, have no terminal device and report an
ordinary running, sleeping, idle or uninterruptible state. Zombie `Z`, exiting
`E`, stopped, traced and unknown states refuse. The same A PID/start identity
must appear on both sides of B. Known target exit or interruption before or
after any native snapshot refuses. The
[Apple state renderer](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c#L428-L475)
defines the zombie and exiting flags.

The 100–1000 millisecond observation budget is shared by all three inspectors;
each uses the existing bounded inspector collector and its own exact cleanup.
Both original target settlements are then awaited, without replacing their
independent deadlines. A usable witness requires both ordinary admitted status
results and exact matching final detached identities, plus every added inspector
join. Cancellation signals only the retained target handles and cannot fabricate
EOF. No automatic retry or signal holds a target alive for this observation.

The additional inspector counts and cleanup are reported separately; each
individual target retains its existing two-inspector receipt. Both bindings
remain busy through the pair result and are poisoned by an unadmitted pair.
The implementation uses the internally retained settlement promises; replacing
a public promise or proxying an instance cannot supply authority.

This is bounded observational overlap under the existing retained-child and
second-resolution PID/start identity contract. It is not a stronger adversarial
PID-reuse proof, continuous lifetime monitoring, simultaneous CPU or Keychain
access, distinct credential principals, or live authentication qualification.
The future private pair observer must bind these two handles to its exact
run/attempt/probe/profile scopes, retain the native owner and persisted intent,
and join the individual metadata/status/metadata observations. This module adds
no observer hooks, live entrypoint, provider operation or production guard change.

## Tests

Ordinary `process.test.ts` checks closed operation arguments and the strict
Darwin terminal-device parser. `native.test.ts` is inert unless
`OOMPA_CLAUDE_MACOS_AUTH_PROCESS_NATIVE=1` and the absolute pinned Zig path is
supplied through `OOMPA_OWNED_CONTROLLER_ZIG`. Run that native suite through the
installed absolute `oompa-host-run` with `--lane=mac-native`. It builds only the
synthetic fixture in a private temporary root, keeps compiler recovery when
collection is unproven, observes only exact owned fixture identities and removes
the root only after all owned children and finite fixture descendants are gone.

## Foreground login factory

`binding.ts` holds the same executable, configuration, temporary-directory and
environment checks used by both process factories. It exposes no spawn operation.
`bindDarwinForegroundLogin` accepts only `auth login --claudeai`, the captured
environment, and the owner's descriptors 0, 1 and 2. Before spawn it checks that
all three descriptors remain character devices with the same captured device
identity, are terminals, and belong to the owner's foreground process group.
Native `tcgetpgrp`, `getpgrp` and `getsid` observations and descriptor metadata
are rechecked alongside the file binding immediately before dispatch.

The direct Bun child inherits that terminal and group. The factory creates no
new session, reads no prompt or output, and never closes the owner's descriptors.
It retains the actual child handle and admits only one attempt. After dispatch,
native wait failure stays uncertain; no post-spawn check can relabel an existing
child as `not_started`. `runClaudeForegroundLogin` and its existing signal custody
remain responsible for the ceremony: terminal Ctrl-C already reaches the group
and is not forwarded again; explicit abort forwards TERM once, followed by the
existing bounded forced join. An ordinary login has no artificial deadline.

The foreground settlement records direct-child collection and the verified owner
terminal request, never login success or credential principal. Future orchestration
must retain its persisted attempt and owner authority through the joined result,
then independently observe status. A joined login process is not sign-in evidence.

`foreground-native.test.ts` is inert without
`OOMPA_CLAUDE_MACOS_FOREGROUND_NATIVE=1`. Its fixed synthetic worker runs under a
private Bun PTY and inherits descriptors 0, 1 and 2 into the compiled fixture.
Only this credential-free test counts bounded synthetic terminal bytes. Tests
observe ordinary exit, explicit abort and forced join, real terminal Ctrl-C,
pre-spawn refusal and single-attempt ownership. Cleanup separately joins the
worker, its direct fixture child, PTY EOF and close, and IPC disconnect. Uncertain
setup or collection retains the private recovery root. The test worker is never
a live login entrypoint.

## Manual browser handoff for the account ceremony

The new 22-step account ceremony uses the separate named manual-browser binding.
It validates the ordinary fixed foreground request, then supplies only the fixed
`BROWSER=/usr/bin/true` to its actual child. Ambient browser commands and
`CLAUDE_BG_RENDEZVOUS_SOCK` remain excluded. The production environment allowlist,
ordinary foreground factory, terminal descriptors and signal ownership are unchanged.

This behavior is tied to the reviewed Darwin arm64 Claude 2.1.260 executable
SHA-256 `3c269f66801028823e24a63ced9fdd3988cb86cf85fccd9f03f87e463b9d3e3c`.
Read-only inspection of those exact bytes traced `auth login` through its OAuth
flow to the opener, which selects `BROWSER` before macOS `open`. The higher-priority
in-process attacher capability starts null and requires the rendezvous environment
input excluded by this boundary. The examined byte regions begin at offsets
176928800 (login), 171993011 (OAuth flow), 167702626 (opener), 155934580 (initial
capabilities), 155975700 (capability accessor), and 175487320 (rendezvous admission).
A changed provider artifact requires renewed source evidence; neither an environment
variable name nor the synthetic fixture alone establishes provider semantics.

The provider prints its own URL into the owner's terminal. Oompa does not capture,
rewrite, log or open it. Before each login, the owner closes prior private windows
and prepares a fresh private session; multiple private windows can share cookies.
The readiness response is Enter, not identity evidence. Existing post-login account
attestations and independent status observations remain required. The synthetic
Darwin child checks its exact environment and joins without starting a browser or
provider. Real owner authentication remains separate acceptance.
