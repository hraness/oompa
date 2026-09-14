# Native byte-process protocol 1

Status: implementation contract, pending native and consumer qualification. This private controller is invoked by a product-owned adapter. It grants no provider, account or filesystem authority.

The adapter returns an owned handle before asynchronous launch. Its promises separately expose readiness, root exit, final join and error-free byte delivery. Each invocation owns fresh controller pipes and a fresh 32-character lowercase hexadecimal nonce. The native owner clears its ambient child environment and uses only the supplied launch environment. Paths, environment values and provider bytes never enter diagnostics or receipts.

## Framing

Every frame is one kind byte, an unsigned 32-bit big-endian payload length, then exactly that many payload bytes. Reject excessive lengths before allocation. EOF between commands means controller loss; partial headers or bodies are protocol failures. Input and output parsers are independently bounded. JSON control bodies are strict UTF-8 with exact fields. Raw provider bytes are never interpreted as JSON by this component.

| Command | Payload | Rule |
| --- | --- | --- |
| 1 Launch | JSON launch object below | First command, once; prepare an anchor without executing the provider |
| 2 Write | 4-byte monotonically increasing ID followed by provider bytes | IDs start at 1; one outstanding write; no reuse or rollover |
| 3 CloseInput | Empty | Fence writes before closing; repeated intent cannot reopen input |
| 4 Stop | Empty | Fence writes, close input, request graceful scope termination |
| 5 ForceStop | Empty | Fence writes and request forced scope termination |
| 6 Activate | Empty | Once, after the product durably commits Prepared; permit provider execution |

| Event | Payload | Meaning |
| --- | --- | --- |
| 129 Ready | Prepared fields plus `{pid,root}` | Actual provider root established; pid equals root.pid |
| 130 Stdout | Raw bytes, 1–65536 bytes | Ordered provider stdout |
| 131 Stderr | Raw bytes, 1–65536 bytes | Ordered provider stderr |
| 132 WriteResult | JSON `{id,outcome,acceptedBytes}` | `accepted-full`, `refused-before-write`, `partial-known`, or `indeterminate` |
| 133 RootExit | JSON `{code,signal}`, exactly one non-null | Root exit observed; not final custody proof |
| 134 Joined | JSON `{version:1,nonce,scope}` | Root collected, native streams reached EOF, writes settled and scope closure observed |
| 135 Failure | JSON `{reason}` | Operation failure; does not itself decide physical custody |
| 136 StreamEnd | One byte: 1 stdout, 2 stderr, 3 stdin | Actual owned stream completion, distinct from consumer cancellation |
| 137 NotStarted | JSON `{version:1,nonce,scope}` | Provider never spawned; any prepared anchor was collected and its scope closed; owner irrevocably fenced |
| 138 Prepared | JSON `{version:1,nonce,scope,groupId,boot,supervisor,anchor}` | Exact supervisor and prepared group anchor; provider has not executed |

Closed failure reasons: `invalid-launch`, `invalid-frame`, `unsupported-scope`, `spawn-failed`, `write-failed`, `output-failed`, `controller-lost`, `deadline`, `cleanup-unproven`. Bounded native diagnostics can identify these reasons but cannot include native error strings or input values.

Launch is `{version:1,nonce,scope,argv,cwd,environment,termGraceMs,settlementMs,writeTimeoutMs}`. Every field is required. Initial Unix scope is `posix-process-group`; a Windows backend must implement and qualify `windows-job` before accepting it. Other scopes refuse before spawn. argv contains an absolute executable and at most 255 arguments; cwd is absolute. Reject NULs. Limit the launch frame to 256 KiB, each argv/environment string to 32 KiB, and environment to 256 entries with ASCII keys matching `[A-Za-z_][A-Za-z0-9_]*`. termGraceMs and settlementMs are 1–30000; writeTimeoutMs is 1–60000. The product separately admits platform paths and executable provenance.

Prepared and Ready carry observed identities, never reusable numeric signaling authority. Darwin boot identity is `{platform:"darwin",id}` with a lowercase boot UUID; process identity is `{pid,birth:{kind:"darwin-start-time",seconds,micros}}`. Linux boot identity additionally has `pidNamespace:{device,inode}`; process birth is `{kind:"linux-start-ticks",ticks}`. Seconds, ticks, device and inode are canonical unsigned 64-bit decimal strings. Micros is 0–999999. Every PID is greater than one and fits signed 32 bits; supervisor, anchor and root are distinct. PID 1 scopes deliberately refuse because their group probe would gain the special minus-one meaning. groupId equals anchor.pid. Birth kinds agree with the boot platform. Ready repeats the exact Prepared tuple. The host also binds supervisor.pid to its actual child handle.

