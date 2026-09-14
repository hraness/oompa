# Live acceptance

This optional authenticated qualification uses two complete Oompa daemon installations. It is not a prerequisite for tagging or publishing Oompa artifacts under the [machine-gated release policy](beta-release.md). A passing build, installation or artifact admission does not prove that this live scenario passed. The harness does not simulate a second device with two cloud-control objects, replace `HOME`, create temporary macOS users, or write acceptance credentials to Keychain.

This harness is repository-only. It lives under `scripts/`, is excluded from the npm package, and does not add a state-root, socket, capability, or alternate-installation option to the production CLI.

## Isolation

`startLiveAcceptanceRun()` creates one canonical mode-`0700` run directory below the canonical operating-system temporary directory. It creates four distinct direct children:

- one state root for device A;
- one state root for device B;
- one project directory for device A;
- one project directory for device B.

Every child is a canonical mode-`0700` directory owned by the invoking user. The harness records the device and inode of each directory before it starts either worker. It refuses any run directory that overlaps the production Oompa state root or the invoking home in either direction.

Each worker receives one strict installation document as the first bounded JSONL frame on standard input. The document is limited to 8 KiB and contains the run ID, device name, state root, project directory, exact expected `HOME`, and optional cloud deployment URL and candidate attestation. An active release run supplies the exact source revision, package version, and cloud-target digest. Recovery-only cleanup omits that candidate and cannot arm the memory fault. These values never appear in worker arguments or environment variables. The worker arguments contain only the fixed source-worker path.

The same standard-input stream then carries bounded CLI invocations, paired protected input documents, and internal cleanup commands. Closing it owns the worker lifetime. Every scenario operation enters the exported Oompa `main()` function, passes through the production parser and renderer, and reaches the daemon through the ordinary local transport. A protected command must select `--input-fd 0`; the worker proves that standard input is nonterminal, consumes exactly one paired document from the control frame, and rejects `--input-stdin`, another descriptor, an unused document, `--follow`, `--jsonl`, and daemon lifecycle commands. Parent death aborts an in-flight local request immediately, closes the queue, and requests bounded daemon shutdown. Standard output carries only bounded typed results and lifecycle acknowledgements. Worker stderr is discarded, so provider output, credentials, paths, and diagnostics cannot escape through process output.

Each worker supervises sequential full daemon generations. A successful auth completion or account-deletion response that declares `daemonRestartRequired` is delivered first, then the worker waits for complete authority release and starts a new generation before accepting another operation. An unexpected daemon completion after readiness is terminal. Device suspend and resume stop and start a full generation while preserving the worker control process, which allows the scenario to cross the hosted presence boundary without a second state authority.

Both installations preserve the invoking `HOME` byte for byte. Each account still receives its ordinary isolated `CODEX_HOME`. Acceptance `CODEX_HOME` directories contain this exact configuration:

```toml
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
```

The production and acceptance launchers force both values through pinned process arguments, and the daemon proves their effective values through Codex `config/read` before login, plugin discovery, or session work. Acceptance also fixes the account-level file so the fixture fails if a project layer attempts to change custody. It assigns a distinct private `TMPDIR` below each `CODEX_HOME`. Oompa secret custody uses `FileSecretBackend` below the corresponding state root, matching the production CLI custody boundary.

Before the daemon starts, each worker changes its process working directory to its verified isolated project. Codex therefore loads its account-level credential policy from the same project boundary used by the effective `config/read` checks. The repository checkout and another device's project cannot contribute a startup project layer.

## Operator driver

The executable validates this optional qualification, not artifact publication. It requires the explicit canonical origin to equal the candidate authority compiled into this checkout. Loopback, a different HTTPS deployment, an omitted value, and a noncanonical spelling all fail before either worker starts. Put this non-secret configuration in a mode-`0600` file:

