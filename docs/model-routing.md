# Model routing: browser starts and the shadow contract

The Phase 3 shadow router does not automatically route work to a different model.
Astra Ultra (contract 2) is the default for new Codex sessions, with Fast off.
The shadow routing decision can describe disabled studies, but it cannot mutate
a session or authorize a runtime profile. The browser separately reuses the
pure task-shape classifier for the bounded new-start policy below.

Terra, Opus, and Fast are not enabled by this work. Astra is the active Codex
baseline since 2026-09-10 (contract 1 Sol was active between 2026-09-06 and
then), not a shadow candidate. New sessions that explicitly choose the Claude
family continue to use Fable Max. Explicit preset choices are preserved, and
established sessions never change provider, preset, exact model, effort, or Fast
state because of a shadow decision or a default change.

## Automatic effort for new browser conversations

The grid composer may start a clearly bounded Codex prompt at Astra Max instead
of Astra Ultra. It uses the existing `high` alias only when this browser build
binds High and Ultra to exact contract 2 Astra Max and Astra Ultra profiles.
Otherwise it keeps `ultra`. The ordinary device command carries that immutable
preset contract, so a daemon with a different active binding refuses it before
any provider effect.

The conservative, local task-shape classifier admits only `well_defined` and
`mechanical` prompts. Empty, uncertain, open-ended, unsupported or oversized
text keeps Ultra, as does text naming an effort or preset. Named model choices
already make the classifier uncertain. The composer shows the selected effort
before submission. Claude starts stay on Fable Max.

Settings → New conversations → Automatic effort controls this browser only.
It is enabled when readable storage has no saved choice; turning it off makes
every new Codex start use Ultra. The browser saves only `on` or `off`, never the
prompt or decision. Malformed or unreadable storage disables the policy. A
failed preference write disables it for the rest of the tab until a successful
explicit save, and the screen reports that it could not retain the choice.

The decision is captured once with the submitted command. There is no account
movement, retry, reclassification of a submitted command, change to established
conversations, or override of explicit CLI and other device-command presets.
The CLI starts an idle session without a prompt, so it remains on Ultra; no
daemon routing setting or new payload field is introduced. The command's exact
preset and contract are the durable selection evidence. Historical commands
gain no inferred rule provenance.

This effort choice does not activate `src/domain/model-routing.ts`, a Terra or
Opus study, Fast, or a new provider profile. The separate study gates below
remain unchanged.

## Decision contract

`src/domain/model-routing.ts` accepts a closed, content-free record. It contains
only schema version 1, whether the session is new or established, how its route
was selected, the already-admitted effective provider/preset/Fast tuple, the
Phase 2 task shape and rule, and a declared safety class. It accepts no task
text, session identifier, account label, path, or model output.

The input must be coherent:

- An implicit default is only a new Codex Ultra route with Fast off.
- A family default must equal the provider's current default. Claude family
  selection is necessarily explicit.
- An explicit preset must already be compatible with its provider.
- An existing selection is only valid for an established session.
- Claude never accepts Fast.

Every result has `mode: "shadow"`, `schemaVersion: 1`, and
`runtimeMutationAllowed: false`. Its `effective` value is a semantic copy of
the admitted route. A candidate is always `disabled_unlicensed`, has a study
identifier that is not a preset, and never occupies the effective field.

Established sessions, explicit presets, mechanical work, open-ended work,
uncertain work, and work requiring the strong profile receive no candidate.
A new, well-defined Codex default may describe the disabled Terra Ultra and
Terra Fast studies against the active Codex baseline. A new, explicit,
well-defined Claude family default may
describe the disabled Opus effort study. Unknown safety does not license either
study; it adds an unresolved effect-class blocker.

The live web app labels mutable remote choices as `Codex High` and
`Codex Ultra`. A browser deployment and its target daemon can roll
independently, while encrypted device-registry version 1 projects only the
preset alias and not that daemon's exact active alias binding. Source-bound CLI
and documentation can name the current Astra mapping, but the browser must not
claim Sol or Astra for a remote command until a future additive registry
contract proves that target-specific binding. Every explicit remote preset
write for the rebound Codex `high` or `ultra` aliases carries the client's
immutable `presetContract`; so does a preset-omitted provider switch targeting
Codex, because the daemon may derive either mutable alias from the source tier.
The receiving daemon accepts the token only when it equals the named alias's
active binding, or the shared active High/Ultra binding for a derived Codex
switch; a missing or mismatched contract is refused before any provider effect.
Thus both an old browser targeting a new daemon and a new browser targeting an
old daemon fail closed instead of silently substituting Sol for Astra or Astra
for Sol. Explicit stable `low` and `fable-max` aliases keep their existing
token-free remote shapes, as do preset-omitted Claude switches, so mixed-version
rollout does not make an unchanged supported route unavailable. Devin and its
`astra` alias remain historical decoder and storage values only. Current remote
commands cannot select or execute them.