Control JSON events are at most 4096 bytes. Write has at most 64 MiB plus its 4-byte ID, independent of 64 KiB output chunks. A zero-byte write consumes its ID and succeeds with zero accepted bytes. Only one provider write can be in flight; overlapping or reused IDs fail. Full acknowledgement follows acceptance of every byte by the child pipe; flushing the helper input is insufficient. Refusal before writing differs from partial or unknown dispatch. Exhausted IDs refuse without replay. No later authorized write may queue behind an unacknowledged frame.

The first launch, each incomplete frame and Prepared waiting for Activate have fixed monotonic 30-second deadlines. Established sessions may remain idle between complete commands. Controller hangup is observed independently of frame assembly. Destroying the exact host-owned controller writer is the out-of-band cancellation path: it fences new child writes, cancels partial frames and begins bounded cleanup while the host keeps reading observations. Stop cannot provide cancellation while queued behind a large Write body. Windows must qualify an equivalent independent mechanism.

## Durable activation and delivery

Before helper creation the product reserves an invocation in its existing durable store. Launch creates only an anchor. The host commits Prepared, checks current authority, then sends Activate. It commits Ready before provider initialization or the authority-checked write dispatcher. Slow or failed persistence never blocks native observation. A late commit cannot activate a retired scope or reopen writes after root exit or failure.

The native adapter refuses writes before readiness. It never awaits readiness or queue capacity after the product's last authority check. Stop, ForceStop, CloseInput and owner loss fence writes that have not physically begun. Dispatched bytes retain the product's uncertain-effect policy.

Host deadlines operate independently of the native event loop. Missing write acknowledgement yields an indeterminate result; it does not become refused-before-write. Input-close acknowledgement and startup are also bounded. Helper exit starts bounded drainage even when a full JavaScript queue prevents parsing later events. Native Failure remains observable to byte consumers and the transport-completion promise after physical join is proved.

Bound output buffering to 1 MiB per provider stream and finite controller framing overhead. Apply backpressure instead of a cumulative output ceiling. Byte delivery completes only after native EOF and delivery of buffered chunks. Consumer cancellation does not manufacture EOF or erase discarded output. Stop may drain and discard bytes to establish native EOF, while preserving explicit delivery failure. A blocked consumer cannot keep shutdown pending beyond its settlement budget.

## Ownership and proof

The native owner retains the process scope through startup, delivery, cancellation and collection. Unix group membership does not prevent descendants from escaping into another group or session; proof is limited to the named scope. A separate anchor is group leader and stays live or unreaped through every external group signal. Collecting the provider root cannot authorize signaling a recycled group number. Preserve the official launcher/native-child topology.

The anchor ignores TERM and owns only the reader of a private supervisor-death pipe. The supervisor owns its sole writer. Provider exec inherits neither endpoint nor any non-stdio descriptor. The anchor also observes hangup on a duplicate controller reader without consuming frames. Supervisor death or controller-writer closure makes the anchor terminate its own live group, independently of supervisor scheduling. Qualification requires actual same-birth provider/anchor exit observations while the supervisor remains stopped; resuming it first is insufficient evidence. The anchor re-executes the admitted immutable binary path. Installation must prevent replacement of those versioned bytes during anchor creation.

RootExit occurs independently of stream completion. Natural root exit closes input and starts bounded scope cleanup. Joined requires root collection, native stdout/stderr EOF, closed stdin, no pending writes and scope closure. Operation Failure can precede valid Joined; identity or closure uncertainty cannot. The host accepts physical settlement only after matching nonce/scope, successful exact-helper exit, clean framed EOF and closed diagnostic pipe. NotStarted proves only no-spawn custody, never operation success. Helper exit alone never resolves custody. Missing terminals, truncated output, failed helper exit or uncertain collection preserve the replacement-writer barrier.

Recovery uses retained Prepared identity, artifact/runtime digests and invocation generation. Release requires trusted live join or actual host observations of closure. A different boot UUID on another machine proves nothing about the original machine. A reserved invocation without retained Prepared cannot be cleared merely because that identity is missing. Simultaneous anchor/supervisor loss requires observation-only recovery, never saved-PID signaling. Product mapping distinguishes native NotStarted with a prepared-and-closed scope from a reservation that never prepared one. No event authorizes replay, account movement, recovery deletion or a replacement writer.

## Observation modes

`--host-context` and `--observe-custody` are internal, one-shot modes of the same admitted executable. They accept no extra arguments. The zero-argument launch mode and its frame meanings remain unchanged. Neither observation mode accepts Launch, Activate, Write or Stop, creates a provider process, opens a product database, reads provider homes/command lines/environment tables, or sends a nonzero signal. No request can select a filesystem path. The product owns release policy and the durable proof capability.