Use an authorized Linux host with the supported native authority backend, the exact pinned provider runtimes, and an exclusive operator for the exact deployed candidate. Reserve one disposable Oompa identity and its invite and mailbox access, authorize revoking its second device and deleting that test identity, and provide two distinct authorized paid Codex subscriptions. The memory scenario also signs the secondary subscription into a separate B-local profile; it does not copy credentials or require a third subscription. Operator quota reads need authority for the exact Convex deployment through the pinned official CLI. These are live prerequisites, not credentials consumed by ordinary tests.

Local live-gate preparation can use the release recovery boundary below the operating-system account's fixed `~/.local/state/oompa/process-recovery/` directory. It holds the local child behind a private gate until an active process-group record is durably promoted. Mutable `HOME` and XDG values cannot redirect the directory. Startup recovery is serialized with launch and removes an active record only after the operating system proves that recorded group absent. `process_cleanup_unproven` or `process_recovery_journal_blocked` is terminal for that local work: preserve all reported paths, do not retry the associated local operation while the group may be live, and never delete the journal.

Local process-group custody is deliberately limited. A descendant can escape with a new session or a double fork. It is not a sandbox and cannot authorize provider or source-attestation subprocesses. Those calls are `authority` work and require the supported Linux native authority backend for descendant-lifetime custody. It verifies the pinned helper, executes only a sealed in-memory copy, records exact pre-`GO` identities, and retains its PID-namespace reaper until descendants are gone. Any unavailable or unproven backend refuses before target execution or retains recovery evidence; Oompa never falls back to local custody. A live gate that needs such a target therefore refuses on macOS and other unsupported platforms.

Even after authority custody is accepted, it will not prove that a remote effect did not occur. Keep the deploy and live evidence receipts, use provider idempotency, and perform exact source-attestation reconciliation after every ambiguous provider outcome.

```json
{"cloudDeploymentUrl":"https://qualified-hummingbird-537.convex.cloud","operator":{"kind":"terminal"},"version":1}
```

For a release run, write the durable summary to a new path in a canonical invoking-user-owned mode-`0700` directory and bind it to the exact deploy evidence. Run the complete scenario with the configuration on a nonterminal descriptor:

```sh
bun run acceptance:live \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --evidence-path /protected/release/candidate-live.json \
  --scenario-fd 3 \
  3< /protected/path/to/live-acceptance.json
```

Terminal mode hides every invite, OTP, auth document, interaction answer, and permission grant. Before rendering provider-controlled login handoff values, it requires an HTTPS URL without credentials or terminal-control scalars and a short uppercase alphanumeric device code. It then waits for the human to acknowledge provider completion. The process prints safe progress to stderr and exactly one final JSON value to stdout. Exit `0` means the full scenario and cleanup passed. It does not mean that two daemons merely became ready.

The gate also requires a clean Git worktree and resolves the exact `HEAD` commit before starting workers. The protected release summary binds the deploy evidence digest, fixed Convex target digest, bound runtime revision, package version, start and completion times, and 40-character source revision. Its start must be later than the bound deployment time. This makes a result from a local fake, a different deployment, a dirty checkout, a prior runtime, or a different source revision distinguishable from the intended release candidate.

The standalone evidence parser accepts canonical stable semantic versions so historical receipts remain readable after a package release. Historical inner version-one receipts remain readable but cannot satisfy the current producer, which requires version-two memory evidence. The outer self-digested release envelope remains version one. Producing evidence still requires the version compiled into the current checkout, and any qualification consumer must compare the recorded version with the package version it intends to qualify.

The release form reads the public `releaseAttestation:read` authority before worker startup and again after successful cleanup, immediately before it writes evidence. Both reads must equal the exact deploy attestation, including its source commit, deployment time, predecessor digest, and runtime revision. Run this interval under one exclusive release operator with every other Convex deploy path stopped. Two endpoint reads cannot detect a deployment that another operator performs and fully restores between them, so concurrent deployment authority invalidates the run even if both reads match. Candidate sealing later revalidates the current runtime and fixed deployment authority; it does not waive this exclusive-operator requirement.