Settings can separately show a machine's **Last reported Codex default** when
the daemon publishes an exact profile observation. This read-only companion is
encrypted independently from the unchanged registry v1. It records the preset
alias, canonical profile key, observation time, next registry revision, and a
digest of that exact encrypted registry. The publishing daemon reads its
default tier once and resolves it under its own active Codex binding. It does
not infer the default from an established session or ask a provider to run.

The daemon first publishes the existing registry shape. Only a successful
response advertising companion version 1 enables a companion on the next
publication. Support is scoped to the exact account, device, key version, and
key bytes. A server that has not advertised support receives the existing
argument shape. After a server rollback, a previously negotiated companion can
be refused once before negotiation resets. A failed or ambiguous write,
including cancellation after a commit, drops the cached support and revision;
a later cycle reads the current
revision and starts negotiation again. Omitting the companion clears it in the
same registry transaction, including after a producer downgrade.

The browser shows an exact profile only when the decrypted observation agrees
with the registry's alias, heartbeat, revision, and envelope digest, and the
current hosted device is an active daemon with the same key version. Hosted
time must be available and within three registry heartbeat intervals of the
observation, including the future-skew bound. Missing, stale, inactive, and
unreadable observations have explicit unavailable states. An old companion
cannot survive a registry-envelope replacement while decryption is pending.
This observation does not establish provider availability, describe an
existing session, or authorize a remote preset choice. All selectors and
command contracts above remain unchanged. See the
[implementation and delivery status](../kb/plans/model-routing-autonomy.md#read-only-machine-default-observation)
before treating source support as a deployed capability.

The local CLI and persistent daemon have the same independent-rollout problem.
Their strict socket envelope therefore has a build fence. It conditionally
carries the current active preset contract for `session.start` or
`session.preset` with High or Ultra, an explicit or derived High/Ultra switch to
Codex, a `work.create` whose immutable routes include High or Ultra, and a
`task.addBatch` that adds a High or Ultra task. The daemon validates that fence
before handing the command to the service. An older strict daemon rejects the
additive field, while a current daemon rejects an affected request that lacks
the current build fence. Read-only commands, daemon status and stop, explicit
stable presets, and other provider switches retain their existing token-free
envelope.

Caller-authored replay identity is separate from that socket fence. A new High
or Ultra `session.start`, and a provider switch that explicitly or implicitly
selects either mutable Codex alias, records the current contract inside the
command. If transport becomes uncertain, the CLI returns that immutable source
contract with the idempotency key, and the replay must preserve both values.
An applied source-matched request replays its historical result, and an
effect-started request remains recovery-required. A missing or inactive source
cannot create a fresh session or resume a prepared no-effect row. This lets a
current daemon look up historical evidence without treating an old Sol
request as a new Astra request, or the reverse.

Released session-start commands before this source field used their own exact
request digest. A v0.5.0 Codex start with the then-default preset omitted must
be replayed with an explicit `high` and contract 1, because that release meant
Sol Max and did not include `provider` in the digest. Contract 2 is also the
compatibility selector for an untagged Astra-era request whose immutable
runtime evidence proves Astra. Either selector can reach a source-matched
settled result or recovery-required evidence, and neither can admit a
contractless prepared row. Inactive contract 1 cannot authorize a fresh effect
under the current Astra binding. Active contract 2 can authorize the exact
Astra request when the key has no stored row, the same as a newly generated key.
Retain the originating binary when the historical meaning cannot be proved. A
contractless prepared row has no supported cancellation or retirement command.
It must reach a terminal settlement through exact replay under the originating
release, or the update remains blocked. Do not use a fresh key or
`session abandon` as a workaround. That command applies only to an existing
recovery-required session and never cancels prepared start or switch authority.

Work apply version 2 provides the same caller-authored boundary. Its top-level
`presetContract` is required for `work.create` declarations or `task.addBatch`
additions that name High or Ultra, and forbidden for stable operations. Fresh
affected version 2 requests require the current contract. Fresh affected
version 1 requests are refused because their intended Sol or Astra meaning is
not identifiable, while exact applied version 1 replay and stable version 1
operations remain available. Request version and source contract participate
in changed-intent detection. Fresh High or Ultra task additions also require
the target Work's durable contract to equal the current active contract. An
established contract 1 Work whose coordinator and participating session
authorities remain supported stays readable and may claim, execute, review, and
settle its existing Sol tasks. A Work associated with a retired Devin session
remains readable but is fenced from mutation and execution. Current tooling
refuses to extend any contract 1 Work with another rebound task; create a new
Work for a new Astra task graph.

Provider-switch preparation also includes the resolved High or Ultra contract
in its durable request identity. A prepared row left by a pre-update build
cannot resume after the alias changes, while stable Low and Fable preparation
and preset-omitted Claude preparation keep their prior digest shapes. Historical
Devin switch rows remain recovery evidence only and cannot execute. Stop and
restart the persistent daemon during an upgrade as the installation instructions
require. Resolve uncertain affected starts, switches, preset selections, and
Work requests before replacement, require daemon status to report
`data.running: false`, and expect affected writes to fail closed during a
mixed-version interval.

## Work project authority during an update

Released schema49 adds a null-safe project guard alongside the
unchanged historical Work guards. A session with a claimed, dispatching, running,
or recovery-required attempt cannot change or clear its project while that
attempt owns different project authority. The supported metadata API performs
its reads, project check, and write in one immediate transaction. Neither fence
changes the session's model, effort, account, approval policy, or Work route.

An upgrade refuses pre-existing contradictory live project authority with
`STATE_SCHEMA_V49_WORK_PROJECT_AUTHORITY_INVALID`. The entire migration rolls
back, including any legacy quarantine. Preserve the state root and its backup
for reviewed recovery; do not assign a project, release an attempt, or edit the
migration ledger with SQL to make the upgrade pass. A missing or modified guard
on a schema49 or later root also refuses opening instead of being reconstructed.

The first current-daemon start remains the no-downgrade boundary. An older
schema48 writer cannot open schema49, and schema50 adds the separately validated
canonical-profile identity columns. Restore a whole-root pre-upgrade backup
when returning to an older release; never decrement `user_version` or remove
the guard. These local migration checks do not clear the separate
[hosted-capacity and target-marker gates](hosted-sync.md#converge-command-lifecycle-capacity-before-writer-rollout).

## Content-free evaluation export

The analyzer has exactly one invocation form:

```sh
bun ./scripts/routing-eval.ts --input /absolute/path/evaluation.json
```

It opens that one bounded regular JSON file once. It does not search for
exports, read session history, run a provider, write a file, or print the input
path, pair identifiers, environment bindings, task text, or model output.
Unknown keys and malformed UTF-8 are rejected. Rejections are generic so that a
private field cannot be copied into diagnostics.

The current schema version 3 accepts one of three comparisons:

- Codex Terra Ultra against Codex Sol Ultra (the baseline schema 3 was
  declared against; a study against the active Astra baseline needs a new
  schema version and is not part of this contract).
- Claude Opus at `high`, `xhigh`, or `max` effort against Claude Fable Max.
- Codex Terra Fast against Terra in standard mode.

Schema version 1 remains readable only with its exact historical Sol baseline,
including the `terra_vs_sol` and `codex_sol_ultra` literals. Schema version 2
remains readable only with its exact Astra literals. Version 3 uses the Sol
literals for new studies without reusing the v1 evidence version. Relabelling
an export across these schema versions is rejected unless its exact comparison
belongs to that version.

An export declares `pilot` or `holdout`, a `well_defined` task shape, a
SHA-256 case-set digest over the exact ordered opaque pair identifiers and
their HMAC-SHA-256-shaped environment commitments, an optional preregistration
digest, and all seven fixed design assertions. The analyzer recomputes and
verifies that digest. Its array contains ordered, unique UUIDv4 pair
identifiers, unique environment commitments, and exactly balanced execution
order. Both arms use closed terminal, repair, safety, wall-clock, and
provider-native token-usage fields. These records deliberately have no dollar
price field.

Timeouts are quality failures. A holdout containing any
`infrastructure_invalid` outcome is invalid, and any candidate safety violation
is blocking. Quality non-inferiority uses a fixed margin of `0.05` and a
conservative paired interval derived from Wilson bounds for the two discordant
directions. A Fast comparison must also have an exponentiated one-sided 95%
Student-t upper bound for the geometric mean paired wall-clock ratio no greater
than `0.90`. The calculation states its independent, approximately normal
log-ratio assumption and uses upward-rounded
[NIST critical values](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm),
with conservative lower-degree-of-freedom breakpoints above 30. Even when
those statistics pass, Fast economics remain unresolved because this analyzer
has no price evidence and does not infer cost.

Forty pairs is a pilot floor only. It is not a holdout, an activation threshold,
or evidence of production safety. A holdout requires at least 200 pairs. No
private holdout currently exists, and the analyzer cannot prove that a supplied
digest predates a study. Reports therefore always state:

- `capabilityProof: "not_assessed"`
- `preregistrationChronology: "externally_unverified"`
- `liveRouting: "forbidden_phase_3_shadow_only"`
- `activationLicensed: false`

## Claims this phase does not accept

Broad plans sometimes treat public benchmark rank, advertised latency, nominal
context size, provider pricing, or account quota as sufficient routing proof.
They are not. Public evaluations need not match Oompa's task distribution,
permissions, tool surface, repair policy, runtime generation, or safety effect
class. List prices do not establish observed private cost, and a documented
model name does not prove that Oompa's pinned runtime can select and verify that
exact profile.

For the same reason, Phase 3 does not translate general claims such as “faster,”
“cheaper,” or “stronger” into a live rule. Technical profile admission in
Phase 4 requires a canonical identity, exact pinned-runtime and current-account
capability evidence, and reviewed runtime support. It permits explicit selection,
not automatic routing. Automatic routing in Phase 6 additionally requires private
non-inferiority evidence and the applicable latency, price, effort, and safety
evidence. Identity inventory and design for already supported profiles need not
wait for new-model capability or a private holdout. This document records those
distinct missing proof classes rather than volatile benchmark results.