Each observation invocation accepts exactly one frame, then requires stdin EOF before observing anything. Use the existing one-byte kind and four-byte big-endian payload length. Input and output payloads each have a 65,536-byte limit. A fixed native monotonic two-second deadline covers assembly, required EOF, observation and output. The host must independently bound the actual helper lifetime. It accepts only one complete matching response, clean stdout/diagnostic EOF and exact helper exit zero. Extra bytes, unknown/duplicate fields, malformed identities, wrong frame kind, truncation and missing EOF refuse. Failure uses event 135 with an existing closed reason when output remains available, then nonzero exit; a deadline or unavailable output may end without a failure frame. Unknown CLI modes and extra arguments exit nonzero without launching.

Native deadline checks bracket synchronous OS observations; they cannot preempt a syscall that fails to return. The independent host deadline may terminate only its exact owned observation child. Failure to collect that child remains cleanup uncertainty and never releases a prior provider-writer barrier.

| Mode | Request kind and required JSON | Response kind and required JSON |
| --- | --- | --- |
| `--host-context` | 7: `{version:1,requestId}` | 139: `{version:1,requestId,context}` |
| `--observe-custody` | 8: `{version:1,requestId,context,targets}` | 140: `{version:1,requestId,context,relation,targets}` |

`requestId` is 32 lowercase hexadecimal characters and must be fresh per invocation. `context` is `{host:{platform,digest},boot}`. `host.platform` is `darwin` or `linux` and equals `boot.platform`; `digest` is 64 lowercase hexadecimal characters. The response contains the currently observed context. Boot retains the existing native schema, including the Linux PID namespace. Context is captured before and after the observation; unavailable or changed context invalidates the complete batch.

The host digest is HMAC-SHA-256 with the fixed native-runtime application key `hraness.native-process.host-context.v1`, over ASCII platform, one NUL byte, and the 16-byte OS machine identity. This stable native-runtime identity contains no provider or product policy. Darwin uses `gethostuuid` with a nonzero 100 ms timeout. Linux reads only a regular, root-owned, non-group/world-writable `/etc/machine-id`, limited to 33 bytes with exact lowercase hexadecimal/newline form. An all-zero machine identity refuses. Raw machine identifiers never leave Rust. A machine digest is a local observation under the OS's unique-machine-identity assumption; it is not cryptographic attestation of a cloned or spoofed machine. Product recovery also validates its actual held daemon lock and local store identity.

An observation request has 1–16 targets with unique nonces, in the order to be returned. Every target is `{nonce,bindingDigest,expectedRevision,prepared,ready}`. `nonce` is 32 lowercase hex, `bindingDigest` is 64 lowercase hex, `expectedRevision` is an integer 1–5, and `ready` is required and either a complete Ready tuple or null. Prepared must have the same nonce and boot as the request context. A nonnull Ready repeats the exact Prepared tuple. Observed scope identities require PIDs greater than one; group zero and minus-one semantics are never admitted. All decimal birth and namespace strings retain canonical unsigned 64-bit bounds.

Response `relation` is `same-boot`, `boot-ended`, `foreign-host`, or `foreign-scope`. Different host digests/platforms give `foreign-host`. The same host and different OS boot IDs give `boot-ended`. A matching host and boot ID with changed Linux PID namespace gives `foreign-scope`. Only `same-boot` performs PID or process-group observations. Every other relation returns unknown target statuses; the product must not interpret those statuses as process absence.

Each response target is `{nonce,bindingDigest,expectedRevision,supervisor,anchor,root,group}`. The first three fields echo the exact request. Supervisor and anchor are `same-process-present`, `original-absent`, or `unknown`; root uses that same vocabulary when Ready was provided and is otherwise null. Group is `present`, `absent`, or `unknown`. Host code validates exact target count, order and echoed binding before admitting evidence.

An original process is absent only after exact ESRCH from a zero-signal existence probe, or a successfully observed different birth at the same PID. A known root is inspected without assuming it stayed in its original group. Errors, permissions, unavailable birth records and held zombies remain present or unknown. Group absence requires exact ESRCH from `kill(-groupId,0)`; EPERM is never absence. The original supervisor is observed before the group, and product recovery must require its absence to rule out future activation. These observations cannot reacquire live signaling authority, claim old pipe EOF, or fabricate Joined. In particular, `ready:null` can describe a provider executed after Activate whose Ready was never committed.

## Acceptance

Use credential-free launchers that spawn a native child, block input, refuse TERM, emit concurrent output, retain inherited pipes and exit at controlled boundaries. Exercise controller/helper loss, stopped-supervisor cancellation, malformed/truncated/duplicate frames, exact write bounds, partial/unknown writes and signal/reap races. Assert root events, byte delivery, native EOF and final scope proof separately. Mac, Linux and Windows each require actual native evidence before admission.