Oompa writes the summary only after cleanup succeeds and before it emits the terminal stdout frame. The output is canonical self-digested JSON in an exclusive no-follow, single-link, mode-`0600` file with bounded readback and durable directory sync. An agent may instead supply an already-open empty mode-`0600` descriptor with `--evidence-fd <fd>`; `--deploy-evidence` remains mandatory. The summary contains no credential, email, invitation, OTP, device code, local project path, raw provider output, raw reasoning, or arbitrary tool output. Preserve the full live recovery semantics on failure; no passing summary is emitted before cleanup.

Agent runners start the gate with standard-stream mode:

```sh
bun run acceptance:live \
  --deploy-evidence /protected/release/candidate-deploy.json \
  --evidence-path /protected/release/candidate-live.json \
  --scenario-stdin
```

The first standard-input line must be this bounded candidate configuration:

```json
{"cloudDeploymentUrl":"https://qualified-hummingbird-537.convex.cloud","operator":{"kind":"jsonl"},"version":1}
```

Later lines supply one matching response at a time. Standard output emits bounded JSONL requests, progress, and the final result. Response-bearing requests carry a UUID. Oompa identity authentication uses `protected_input_required`; Codex device login uses the two-stage `device_login_handoff_file_required` and `device_login_required` flow; progress frames have type `progress` and no UUID. Each protected-input request declares `responseMode`. Oompa authentication requests use `absolute_canonical_owned_mode_0600_json_file`; the fixed nonsecret interaction responses use `inline_fixed_nonsecret`. Responses must echo the request UUID and match that mode exactly:

```json
{"documentPath":"/absolute/private/operator/auth-response.json","requestId":"00000000-0000-4000-8000-000000000000","type":"protected_input_file","version":1}
{"document":{"answers":{"acceptance_choice":{"answers":["Continue"]}}},"requestId":"00000000-0000-4000-8000-000000000000","type":"protected_input","version":1}
{"documentPath":"/absolute/private/operator/empty-codex-login.json","requestId":"00000000-0000-4000-8000-000000000000","type":"device_login_handoff_file","version":1}
{"acknowledged":true,"requestId":"00000000-0000-4000-8000-000000000001","type":"device_login","version":1}
```

Oompa authentication documents never enter operator-facing JSONL, argv, the environment, or process output. They reach the isolated worker only through its private control-input pipe. The response path must be absolute and canonical. Its direct parent must be a canonical invoking-user-owned mode-`0700` directory, and the document must be an invoking-user-owned, single-link, mode-`0600` regular file. The operator holds the verified parent descriptor and opens the child relative to that descriptor with no link following and nonblocking FIFO-safe semantics. A rename or substitution of the parent path cannot redirect or block the child open. It bounds the read, revalidates the parent binding, child device and inode, owner and mode, link count, size, modification time, and change time. It preserves the file so a lost downstream effect cannot destroy the only invite or code before recovery. The request declares `documentFileDisposition: hra_preserves_caller_removes_after_final_result`; the caller removes the file only after the final result. Inline documents are accepted only for the fixed `acceptance_choice` answer and fixed `network` permission grant, which contain no secret.

