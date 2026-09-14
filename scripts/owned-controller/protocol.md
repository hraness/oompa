# Owned direct-child controller protocol 1

This experimental source boundary is not installed or used by the production
daemon. It defines a native helper's ownership of one direct child. Windows has
no admitted backend. This contract is separate from the Linux namespace
authority supervisor and does not inherit its containment claims.

## Native invocation and channels

The host selects and verifies the helper executable independently. It invokes
one helper with exact arguments:

```text
--nonce <nonce> --generation <generation> --startup-ms <startup> --run-ms <run> --shutdown-ms <shutdown> -- /absolute/fixture [arguments...]
```

The nonce is a fresh unpredictable 128-bit value encoded as 32 lowercase hex
characters. Generation and child PID are canonical decimal integers from 1 to
2147483647. Generation binds the caller's authority; it is not derived from a
PID. Startup and shutdown are each 1–30000 milliseconds; run is 1–86400000
milliseconds. The native helper owns finite monotonic deadlines independently
of host responsiveness. The protocol carries no paths, credentials, provider
payloads, arbitrary diagnostic text, or executable arguments.

Host commands use the helper's stdin. Helper frames use its stdout. Stderr is
reserved for fixed, bounded diagnostics. Before announcing READY, the helper
has created its direct child behind a private pre-exec gate. The child's stdin,
stdout, and stderr do not inherit these protocol channels, and inherited
control descriptors are closed. The child cannot write a helper frame or keep
the helper's control channel alive. Initial fixtures use `/dev/null` for the
child's standard streams. Production I/O transport is a separate future gate.

## Exact frames

Every frame is ASCII, at most 160 bytes including its final LF. There is exactly
one ASCII space between fields and exactly one final LF. CR, NUL, tabs, blank
lines, Unicode, leading/trailing spaces, extra fields, leading decimal zeros,
signs, and alternate numeric syntax are invalid. Each direction has at most two
frames and 320 total bytes, including an unfinished frame. A receiver retains
at most one 160-byte partial frame. EOF during a partial frame is failure.

```text
OOC1 READY <nonce> <generation> <childPid>\n
OOC1 GO <nonce> <generation>\n
OOC1 TERM <nonce> <generation>\n
OOC1 TERMINAL <nonce> <generation> <childPid> <released> <termination> <status>\n
```

The displayed `\n` means one LF byte. READY and TERMINAL flow helper to host;
GO and TERM flow host to helper. Version 1 permits no other frame. Future or
unknown versions are refused, never negotiated down.

`released` is exactly `0` or `1`. It reports whether the helper opened the
pre-exec gate after accepting GO. It does not prove that exec succeeded or that
the child performed any requested work. `termination` is `exit` or `signal`.
An exit status is 0–255; a signal is 1–127. These are the helper's exact owned
wait result, not observations of a possibly reused PID.

## Ordering and failure

The helper emits one READY after creating the gated child. The host may send
one GO, then optionally one TERM; or one TERM before GO. TERM before GO keeps
the gate closed. A duplicate GO/TERM, GO after TERM, malformed frame, mismatched
binding, oversize input, control EOF, or deadline expiry closes execution
admission. The helper must stop and reap its owned direct child within the
shutdown budget. It never accepts another handshake or spawns a replacement.

The helper may emit TERMINAL only after it has reaped its exact direct child.
A child that exits before GO can produce `released=0`. A GO-released child that
fails exec still produces `released=1`; its exit result does not describe a
provider outcome. There is at most one TERMINAL, with the READY PID and binding.
Protocol refusal must not be presented as a successful normal helper exit. A
terminal observation retained during refusal is cleanup evidence only.

The native implementation needs an owned-child mechanism that proves child
exit without reacquiring authority by PID. It must not send a signal to a PID
after relinquishing that ownership. Missing reap proof cannot produce a
TERMINAL frame.

## Host admission

The host parses frames with the bounded decoder and applies observations to
the pure reducer. It records GO/TERM only for its exact control send; an
ambiguous send or stream error poisons the observation. Events use a monotonic
safe-integer millisecond clock. The initial deadline includes waiting for GO;
GO begins the run budget; TERM begins the shutdown budget. Receiving TERMINAL
or observing helper exit starts at most one shutdown-budget join, capped by
the existing deadline. Later observations cannot extend that join.
Deadline expiry and a regressing or invalid clock are sticky uncertainty.

A direct-child proof requires all three observations for the same helper:

1. The exact valid TERMINAL after READY, with the expected nonce, generation,
   child PID, and released flag matching the host's GO observation.
2. The host has joined the helper process and observed exit code zero.
3. The helper's status stdout reached clean EOF after the terminal frame and
   after `decoder.finish()` proved no partial frame. This is `control_eof` in
   the reducer; it is not the host closing its command-input writer.

An exit notification may arrive before buffered status frames. The host still
waits for and validates the frames and EOF within its deadline. EOF without a
terminal frame, abnormal helper exit, duplicate observations, owner crash,
unknown helper status, parse failure, and missing terminal proof remain
uncertain. They cannot become success by later supplying a receipt. Do not
automatically restart or replay.

The proof's scope is `owned_direct_child_only`. It says nothing about detached
descendants, other processes, provider-side effects, remote rollback, account
authority, or another writer's eligibility. In particular,
`replacementWriterAuthorized` is always false. The existing session recovery
and provider authority contracts still decide whether another writer may run.

## Evidence and limits

Pure codec/reducer tests prove framing and observation rules. They do not prove
native ownership, actual pre-exec gating, deadline enforcement, signal handling,
or process collection. Each native backend needs independent real-process
fixtures, hostile channel/deadline/cancellation tests, binary provenance, and
an admitted host adapter before production use. The native helper and host
adapter must enforce the same version and limits without permissive fallback.

## Run the macOS fixtures

Use Bun 1.3.14 and an explicit native Zig 0.16.0 executable on macOS. Run this
command through the installed host scheduler's `mac-native` lane when present:

```sh
OOMPA_OWNED_CONTROLLER_NATIVE=1 \
OOMPA_OWNED_CONTROLLER_ZIG=/absolute/path/to/zig \
bun test ./scripts/owned-controller/darwin-native.test.ts
```

The test builds the helper and fixture in a private temporary directory,
records compiler, source and binary hashes, and checks actual child lifetimes.
Successful cleanup removes only that owned directory. Uncertain compiler or
fixture cleanup retains it for diagnosis. No provider executable or credential
is used. Ordinary test discovery skips these native cases; an ordinary test
pass is not native acceptance. Linux and Windows runs cannot establish macOS
acceptance.
