# Owned direct-child standard streams

`stdio-v1` composes the existing OOC1 observation reducer with bounded provider
stdin, stdout and stderr observations. This is a pure experimental module. It
does not open a descriptor, launch a process, write data, close a stream, or
admit production provider execution. OOC1 remains unchanged.

The native adapter owns separate provider descriptors. It must preserve the
helper's control channel isolation, enforce actual stream and retained-data
bounds, and supply only the following observed events. This module retains byte
counts and a bounded list of pending write IDs and sizes. It retains no provider
payload or diagnostic text.
The current owner builds this state from observed events. Serialized receipts
cannot restore transport authority or substitute for a missing observation.

## Native descriptor contract

The scripts-only native helper accepts `--transport=stdio-v1` as an optional
first argument, before the unchanged OOC1 arguments. Without it, the existing
null-stdio mode remains in effect. The helper's control stdin is descriptor 0,
status stdout is 1, and fixed diagnostic stderr is 2; their OOC1 framing and
finite frame counts do not change.

In stdio mode, the caller supplies independent inherited endpoints 3, 4 and 5
for target stdin, stdout and stderr. The child maps those endpoints to 0, 1 and
2. It closes its private gate descriptor 3 and incidental descriptors before
exec. After fork, the parent helper closes its copies of 3, 4 and 5. Native
FIFO/socket endpoint validation and descriptor custody are separate from this
pure reducer's observations.

`darwin-native.test.ts` contains the credential-free native fixtures. Its
explicit native flag and compiler invocation follow [the OOC1 fixture
instructions](./protocol.md#run-the-macos-fixtures). Ordinary test discovery
skips native execution. These instructions describe the experiment; native
qualification requires its own completed fixture receipt.

## API and limits

`createOwnedControllerTransport(binding, deadlines, limits, now)` creates one
observation. `observeOwnedControllerTransport(state, event, now)` returns the
next immutable observation. `ownedControllerTransportProof(state)` returns
limited completion evidence or `null`.

`OwnedControllerTransportLimits` specifies total `stdinBytes`, `stdoutBytes` and
`stderrBytes`, each from 1 through 1048576, plus `pendingWrites` from 1 through 16
and `pendingBytes` from 1 through 65536. A zero-data execution is valid within
these positive limits. Every event uses a monotonic integer millisecond clock.
The binding and startup, run and shutdown deadlines retain the OOC1 contract.

`OwnedControllerTransportEvent` is a closed union:

| Event | Observation |
| --- | --- |
| `controller` with `event` | An existing OOC1 event, including exact READY, successful GO/TERM sends, terminal, joined helper exit and finished control EOF. |
| `write_started` with `id`, `bytes` | One provider-input write is about to be attempted. IDs start at 1 and increase without gaps. |
| `write_settled` with `id`, `bytes` | The adapter observed successful local acceptance of exactly that write's full byte count. |
| `input_end` | One local close intent fences new provider-input writes before the close attempt. |
| `input_closed` | The adapter observed successful write-side finish followed by the exact owned input descriptor's close event. |
| `output` with `channel`, `bytes` | Positive bytes arrived on provider `stdout` or `stderr`. |
| `output_eof` with `channel` | That provider output descriptor reached clean EOF. |
| `input_error` | A write or close failed, completed ambiguously, or has an unknown result. |
| `output_error` with `channel` | A provider output descriptor failed. |
| `cancel` | Explicit cancellation fences input and begins bounded cleanup. |
| `tick` | The adapter checks the current deadline without another observation. |

## Ordering and settlement

The adapter records `write_started` before dispatch and proceeds only if the
returned observation remains admitted. Writes require observed READY and GO.
The GO event must describe the exact successful control write. A provider output
byte before GO is also a contradiction. Clean output EOF may precede READY or
terminal because descriptors complete independently, including a gated child
that never executed.

Each pending write settles exactly once with its original ID and full byte
count. A partial completion, error or unknown result poisons the observation.
Write settlement proves acceptance by the local pipe interface only; it does
not prove that the child read, interpreted or acted on those bytes. No failed
or ambiguous input is replayed by this module.

TERM, terminal, helper exit and cancellation immediately fence new input.
`input_end` remains available once after that automatic fencing. The adapter
must perform the actual close and report `input_closed`. A writable `end`
callback alone observes finish, so the native fixture adapter also destroys its
exact owned input wrapper and joins the close event before reporting closure.
A terminal frame does not manufacture either observation. Already pending
writes may settle after fencing or close observation, but they must all settle
before proof is possible.
Cancellation is cleanup intent, while owner loss and stream errors remain
uncertain. GO after cancellation refuses.

## Finite drain and proof

TERM, terminal, helper exit or cancellation starts a drain deadline no later
than the applicable OOC1 deadline or one shutdown budget from that event. Later
events never extend it. The transport checks this deadline even after the OOC1
reducer has completed, while either provider output or input settlement remains
missing. Completion at or after the deadline refuses. A complete observation
can retain its proof across later clock ticks; contradictory late events poison
it.

Transport completion requires the exact OOC1 terminal, successful joined helper
exit and clean control EOF, both clean provider-output EOFs, a successful actual
input close and zero pending writes. OOC1 proof alone is insufficient.

The result has scope `owned_direct_child_stdio_only` and includes the original
direct-child proof plus accepted input and observed output byte counts.
`providerConsumptionProven` and `replacementWriterAuthorized` are always false.
It proves no descendant containment, provider outcome, rollback, durable effect,
restart eligibility or authority for another writer. Native descriptor custody
and real-process fixtures remain separate acceptance requirements.

The native fixture driver retains cleanup ownership until its exact child and
published finite fixture descendants are absent and all four host wrappers for
descriptors 3 through 6 have emitted close. Descriptor 6 is an incidental test
endpoint that must never reach the target. A missing close leaves cleanup
unproven and retains the private fixture root; process-close alone is insufficient.