Codex OAuth handoff values follow the same output-secrecy rule. JSONL never contains the provider user code or verification URL. Before the account-login CLI effect, Oompa emits `device_login_handoff_file_required` with the exact account ID and label, and the agent supplies an absolute canonical path to an empty, invoking-user-owned, single-link, mode-`0600` file under a canonical mode-`0700` parent. The operator proves that empty file, then the account-login CLI independently opens and holds the parent and child with descriptor-relative `openat`, `O_NOFOLLOW`, and `O_NONBLOCK`, resolves the selector to that exact local account ID, and dispatches only that authority. The first pending response must repeat the exact account ID, coherent pending state, canonical cancellation command, safe URL, and closed device-code shape before Oompa reduces it to one bounded version-1 `codex_device_login` document. Oompa writes it through the held descriptor, syncs it, reads it back, re-proves the parent, child, binding, and exact size, then closes both descriptors before success. The CLI result and later `device_login_required` request contain only the account identity, protected path, disposition, safe status, and exact `fixed_nonsecret_acknowledgement` response mode. The agent reads that file through its protected local boundary, hands it directly to the human, and acknowledges only after the provider confirms completion. The caller removes the handoff file after the final scenario result. A still-pending same-key replay has no one-time values, does not rewrite the file, and reports that no handoff is available; a completed or canceled replay returns terminal state. A post-effect parse, write, close, or proof failure requires recovery and directs the operator to cancel the exact pending login before starting another. Terminal mode continues to render the validated code and HTTPS URL directly on the dedicated foreground human terminal.

An agent distinguishes the terminal frame by its `ok` field; request and progress frames use `type`. Terminal status is `passed`, `startup_failed`, `recovery_required`, or `evidence_unavailable_after_cleanup`. Exit `0` reports passing evidence after cleanup. Exit `1` reports a startup or run failure, and the terminal status says whether recovery state remains. Exit `75` reports interruption; the terminal frame still says whether recovery state remains. Exit `2` is an argument-usage error and emits no stdout frame. Agents must retain and surface `recoveryReceiptPath` whenever `recoveryReceiptRetained` is true.

`--scenario-fd` accepts only terminal mode, and `--scenario-stdin` accepts only JSONL mode. A closed operator input, an unexpected response type or UUID, a terminal standard stream, an oversized frame, or extra fields fails closed and retains recovery state. `SIGINT` and `SIGTERM` abort protected reads, device calls, polls, presence sleeps, and cleanup waits. Preservation joins any in-flight cleanup before it writes a recovery state, so cleanup and interruption cannot race receipt deletion or overwrite each other's checkpoint.

The source API remains available for deterministic tests and recovery tooling. `run.device("a")` exposes the verified project directory, bounded CLI `execute()`, daemon-generation `suspend()` and `resume()`, and closed acceptance-only memory-fault controls. It does not expose arbitrary state paths, sockets, capabilities, cloud controls, or a public `LocalCommand` transport. The fault controls require the active candidate and exact daemon generation. Production installations reject the internal typed memory-transport decorator before daemon effects; there is no CLI flag, environment toggle, global fetch interception, or general traffic observer.

## Qualification scenario

The executable performs these checks itself. Use two distinct real Codex subscriptions. Reusing one subscription under two labels fails the provider-identity proof.

1. Consume the one-time Oompa identity invite on device A through protected auth input. Complete the email code flow and prove that A becomes the first active keyed device.
2. Add and complete Codex login for two accounts on A. Require each provider to report one exact paid plan from the pinned Codex vocabulary (`CODEX_PIN` in `src/codex/pin.ts`): `go`, `plus`, `pro`, `prolite`, `team`, `self_serve_business_prolite`, `self_serve_business_usage_based`, `business`, `ent26`, `enterprise_cbp_automation`, `enterprise_cbp_usage_based`, `education`, `quorum`, `k12`, `enterprise`, `edu`, `edu_plus`, or `edu_pro`. `guest`, `free`, `free_workspace`, `unknown`, and unreviewed future values fail closed. Then prove distinct provider identities and isolated `CODEX_HOME` directories. Establish one exact refreshed `observed` usage poll and snapshot for each account, wait longer than the maximum normal polling interval, read both accounts without `--refresh`, and require each source revision to advance. This proves the running daemon's autonomous poller instead of two operator-triggered samples.
3. Authenticate device B to the same Oompa identity. The harness compares an ephemeral in-memory digest of the canonical email in A's invite and code documents with B's email and code documents before each later auth effect; it never persists or emits that digest. Prove that B registers as pending, cannot sync or read encrypted projections, and cannot submit a remote command.
4. Approve B from A, pair B, and prove that B receives the workspace key without receiving A's device credential.
5. Start one session under each Codex account. Use unique non-secret markers. Follow each exact account, session, and turn while active. Prove one uninterrupted provider authority, ordered cursor pages without gaps or terminal errors, a safe reasoning summary, an assistant delta containing the exact marker, and terminal completion.
6. Exercise one blocking, nonsecret `request_user_input` question with exact ID `acceptance_choice`, `allowsOther: false`, and ordered `Continue` and `Stop` choices. Exercise one permission request for exactly the `network` category with a nonempty safe summary and reason, then grant it for that turn only. Discover each interaction as pending and blocking under the exact session and turn. Resolve it by exact ID and revision through protected input, require the CLI's advanced `response_written` interaction with `responseRecorded: true`, and prove the same interaction follows this strict order under one provider authority: requested, response prepared, response written, command start, command progress, command completion, terminal turn. Every matching command-progress event must fall strictly between start and completion, and at least one must report nonempty output. Each turn requests one unique `/bin/echo oompa-live-tool-progress | /usr/bin/tee ./.oompa-live-command-proof-<UUID>.txt` command. The pinned protocol projects a domain-separated SHA-256 digest only when the provider command matches that complete deliberately nonsecret grammar byte for byte. Arbitrary commands expose no digest. The harness requires the expected digest on the same command start and completion, rejects any other side-effecting or proof-producing item in the turn, reopens the same proof inode relative to a held project-directory descriptor with nonblocking FIFO-safe semantics, and verifies the exact output. Run a bounded, path-free plugin discovery for the exact account, then prove `auth`, `disable`, `enable`, and `install` all receive the exact production-parser `INVALID_INPUT` result and exit code 2.
7. Sync from both devices. Prove that B reads A's assistant marker, receives a pending receipt for an exactly bound `send` command to the A-custodied session, and observes its terminal `applied` status. Then repeatedly sync and pull the exact complete, gap-free A projection until the submitted turn has both the expected assistant marker and its terminal turn summary. The gate does not require sampling the transient `effect_started` state.
8. Complete the canonical-memory proof below with a B-local profile and session, including historical reconciliation, deliberate divergence, and exact hosted quota readback.
9. Prove device presence transitions across a daemon stop, the 45-second offline boundary, and restart. Revoke B from A. Prove exact `UNAVAILABLE` denial for sync, the exact remote session read, and a new remote send. After another presence boundary, prove A sees that exact B device as revoked and offline.
10. Call `run.cleanup()`, then verify hosted memory erasure for the same privately retained account identity. Do not remove either local root manually.

The scenario fails if it does not observe a higher autonomous source revision for both accounts after the active polling interval, continuous ordered progress, a reasoning-summary event, the exact safe command digest and inode-bound side effect in the required event order, assistant output for both local turns, both exact interactions, terminal turn settlement, pending and applied remote states, a terminal remote assistant result, or any presence and revocation boundary. It compares the two provider identities only in memory and exports the boolean `providerIdentitiesDistinct: true`; it does not export email hashes or other linkable provider commitments. Passing evidence is constructed and timestamped only after cleanup succeeds. It otherwise contains only non-secret IDs, timestamps, event-kind sets, marker digests, state transitions, target digest, source revision, package version, and pass outcomes. It never contains provider credentials, emails, invites, OTPs, device codes, raw reasoning, arbitrary tool output, local paths, environment values, socket capabilities, or encrypted workspace keys.

### Canonical-memory proof

The memory gate uses the same two installations and disposable Oompa identity. A creates one hosted space and B explicitly attaches it. Both devices use public owner memory commands through their own local session authority. B independently logs into the already selected secondary subscription, and the harness compares provider identities privately before using that profile. No failure causes automatic account rotation.

The lost-response test is historical reconciliation, not a repeated push. A first detaches, remembers and shares a page locally, and records that exact canonical head before arming the fault. Reattachment triggers the push, so background sync cannot race ahead of arming. A's candidate-bound controller forwards one exact encrypted push through the real authority-fenced transport, observes a successful non-replay response, withholds that response, and fails further same-space requests before effects. It never holds a network promise to obstruct shutdown. A stops its complete daemon generation. B pulls that operation and must show A's exact nominated public head before committing another operation, proving a strictly later remote sequence before A resumes. The new A generation must recover through the exact historical pull and match the first returned wire-operation digest to the original push. No same-space push is allowed before recovery is proved. Public status must independently prove settlement and convergence before the controller is finalized. Equal final heads alone do not pass.

For divergence, both devices detach at a common converged head while retaining local identity and history. They share different new pages locally, producing equal sequences with different heads. A reattaches and publishes the winner. B's reattach must fail with the exact sticky equal-sequence conflict, preserve its local losing head and working page, and leave A's winner unchanged. The conflict occurs during attach because attach synchronizes immediately.

Before revocation, the operator helper binds exactly one active daemon row for each public device ID to the same private account ID. Through the pinned `convex@1.45.0` CLI it reads that account's quota categories and at most four 200-row pages per memory table. Direct space and operation counts and logical bytes must exactly match stable memory quota counters and the expected remote operation count. After terminal account deletion and local cleanup, it queries the same retained account ID and requires both memory tables to be empty and quota rows to be absent. Missing device rows alone never prove erasure.

Each operator read verifies the exact default deployment and candidate runtime attestation before and after the bounded child. A fixed child receives one strict document on stdin and constructs only four reviewed read-only CLI operations; identifiers do not enter operating-system argv. No new Convex function, general query selector, alternate API, or mutation is added. The private account ID and pagination cursors remain in bounded process memory, are never emitted as evidence, and are discarded at close. This is output and process-argument hygiene within Oompa's same-user trust model, not hostile same-user memory isolation.

Version-two memory evidence contains only bounded digests, generation and sequence numbers, exact pass predicates, quota counts, and erasure results. Any missing stage, unexpected provider result, repeated push, changed deployment, unproved cleanup, or memory remnant prevents passing evidence. The valid authenticated operator CLI path and real two-device behavior require the live run; deterministic fixtures do not substitute for them.

### Separate Claude proof

This runner's provider scenario is Codex-specific. It does not establish Claude parity. The separate [Claude live acceptance gate](claude-live-acceptance.md) requires a fresh Oompa-created session on an authorized Linux host running exact Claude 2.1.260, one bounded memory remember, consumption of its actual unpredictable receipt, independent owner and private readback, exact child and bridge teardown, and isolated native logout. Existing adopted Claude conversations are not eligible. Local revocation does not claim remote provider credential erasure.

## Cleanup

`run.cleanup()` advances a durable checkpoint only after it proves each boundary:

1. If no Oompa identity was created, both installations must prove that no local cloud device exists and cloud deletion is skipped. If A is signed in but B has not registered, B must prove the same canonical email and no device. If B registration committed across a lost response before its public ID reached the receipt, recovery compares B's own signed-in device ID and status with A's sole noncurrent peer, durably records that exact public ID and a stable revocation idempotency key, and only then revokes it. A previously bound pending or active B is revoked with the same key; an already revoked B is re-proved. Any different active or pending peer, mismatched identity, ambiguous device row, or unrelated historical revoked row blocks cleanup.
2. Cloud account deletion reaches fresh terminal `complete` status with effects disabled. A second `auth.status` read proves the same state.
3. Every Codex account on both devices completes logout. If a prior logout response was lost, recovery first runs the required exact `account show` reconciliation and issues no new logout unless that read proves the provider remains signed in. A new account-list read proves no profile remains signed in, login-pending, or recovery-required.
4. Both daemon workers stop. Each child exits successfully, releases its daemon authority with a `stopped` receipt, and removes its socket and capability.
5. The invoking `HOME` is still the exact original value.
6. Every recorded directory still has its original owner, mode, device, inode, canonical location, direct-child relationship, role prefix, and run ID.

Only then does cleanup assign a random quarantine name inside the owned run directory, atomically rename one direct child, recheck its inode, recursively remove it, and advance the receipt. It repeats this for all four children, removes the empty run directory, then removes the receipt.

Any failure closes the worker control pipes, preserves the roots, and writes a mode-`0600` recovery receipt beside the run directory. The receipt records the last completed checkpoint, any exact B identity and revocation key learned before failure, the cloud-cleanup mode, and each planned or completed quarantine transition. It contains paths and process IDs but no credentials or bearer capabilities.

## Recovery

Wait until every recorded worker PID has exited. Pass the complete receipt through a nonterminal descriptor:

```sh
bun scripts/live-acceptance.ts --resume-fd 3 3< /protected/path/to/recovery-receipt.json
```

The only argument is the descriptor number. The state root, socket, capability, and receipt contents do not enter argv or the environment.

Recovery treats the mode-`0600` file on disk as authoritative. The caller-provided document is only a protected locator. Recovery uses a nonblocking, no-follow, size-bounded descriptor read and verifies the named file against that descriptor. Owner, link count, mode, size, device, inode, timestamps, and parent identity must remain consistent. Subsequent updates and removal also verify the admitted content digest, so an in-place edit cannot redirect cleanup or be overwritten silently. Inspection returns a copy, and concurrent mutations through the same receipt controller refuse. The exclusive-operator requirement still applies across processes; atomic rename is not a cross-process compare-and-swap. These checks do not claim hostile same-user isolation.

It then revalidates the run-ID filename, receipt location, run-root prefix, all four distinct role paths and prefixes, directory identities, canonical temporary parent, and non-overlap with production Oompa state and the invoking home. A live PID, stale socket, changed inode, symlink, unknown direct child, incomplete cloud erasure, incomplete Codex logout, or failed shutdown proof leaves the receipt and roots intact.

If cleanup stopped before daemon shutdown, recovery starts two new attached workers against the same isolated installations and converges from no auth, partial same-identity auth, a lost B registration response, or a bound pending, active, or revoked B before continuing from the last safe cloud or logout checkpoint. If daemon shutdown was already proved, recovery resumes only the recorded quarantine transitions. A crash after a rename or removal is reconciled from the original and planned quarantine paths before any next deletion.

## Deterministic evidence

The suite proves strict framing and descriptor parsing, exact candidate selection, canonical private roots, unchanged `HOME`, distinct state and temporary paths, file-only Oompa and Codex custody, absence of state authority in worker argv and environment, real CLI and protected-input routing, full-generation suspend/resume, symlink refusal, lost-pair derivation, exact-peer revocation, ambiguous-logout reconciliation, gated quarantine deletion, authoritative on-disk recovery, checkpoint resumption, serialized cleanup interruption, and a real two-subprocess smoke in which both full daemons become ready and stop with released authority and absent socket and capability endpoints. The scenario test drives every release step through a deterministic two-device world, rejects prompt-only result markers, empty usage, local event gaps, wrong remote projection authority, incomplete remote turns, mismatched interaction receipts, mismatched B identity, and terminal-unsafe login handoffs. A real subprocess regression keeps standard input open, aborts a pending JSONL read, and proves the child exits without inherited extra pipes. Final evidence omits provider identity values, provider-derived hashes, and device-code values.

```sh
bun test scripts/live-acceptance.test.ts scripts/live-acceptance-scenario.test.ts \
  scripts/live-acceptance-memory-fault.test.ts scripts/live-acceptance-memory-readback.test.ts
```
