---
title: Provider usage management
description: Implementation plan for provider-scoped account authority, truthful Codex and Claude usage observations, safe exhaustion handling, ordered local accounts, and browser and CLI visibility.
type: plan
status: in-progress
area: oompa
tags:
  - app
  - claude
  - codex
  - convex
  - usage
---

# Provider usage management

## Current delivery checkpoint

2026-09-10: the foundation candidate is integrated into [PR 174](https://github.com/hraness/oompa/pull/174) on branch `claude/oompa-v0.8.0` together with the site header repair and the Oompa rename; the earlier PR 140 and PR 172 are closed as superseded. The [Oompa rename and package separation plan](oompa-rename.md) governs
forward naming and delivery. Preserve this foundation's reviewed source and
evidence, but hold old-name release and domain promotion until the rename's
compatibility and admission gates pass. The requested orange-circle identity
and package-only documentation do not activate unfinished usage features.

The active delivery is the existing usage observation, cached visibility,
manual-switch and policy-control foundation. Managed automatic movement,
Claude native fallback activation and the unfinished hosted/browser publisher
remain dormant. Phases 6 through 9 are not complete.

The September 9 candidate joined the admitted compiler-lifecycle repair at
`92a9b2ec81749755121a90ea55f30b63752d414d`, tree
`cb88f319d89df84f3ffb290f47536c94cc45e9a9`. Independent impact review confirms
the incoming compiler and release helpers are unchanged, and production source
is byte-identical to the prior candidate. Focused workflow contracts passed
30 cases with 1,160 assertions; focused site contracts passed 68 cases with
2,547 assertions. Typecheck and scoped lint passed for those inputs.

Two independent readers approved the actual 1,715,031-byte package, SHA-256
`2589933870c19a555cebc62549c98886559e43d6e9dbf34e893f55d06dd485b1`.
Its 214 files produce 223 inventory entries and 11,079 canonical bytes, digest
`aca5dd79904441721ed31391fc453393839917037a91000f4f824435425b8203`.
Both readers compared exact Git blobs, paths, sizes and modes. Only README,
notices and package metadata differ from the previous reviewed package. The
previous inventory pin rejected this archive before the independently approved
digest replacement; its count, canonical size and refusal predicates remain
unchanged. This inspection is not fresh installation or release acceptance.

Source review also identified a Claude write-outcome gap: a rejected
user-frame write without a result can clear the client's active turn while the
daemon records a failed mutation and retains an idle projection. A different
request key can then reach the same open process. An independently reviewed
isolated regression crosses the real client, adapter, service and storage with
a fake process that records the first frame before throwing. After approved
host-scheduled execution, the regression failed at its final safety oracle:
the second request succeeded and wrote a second frame. No live provider
acceptance is claimed.

The independently reviewed repair is committed at
`11fa006dd7da75369c1a5f3d2e99d71b9d16f166`, tree
`14ff7a04e544555d35b7ed0a3c8c933c87120c77`, and joined locally into this
candidate. It distinguishes proven pre-write refusal from a possibly escaped
effect, synchronously fences later client frames and marks daemon effects
indeterminate. Client tests pass 39 cases with 230 assertions; adapter tests
pass 83 cases with 498 assertions. The complete real-client cross-layer
session suite passes 34 cases with 283 assertions, including unknown approval
resolution, same-key and different-key refusal, queue admission, steering,
stopping and truthful early completion. These are synthetic provider seams,
not live provider qualification.

Two failed intermediate repairs remain recorded. The first quarantined before
recording an already observed completion. The second treated an immutable
accounting publication as a state-changing ordering barrier and lost a queued
completion. The corrected queue cases preserve both actual completions and
the original accounting publication order, retain only the previously bound
turn's accounting, and refuse accounting for the ambiguous queued turn.

The reviewed ordering repair preserves successful FIFO slots and allows only
an exact input owner's bounded observed-fact prefix to drain before failure
quarantine. Earlier account, session and interaction facts form a barrier;
immutable accounting publication retains its original FIFO and never grants
authority or a turn binding. Exact durable authority, connection, ownership and
cumulative bounds remain mandatory. Twenty focused retention and ordering
cases are covered by passing gates, including eight seeded cases, an explicit
leading barrier, reentrant count exhaustion and byte overflow after an actual
successful provider return. The accepted-result case preserves the user
message before the single start and completion. A throwing diagnostic
callback cannot replace the original error or prevent local turn abandonment.

Independent runtime, client and test review passed. Typecheck, scoped lint and
the existing effect-boundary check pass. Security inventory review confirms
one added daemon-authority assertion, from 101 to 102, with no removed guard;
the unchanged scanner passes. Recovery can reconcile durable evidence but
does not reopen a fenced client for writes; automatic same-process writability
is not claimed. No schema, provider pin, process-custody or activation policy
changed. These local changes are not published and invalidate the earlier
package measurement for final delivery. Fresh package, installation and
integration gates remain required after the next main join.

[PR 170](https://github.com/hraness/oompa/pull/170) independently merged the
protected site-operator input repair at
`32cf432247843a3c5dbf3ec1a1dc9e75ce5c236a`. Its exact candidate passed
[CI 34422315527](https://github.com/hraness/oompa/actions/runs/34422315527),
attempt 2, and both CodeQL analyses. Its delivery owner verified fresh
[actual-main CI 34424163044](https://github.com/hraness/oompa/actions/runs/34424163044),
attempt 1, with all ten jobs passing, and both analyses in
[CodeQL 34424162555](https://github.com/hraness/oompa/actions/runs/34424162555).
Guarded site promotion has provider and browser readback, but final HTTP
verification exposed response-header gaps that remain with that owner.
[PR 172](https://github.com/hraness/oompa/pull/172) carries the separate header
repair at `47293548d4f3c511f6999d1339434f50b6632b26`; its required CI and
CodeQL gates are still owned by that task. This usage candidate must join the
admitted successor before its own final gates; a protected merge alone does
not prove site promotion or admit v0.8.0.

[PR 169](https://github.com/hraness/oompa/pull/169) reached protected main at
`d270616db2589ada8de2af2da697bb862f5d0aad`, tree
`82d82126fb8ab10c4acd59668b7d3c1c017b7993`. Fresh actual-main
[CI 34417046126](https://github.com/hraness/oompa/actions/runs/34417046126),
attempt 1, passed all ten jobs; both analyses in
[CodeQL 34417046092](https://github.com/hraness/oompa/actions/runs/34417046092)
passed. The prerequisite owner verified all nine exact-main checkouts and
unchanged branch rules. The separate final browser gate passed six profiles,
210 evidence rows and three native custody controls, with all 54 owned
processes collected. This admits the prerequisite source, not v0.8.0.

Earlier combined PR 164, including the reviewed PR 167
follow-up, reached protected `main` at
`bdfb0c2ca7aa753e0232844a3e001c0a30626a14`, tree
`0be440ee932429d174b8b0d6e5eab123f85f0520`. Its PR checks passed, but
[actual-main CI 34404823161](https://github.com/hraness/oompa/actions/runs/34404823161),
attempt 1, failed Ubuntu remainder. That failed gate remains recorded without
a blind rerun or a relaxed collection rule.
PR 140 remains a separate draft foundation candidate. Its published head
remains `fb1bf7e72dd89ca453dbee2bc51f96b0cfbbf348`; the local join above is not
pushed. The joined service fixture retains the private-owner paged-recovery
case and the existing immutable-send and recovery-fence repairs.
Current content must distinguish the unadmitted v0.8.0 candidate from its
admitted v0.7.1 predecessor, preserve canonical GitHub admission separately
from the optional npm mirror, and retain every operational activation hold.

The earlier passing Linux compiler checkpoint did not establish a complete
repair. Combined PR 164 CI `34389604477`, attempt 1, at source
`efcb9c4844f61dbc76dbf04c0cce17133af60b6b` again failed Ubuntu remainder
`102594374633`: the site suite passed 163 cases and failed one, with 8,401
assertions. The unchanged stale-document case took 24.291 seconds and returned
a success terminal with process result 1. That is not its 60-second deadline.
The local runner can return either an observed leader failure or a forced
failure after a non-absent process-group observation; existing output does not
distinguish them. The narrow opt-in diagnostic change is committed locally as
`819a576ab85639966bf29ff941907b0328a6dd83`. Its independently reviewed public
handoff is `4479cea058da43838eff982cbc91ac2f7cf318e3`, tree
`0cc63e9df68abff02fb9f9f272700aadf3ebb89b`, based only on the exact combined
prerequisite `efcb9c4`. The handoff changes four development source/test files,
without PR 140 ancestry, plan edits or packaged-file changes. It observes only
the existing local close and termination decisions. It is not a behavioral
repair and does not change signals, deadlines, recovery journals, collection
requirements or nonzero-exit refusal. At that checkpoint a new exact Linux
observation was required before selecting a repair.

Focused real-process controls pass 24 cases with 129 assertions, including
genuine leader exits, a zero-exit leader with a remaining descendant, unchanged
no-opt-in results, authority refusal, cancellation, timeout, output limits and
signal-reporting failures. The final local compiler gate passes 46 cases with
4,107 assertions in 119.40 seconds: the unchanged native cancellation and
fresh-build proof, all 20 original site-build cases and 25 owner/property
contracts. Scoped lint, final typecheck and independent AST review pass.
The authority runner, group predicate and signal function remain unchanged;
removing diagnostic-only additions reproduces the original local execution
control flow. These historical local receipts did not establish the Linux cause
or artifact admission.

The actual-main failure now identifies the forced-failure branch: the compiler
leader closed with code 0, but the process group was non-absent, so the existing
runner forced result 1. The identity-marker case took 21.37738 seconds; this was
not the 60-second work deadline. Ubuntu passed 167 site cases and failed one,
with 10,392 assertions. macOS passed all 168 cases with 10,395 assertions.
These observations do not identify the residual member as esbuild or a zombie.

A bounded native experiment with pinned Bun 1.3.14 and esbuild 0.27.0 found a
separate concrete lifecycle gap. Three stop-only processes exited without
observing the compiler child's close event. Three processes that retained the
actual child and joined its close observed closure before returning. All six
outer runs proved collection. This establishes event ordering on macOS, not
Linux residual identity or a reliability rate.

The selected repair is confined to the isolated site-test compiler. An early
preload admits the exact pinned esbuild module and resolved native command,
observes genuine child closure at acquisition, and joins every observed close
before publishing a build terminal. One shared shutdown barrier handles early
closure, failed spawn, repeated stop and late errors. An independent event-loop
lease survives the library's own later unref without a timer, signal or second
cleanup owner. The parent still owns the original deadline, cancellation,
termination and process-group acceptance. Dependencies, production builders,
Convex and packaged files are unchanged. Independent source review found no
concrete blocker. The ordered native/compiler/owner gate passes 54 cases with
4,141 assertions in 112.70 seconds, including the unchanged identity-marker
case. The child-join unit suite passes 22 cases with 478 assertions, including
32 seeded ordering samples. Final native and spawn-scope tests pass 13 cases
with 60 assertions after test-only type annotations were corrected. Final
TypeScript and scoped lint pass. The real native cases cover failed spawn
without an exit event, closure before stop, delayed closure, library unref,
zero acquisitions, unknown-spawn refusal and cancellation collection. Fresh
Linux and exact-tree delivery evidence remain required; these focused local
receipts did not replace the prerequisite owner's later integration gates.

The frozen compiler handoff is
[`c958f4981853e3f0116cd650222a0147d7af1591`](https://github.com/hraness/oompa/commit/c958f4981853e3f0116cd650222a0147d7af1591),
tree `82d82126fb8ab10c4acd59668b7d3c1c017b7993`, with sole parent `bdfb0c2`.
It is a mechanical cherry-pick of local repair
`ea0d81092ad9ba0adbed381e9f48f441f50b551a` onto that exact main. All twelve
executable and test files remain byte-identical. The thirteenth file adds one
test-boundary description while preserving main's script guidance. The
prerequisite owner completed independent review, protected PR, fresh Required
checks and actual-main acceptance through PR 169. The normal PR 140 join now
preserves this exact compiler implementation and the stronger task-owned
paged-recovery fixture. It combines the canonical GitHub release policy with
the unadmitted v0.8.0 candidate and admitted v0.7.1 predecessor, retaining the
optional npm mirror and every separate activation hold. Neither parent's
package inventory pin admitted the joined archive. The fresh archive and
independent inventory review are recorded above; this candidate's own final
gates remain required.
Neither this public handoff nor the local plan checkpoint is a release or
deployment.

The proposed Effect Claude lifecycle delta remains a separate later delivery.
Independent review found that retaining the caller's mutable constructor
options could redirect effects to another process while retaining the first
process's exit observation. The finding was returned to its owner for a separate
repair. None of that runtime refactor is imported into this candidate.
The final actual-main join, exact-tree gates,
protected merge, immutable release and applicable deployment evidence remain
pending. No new artifact admission or operational activation is claimed.

The next artifact candidate is `v0.8.0`: provider-qualified cached account
listing and explicit `usage auto` policy controls add public contracts beyond
`v0.7.0`. Candidate preparation does not admit the artifact or enable automatic
movement. The independently reviewed delivery-policy join is committed as
`13ea56ce8f3c908e167a1694d858803eed142d70`, tree
`dfb4e3e92101b14f203489bd80bfc53fe7f93776`, incorporating main
`4d4447a99bb08b3469e620f7f179b9a7d3e8bf62`. Frozen dependency installation,
joined fixture and plugin checks, CI-equivalence and browser-handoff contracts,
and independent actual-archive review passed for their recorded inputs. Fresh
complete exact-candidate CI, local browser and isolated installation acceptance,
protected merge and immutable release admission remain required.

PR 140 now carries the foundation candidate. Its first updated CI run,
`34308421494`, passed compiled browser acceptance but exposed a static-type lint
error in the Codex start-session host-capability guard. The repair preserves
the foreign-value rejection before consuming a runtime review or dispatching a
provider operation. It uses the existing Claude adapter's validation-only
unknown-valued view rather than deleting the guard or changing the public mode
union. Scoped lint and three boundary regressions pass with 61 assertions.
Independent review of the fresh archive proves only that adapter changed by
124 bytes; the other 213 packaged files remain byte-identical. The reviewed
inventory retains 223 entries and 11,081 canonical bytes with digest
`d207841ca7d6969001b536ec686e75165b8b58816781fd81c57e155689f60b46`.
Package-policy tests pass 11 cases with 42 assertions. Fresh exact-candidate
validation remains required; the previous archive's successful isolated local
and global installation, PTY and daemon-lifecycle check is not reused as final
acceptance for these changed bytes. No passing final CI, protected merge, usage
release or deployment is claimed by this checkpoint.

The September 9 candidate `aad5c240621af2d227492406d1c382b9f2918cb2`,
tree `cd35c5784324624076fefa85cbe273d34fefd94a`, passed fresh isolated
package installation and compiled browser acceptance, including local/global
installation, PTY and owned daemon lifecycle. CI run `34309357688`, attempt 1,
checked the same tree through merge candidate
`232ec93991b35af56bb0784f8516869dda9502a4` on main
`4d4447a99bb08b3469e620f7f179b9a7d3e8bf62`. The separate browser job passed,
but Required failed: the source and script suites exposed stale fixtures,
two recovery-path defects and job-wide time exhaustion. Tests were still
progressing when the four source-1/source-2 jobs reached their 20-minute cap.
That observation does not dismiss their actual assertion failures or admit a
deadline change without independent coverage review.

Independent coverage review approved increasing only the six source jobs to
a finite 40-minute allowance. The remainder and browser retain 20 minutes;
Required retains five minutes. All eight matrix jobs, both operating systems,
the separate browser job, exact commands, governed history and native checks
remain unchanged, as do individual test deadlines and failure propagation.
In the observed run, macOS completed 568 service cases in 1,041 seconds before
reaching the remaining source-2 files. Ubuntu was still running that file at
the job cutoff. Source-1 likewise reached only part of StateStore on both
systems. The last completed tests preceded cancellation by 0.67 to 2.68
seconds. These measurements justify more aggregate time, not an assertion
that every suite will finish within 40 minutes or a performance acceptance.
The unchanged coverage and failure-propagation contract suite passes 28 tests
with 945 assertions against the reviewed deadline policy. Fresh complete
matching CI must prove the final candidate.

The repair in progress preserves legacy command disposition as explicitly
non-executable null authority, and reports a quarantined bound Claude session
from retained local authority before readiness, platform or provider access.
The latter regression failed on Linux and passed on Darwin before the repair;
both platform cases then passed without provider replay. The private Claude
readback also compared the retained legacy profile counter with a provider
generation. Its three comparisons now use the independently verified custody
tuple, preserving full identity, lifecycle, snapshot and process checks.
The corrected readback suite passes all 47 tests with 161 assertions, including
divergent counters and unchanged custody across a sibling Codex advancement.
These are isolated automated proofs, not live provider qualification.

Independent reviews approved the authority repairs and the bounded test-case
splits. Each split retains its assertions and original per-test deadline;
owned teardown in the asynchronous service, cloud and memory cases joins work
before closing storage. The full cloud
bridge, journal and canonical-memory suites pass 287 tests with 2,464
assertions. The direct-send manifest and released-state suites pass 32 tests
with 316 assertions; the selected cloud, memory and Work cases pass 19 tests
with 73 assertions. Historical captures remain unchanged. Exact rollback
faults retain complete no-write assertions and successful admission after
removing the injected trigger. The final service slice passes seven tests with
97 assertions, preserving the exact historical root while proving unavailable
root refusal separately. The complete isolated worker suite passes 53 tests
with 589 assertions, and both platform recovery cases pass with 124 assertions
across both detail modes. Fresh typecheck, installer pins, all 47 security
inventory files, Effect architecture and current repository adoption pass.

Independent actual-archive inspection proves only the service and bridge
changed from the preceding artifact, by 566 and 34 bytes; the other 212
published files remain byte-identical. The reviewed inventory retains 223
entries and 11,081 canonical bytes with digest
`97d355b56cecc48be0058aa522d3267a0f2d696363430fe25ba1ab24adb4b633`.
This is checkpoint evidence, not final acceptance. Governed main subsequently
advanced to `041a06a16015ff8b270a413b8c10ab9ca89e4ca2`, incorporating read-only
exact default-profile display and shared semantic themes. That incoming join
requires its own reviewed contracts and frozen dependencies. The changed
source invalidates earlier final browser and installation receipts. A fresh
joined archive, exact-tree final gates, protected merge, immutable release
admission and applicable deployment evidence remain required.

The reviewed join onto repair checkpoint
`f953e9b22fbc22bdcfd74854f1ec950ed697ea75` preserves the authentic observed-v20
archive test while adding incoming raw-task cleanup ownership. The five
storage join cases pass with 2,511 assertions. Canonical profile decoding,
the read-only profile companion, daemon adapters and bridge, and the Convex
device registry pass 374 tests with 3,347 assertions. Frozen dependencies,
typecheck, installer pins, all 47 security inventory files and Effect
architecture pass. The companion remains a revision- and digest-bound display
observation, never execution authority.

The app suite passes 583 cases; its build-output setup correctly refuses an
older output directory without publication provenance. That output remains
untouched, and the missing build-output acceptance will run in the isolated
final checkout. Ninety build and browser contract cases pass. The site suite
passes 99 cases and exposes one invalid palette-sensitive pixel oracle. The
repaired card suite passes all eight cases using a fixed literal glyph-coverage
fingerprint, actual RGB comparison and a minimum contrast check. Independent
review confirms that it retains candidate wording, geometry, warning and
command readability without accepting the observed brightness count as its
oracle. This focused evidence does not replace fresh joined final acceptance.

The fresh joined release-workflow contract passes 28 cases with 946 assertions,
including both-system command equivalence and native shard failure propagation.
Independent inspection of the new actual archive confirms 214 files, exact
frozen source bytes, modes and exclusions. Its reviewed inventory is 223 entries
and 11,081 canonical bytes with digest
`9d41a72f043897aab535dbfd2836bbc8da719b2d9d762b2a60ed150f0222a969`.
The archive SHA-256 is
`a4862f01883b735904816aa75dd9dcc14039ee9d63925634611bb505ea80729a`.
This binds the joined package inputs; exact committed-tree CI, browser and
installation acceptance remain outstanding.

The joined candidate is committed and pushed as
`a7a4303e789a80978fe5b26799488442406b31af`, tree
`ea907e5dbaefbb9857ff8874488b953368ef7377`. Independent readback binds every
published file and the frozen dependency inputs to that commit. Fresh isolated
local and global installation, restored PTY and owned test-daemon lifecycle
pass for its exact archive. CI run `34355008813`, attempt 1, checks the same
tree through synthetic merge `e39543d33412b9e727c1b71085b9d9c4aa8ed39a`
on main `041a06a16015ff8b270a413b8c10ab9ca89e4ca2`; its compiled browser job
passes, while complete Required remains outstanding.

The isolated app build accepts the genuine prior publication and completes,
with 19 static output cases passing. Two cases refuse the result: the exact
app marker fixture still expects the predecessor version, and the joined
minifier allocation has an unreviewed raw React resource-function fingerprint.
The version fixture now expects `0.8.0` without changing complete marker-byte
or parsed-object equality. The allocation remains subject to independent
source and lexical-helper review; no normalization or runtime style permission
is inferred from identifier similarity. All captured build bytes and prior
publication receipts remain preserved. These failures must be closed before
final acceptance, regardless of the separate browser job's result.

The next reviewed join includes main
`13325ffa8e16a61897c90012b85cede588f6bca4`: a UI-first public site, six
task-oriented guides and an isolated fictional product preview. It adds no
CLI, provider or hosted execution authority. Candidate installation remains
unavailable before its own admission; predecessor evidence and the capacity
hold remain explicit. Source-backed memory guidance now distinguishes a
durable cross-account owner transfer, which purges the old working lane and
opens a fresh epoch, from same-owner continuation. It does not promise copied
working-memory contents.

Independent review approved the joined release surfaces. Focused site checks
passed 73 cases with 3,156 assertions; build and browser contracts passed 101
cases with 2,968 assertions; release-workflow equivalence passed 28 cases with
993 assertions. Joined typecheck, scoped lint and managed-guidance checks pass.
The independent archive has 214 files, 223 inventory entries and 11,079
canonical inventory bytes, digest
`bd35daa6f9ec32ed7c4135e3c1354e8b18d0779737bec5198430aaa58063c3e0`.
Archive SHA-256 is
`e1aa371c67fc5610c8b140e2491566546ee34d9143e47256297193f305ce7094`.
Compared with the previous archive, only README, notices and package metadata
change; all other 211 files are byte-identical. This is package review, not
publication or final installation acceptance.

The previous candidate's Required CI failed. Both first source shards and the
macOS second shard passed; the remaining source and remainder failures require
repair and fresh final CI. The two Ubuntu private-readback timeouts now use a
separately bounded fresh five-second setup hook, while each complete same-oracle
live-to-stopped proof retains its five-second deadline and every original
assertion. Private owner lists drain raw work before cleanup, retain late real
failures and cannot collect another case's resources. Independent review and
the full focused suite passed, 51 cases with 178 assertions. This deliberately
adds setup allowance; it is not evidence that setup and proof together fit the
old deadline. Storage fixture, grouped source-case and exact compiled-app
qualification repairs remain in progress. No merge, release, production
deployment or daemon activation has been performed for this candidate.

The UI-first join is committed as
`5f56466df1cebe0d9d7cd54dc0a71f11cec90280`, tree
`eff127cf87070957322e66043b67dc01dd6635c2`, with the independent archive's
214 paths, modes and byte hashes bound to those committed inputs. Its complete
site suite passes 131 cases with 7,207 assertions. The fresh compiled app passes
20 of 21 static cases; only the unadmitted resource fingerprint fails. The
current function and entire React closure are byte-identical to the separately
reviewed prior allocation; the bundle differs only in the joined settings
explanation. Independent review admits its exact raw SHA-256
`87ae7be84d98dfd2138dfd2b7709c82e09ce1d595300c3773dfa988ae5ffc2a8`,
not identifier normalization or a general style exemption. The expanded guard
matrix passes 49 cases with 426 assertions. Full app and browser acceptance
remain required on the successor.

Every failure in run `34355008813` is inventoried. The next test-only repairs
retain the same production guards: actual owner/custody schema dependencies
in the reduced SQL fixture; the current Sol tuple for a newly created High
session; the exact final joined switch fence while preserving the historical
version-50 fence and rollback proof; and the earlier peer-cancellation schema
refusal with unchanged surviving rows. The latter three full suites pass
33 cases with 271 assertions. Platform-specific schema derivatives now disable
rename propagation and prove unrelated objects unchanged. The raw scrub-test
writer explicitly uses production's secure-delete mode; a deliberate OFF
probe reproduced the stale-body failure before this correction. Independent
loop scenarios are split without increasing their per-case deadlines or
dividing coupled comparisons; the lineage input vector remains exactly the
original eight seeded values. Private test owners retain late failures and
join work before cleanup. Independent source review is complete; the remaining
focused checks and fresh integration typecheck are queued. This successor is
a validation candidate, not accepted source or a released artifact. Complete
current-base CI, exact installation and compiled browser gates remain pending.

The repair checkpoint `c9571e16c02b4426bb946f1bee525a6cd4568034`, tree
`15dde7013961be3d9baf0bc84913bb0031cada6f`, passes the complete local app
suite, 620 cases with 3,851 assertions, and isolated archive installation,
including local/global consumers, PTY restoration and owned daemon lifecycle.
Integration typecheck passes. The joined-evidence fixture passes 42 cases with
170 assertions; the service and lineage slice passes 29 with 183 assertions.
The storage slice passed eleven unchanged cases, then its new exact-schema
snapshot identified six additional same-table custody objects removed by the
malformed-Claude fixture. The correction explicitly names and drops only those
two indexes and four triggers. Its final case passes with eleven assertions;
scoped lint and independent review pass. Production storage is unchanged.
The successor still requires fresh exact-head installation and compiled browser
acceptance and complete current-base CI. These local results do not establish
merge, release, deployment, live provider qualification or daemon activation.

The schema-inventory successor is pushed as
`82637bb9a5423adffb5185dc175fd74eb5dd2c89`, tree
`f6220f505012fca90ae5fa6a40703bf632318c0f`. Its exact archive passes fresh
isolated local/global installation, restored PTY and owned daemon lifecycle.
CI run `34361757449`, attempt 1, checks the same tree through synthetic merge
`107fdec265f9587fbb805b1986df278ef6d3fd0d` on main
`13325ffa8e16a61897c90012b85cede588f6bca4`. The browser and five
source shards pass. macOS remainder and source shard three expose further
five-second fixture/proof timeouts with late cleanup races. Ubuntu remainder
passes all script, plugin, hosted, site and app tests and builds, then refuses
one generated Git hunk heading. All jobs finished without job-wide timeout;
Required failed. The complete failure inventory governs the next repair.

The history refusal is Git's 80-byte truncation of an allowed public package
name in duplicated function-heading metadata. The reviewed repair preserves
raw historical hash receipts, scans sensitive text before any projection,
and removes trailing heading text only from canonical two-sided hunk headers.
Literal-LF splitting and leaving carriage-return and Unicode-separator lines
unprojected keep authored lines intact. All additions, removals, context, paths,
root commits, merge resolutions and complete governed ancestry remain scanned.
No scope allowlist or commit-specific exception changes. The initial regression
reproduced two failures; all six final cases pass with 96 assertions, and the
16 existing history contracts pass with 406 assertions. The exact previously
rejected synthetic merge also passes a complete history scan with the repaired
scanner. Independent source review and focused lint pass. This changes artifact
validation, not provider behavior or operational activation.

The converged test repairs preserve every original ordered assertion and
production source. Private owners observe and drain the exact raw setup and
proof tasks before closing services, stores or roots, preserving genuine late
failures and retaining storage if service shutdown is unproved. Coupled seed,
uncertain-peer, readback and prose-budget proofs remain whole five-second
tests; only fresh fixture/session preparation receives an explicit separate
five-second setup allowance. The sibling-recovery actor and target scenarios
become independent owned cases, with cancellation releasing the recovery gate
even before entry. Publication-boundary regressions cover cancellation between
request completion and setup-state publication.

Independent source and assertion-equivalence review approves the repairs.
The final service slice passes 46 cases with 274 assertions, including all
owned callers, seven lifecycle regressions, both sibling scenarios and the
complete prose family. The switch slice passes seven cases with 46 assertions;
the readback slice passes 21 with 142. Scoped lint and whitespace checks pass.
The first integration typecheck exposed test-only promise-matcher typing
errors. Explicit identity-matcher types and asynchronous matcher callbacks
preserve the runtime assertions; their focused checks, lint and fresh final
integration typecheck pass. The reviewed archive bytes are unchanged.
Exact-head Required CI, isolated installation and compiled browser acceptance
remain required before protected merge; release and operational gates stay
separate.

The repairs are committed and pushed as
`3f3ea718d177c5d0cbf576f13e9f019d4031b61d`, tree
`bb3b968bada47dfc7faf8e9dbc4fd234c9ce5324`. Independent exact-commit
review approves all six changed files. Fresh isolated installation passes
with the same reviewed archive; all 214 package paths and modes match the
committed blobs. Fresh compiled browser acceptance passes 210 evidence rows
and three native custody cases with 130 assertions. Its receipt SHA-256 is
`18410ed4e4dee77ac84ab9faee1c397c4965df0cbb4e374d2af4e4a9315ef5d5`;
preparation and all 54 owned browser processes were collected across six
profiles, with unchanged inputs and no cancellation, surviving process or page.

Main advanced to `5ab43f11cc597c2f73f7f2c8f276b22f15bfb8b5` through
PR 162's guarded v0.7.1 preparation before this candidate obtained Required CI.
That source merge is not v0.7.1 artifact admission. The normal join preserves
v0.8.0 identity, immutable v0.7.0 recovery evidence and both staged release
records. It composes the independently written hunk-scanner repairs through
one sensitive-first wrapper and one canonical physical-line projection,
retaining both regression families. All 27 joined history contracts pass with
563 assertions; source review and scoped lint pass. Installer runtime bytes
and pins remain unchanged while prior-release refusal coverage expands.
Independent review approves the complete resolved join. All packaged runtime,
installer, dependency and workflow bytes remain unchanged from the usage head;
the added installer cases preserve exact originating-release recovery and reject
older identities as current authority. All 32 focused installer cases pass with
194 assertions. Site, guide and marketing contracts pass 66 cases with 2,492
assertions; release and CI-equivalence contracts pass 28 with 1,003. Both
release versions retain their compiled inline-code styling proofs. Scoped lint,
README renderer equality, release-tag installer pins and managed repository
guidance pass. The immutable v0.7.0 successful-release record is byte-identical
to both parents.

Two independent actual-archive readers approve the newly packed 214-file
candidate. Every path, mode and body matches the frozen source; only README
wording differs from the previous archive and exact committed usage head.
The 1,715,004-byte archive has SHA-256
`2a0fd3c67e67e33a4d61412e41880b4aaa11a7ffa04f1e87a42941d483adfee4`.
The independently measured inventory retains 223 entries and 11,079 canonical
bytes, with digest
`213322d4fa2af1626a8c44de75cafa182debe58c828390f9afa2311e68a1e0c3`.
The old pin refuses those changed bytes; the reviewed replacement admits them.
All eleven package-policy tests pass with 42 assertions. No allowlist, mode,
dependency, installer or runtime changes enter this archive comparison.

The separate Advanced Security check on the usage head reports seven alerts
in test helpers despite successful CodeQL analysis jobs. Causal review confirms
deliberate root-only JSON corruption, test-only HTML text projection and three
generated installer-test programs. The root-field helpers now verify exact
fixture prefixes and preserve raw suffixes, duplicate keys, nested authorities
and numeric spellings. The existing HTML parser replaces tag-stripping and
entity-replacement logic without reinterpreting decoded text. Static installer
child programs receive values through arguments, preserving the original
interruption callbacks, custody, deadlines and assertions. No alert or check
is dismissed or suppressed; a fresh CodeQL result must establish clearance.

The three text and corruption suites pass 78 cases with 16,626 assertions.
The separate installer argument regression passes with three assertions, and
all four affected native custody and interruption cases pass with 54. Scoped
lint, whitespace checks and fresh final integration typecheck pass. Packaged
source remains frozen. The installed scheduler changed during validation;
its old convenience link became unavailable before a child started. The
documented direct installed-script path retains reviewed scheduler custody.
The updated managed repository baseline adds only its bounded new-service
provisioning preference; it creates no resource or wider delivery authority.
Fresh exact-head CI, local installation and compiled browser acceptance remain
pending. The successful pre-join local gates above do not admit this new main
integration or authorize release, deployment or runtime activation.

The reviewed join and test-helper repairs are committed and pushed as
`e2ac07d122763c37581f77c81a56f3bad7374307`, tree
`a2b0ab82238ad39815e08968c8de16638de347c9`. The exact committed tree
matches all 214 reviewed package paths, modes and blobs. Fresh isolated local
and global installation, restored PTY and owned daemon lifecycle pass.
CI run `34371222876`, attempt 1, checks synthetic merge
`0006e118a83eb4c2f922ae6699ffe3f87a139963`, whose current-base tree is
`71251acc214e77b9bfdeabd0a1e3470700c035bb`. Its browser job passes.
Both CodeQL analysis jobs and the separate Advanced Security check pass on
the exact head, reporting no new alerts in the changed code. The matrix is
still running; neither this partial CI result nor its security clearance is
substituted for a later integration candidate's final gates.

Main then advances to `e1edb585eedd0e78dbb558ce72fa7680cc2257ea`
through PR 165's shared provisioning guidance and local-efficiency 0.4.2
metadata. The normal join is independently reviewed, retaining byte-identical
package, runtime, application, scheduler, validation and CI workflow source.
Root guidance was already current; seven incoming files only update plugin
metadata, managed policy assets and their documentation. The complete focused
bootstrap and repository-adoption suites pass 28 cases with 181 assertions,
read-only adoption is current, and fresh final integration typecheck passes.
No new infrastructure, credential, provider or deployment effect occurs.
The unchanged archive remains bound to the candidate, but exact-head CI,
security, installation and compiled browser gates must admit the successor
before protected merge, release or deployment.

The successor is pushed as `fb1bf7e72dd89ca453dbee2bc51f96b0cfbbf348`,
tree `720cba4fbd1bcfe018025427d8de915f91fe22e2`. All 214 frozen package
blobs and modes, manifest, lockfile and archive digest match that committed
source. Fresh isolated local/global installation, restored PTY and owned
daemon lifecycle pass. The first package invocation was canceled before
admission to release spare scheduler capacity; the identical command then
passed after the finite backlog drained. CI run `34372320476`
checks synthetic merge `29830d0a6fb0d9cef19620a10df7b68228835683`, with
the exact head tree. Browser acceptance, both CodeQL analysis jobs and the
separate Advanced Security check pass. Its completed source failures and
subsequent repairs are recorded below; fresh local browser acceptance remains
outstanding.

The superseded run `34371222876` was canceled after reporting a genuine
site-test defect. Its first complete build exceeded the 30-second deadline
after approximately 29.36 seconds of compiler work before publication.
Bun killed the shared esbuild service, ten subsequent cases failed, and
the original build continued after fixture deletion. Cancellation does not
dismiss those failures. The repair now runs the unchanged production builder
inside a test-owned bounded child. One measured 60-second compiler-case work
budget retains the existing coupled assertions and adds cancellation, positive
collection and fixture-lifetime regression evidence. The committed repair and
completed independent review are recorded below. The temporary shared merge
hold was released until a repaired candidate is ready; no v0.8.0 tag,
publication, deployment or operational activation has occurred.

The Ubuntu source-1 job reports one separate failure: the combined49
prepared-switch preservation case exceeds its unchanged five-second limit at
5,097.88 ms. The other 1,886 cases pass, with no late errors. That case alone
still uses four reopen operations; its neighboring preservation cases already
use the three adjacent RO/RW pairs. Commit
`b249122ba371b585d4a71c3984c4482ae43dfa52` applies only that existing
registration and explicit pair argument. Independent AST comparison proves
the original 23 assertion roots and 24 callback statements unchanged. The
complete nine-case file passes with 38,661 assertions in 12.03 seconds;
prepared-switch pairs take 1.21 to 1.28 seconds. Scoped lint and whitespace
checks pass, and independent exact-diff review approves the repair. Complete
typed-cell, schema, ledger, row, history and no-effect checks after every open
and close compose the persistent-history proof. This is not a claim of
literal four-open physical WAL stress equivalence. No migration, runtime,
fixture bytes or deadline changes.

CI run `34372320476`, attempt 1, completes with a failed `Required` job
`102548564096`. Browser acceptance, both remainder jobs and four source
jobs pass. The only other failing source job is macOS source-3: one service
test exceeds five seconds at 5,199.50 ms, followed by a late matcher error
from its already-closed SQLite connection. Its remaining 2,134 cases pass.
That test loops over two independent immutable-send-authority corruptions
using global fixture cleanup. The scoped repair creates two cases under
the existing private owner, registers the restarted service before recovery,
and fences cancellation before further work. It preserves the original
five assertions, command sequence, authority restoration and five-second
deadline. The focused lifecycle, positive rollover and repaired-case selection
passes ten cases with 48 assertions; the exact-final two-case check passes
ten assertions in 2.97 seconds. Production service and ownership helpers
remain unchanged. Independent final binding approves the exact file and
commit `2c2f6f300c019d0553ccc55458046013226c9bfb`. This evidence does
not replace the repaired candidate's fresh complete CI.

The shared site-test repair is committed as
`87e110de618eaedd47dbc8bcc92891b74a70cac3`, tree
`3d6788b978e6d9a9e354b09e4e8ea3ce2d9f63a1`, and published on the
dedicated `codex/site-compiler-test-ownership-20260909` handoff branch.
Its isolated seven-file diff changes no production builder, package source,
lockfile or CI limit. Independent comparison proves all 20 original test
bodies and 16 build-call argument expressions unchanged. Each compiler case
has one 60-second work deadline, followed by named finite process collection
and parent-drain allowances. Pure cases retain five seconds. A closed static
driver preserves genuine builder errors separately from bounded transport
diagnostics; cleanup retains fixture and recovery evidence when collection
cannot be proved. Cancellation before dispatch, between child completion and
publication, and during delayed parent continuation has regression coverage.

The final deterministic suite passes 18 cases with 1,038 assertions, including
three seeded protocol properties. Native evidence passes eight assertions:
a deliberately stalled real Vite/esbuild process group is collected, exact
`ESRCH` proves leader absence, and a fresh isolated build and check succeed.
The complete original site file passes 20 cases with 1,049 assertions in
89.54 seconds, without timeouts or late errors. Scoped lint and integration
typecheck pass after correcting optional-field typing at the test-driver
boundary. The earlier successful driver-dependent receipts were repeated
on those corrected inputs. Independent source and final-evidence reviews
approve this checkpoint.

PR 164 owns the shared-fix transplant and its fresh integration gates. The
coordinated routing follow-up will then qualify its conditional v0.7.1
admission copy and release-verifier repair against that main. This task will
join the resulting exact actual main before pushing the repaired PR 140
candidate, avoiding a knowingly obsolete CI cycle. PR 140's published head
remains `fb1bf7e` at this checkpoint. Upstream focused compiler evidence is
not an exact-tree final receipt for a different branch's content or metadata.
Protected merge, fresh main CI, guarded release, artifact readback, deployment
and applicable operational admission remain separate and incomplete.

Pre-join review also identifies a delayed shared-teardown risk in PR 164's
paged-recovery fixture. This candidate uses its existing private service owner
for that case, preserving all 11 original ordered statements, 103 sessions,
immutable account authority, the 100-millisecond readiness race and five-second
test limit. Cancellation fences prevent further admitted work. The affected
case and existing owner lifecycle tests pass eight cases with 37 assertions
in 1.89 seconds; scoped lint and whitespace checks pass. This focused evidence
does not replace the actual-main join review or fresh integration gate.

The September 9 read-only deployment baseline still binds hosted source
`a75e7487594ce5b68345ccd3536974a10f7a93ee`, with open admission and untouched
inactive attention controls. Hosted preflight reports the dedicated attention
key name missing. This observation neither establishes capacity readiness nor
authorizes key installation, notification enablement or daemon startup. Public
markers separately identify site source `041a06a16015ff8b270a413b8c10ab9ca89e4ca2`
and app source `e1edb585eedd0e78dbb558ce72fa7680cc2257ea`, app version `0.7.1`.
No provider write or deployment occurred during these checks.

The first shared-fix integration on PR 164 fails fresh Linux acceptance.
Run `34378248569`, attempt 1, checks head
`eb3700da788ce1ee232df42a7bebe8e9f1f57bfb` through synthetic merge
`72ed5a11f6854f278791b84c15df713e1c38a2c9`, tree
`d5dbd7f92ed69a4de5cd7fca5d38f92732170c9a`, on unchanged main `e1edb585`.
All six source jobs, compiled browser, CodeQL and macOS remainder pass.
Ubuntu remainder reports 139 passing site cases and 11 failures: the native
fresh builder and ten original successful-build cases return
`SITE_COMPILER_PROCESS_FAILED` after approximately 23 to 25 seconds. There
is no observed work-deadline or stopped-service failure in this run.

The original CI log omits the nested process-result cause, so the actual Linux
failure path remains unknown. Diagnostic-only commit
`d0ed6000abb84623b9884eea6d536bc58b8e8729` adds closed failure-stage, exit,
terminal-status and byte-count fields without printing raw child output.
Independent AST comparison proves acceptance, parsing, cancellation, cleanup
and deadlines unchanged. Its focused suite passes 21 cases with 1,059
assertions; scoped lint and typecheck pass. The isolated two-file commit is
published on the shared handoff branch for PR 164's owned diagnostic CI.
It does not fix or admit the Linux failure. No shared merge has occurred.

Diagnostic run `34380982264`, attempt 1, checks head
`5a59b90780b9e5e18ef3ad3773ce508f085594ba` through synthetic merge
`048c5df451e649a6e4f33229faad83e766c25e03`, tree
`7c34e0b1279300bd6b84acfcfd5b02e98f50edfc`, on the same main. Ubuntu reports
144 passing site cases and nine failures, each with a valid success terminal,
exit code 1, 3,385 stdout bytes and 332 stderr bytes. All other matrix jobs,
compiled browser and CodeQL pass. These diagnostics establish terminal/exit
disagreement, not whether the leader itself failed or the collector refused a
remaining process group.

The next test-only candidate requests shutdown of the same pinned esbuild
service before publishing a terminal. It captures the raw build outcome before
formatting errors, retains both causes when shutdown also fails and never
forces a successful exit. Independent review confirms unchanged builder options,
original failure conversion, terminal publication and parent acceptance guards.
The focused suite passes ten tests with 166 assertions; scoped lint and
typecheck pass. Commit `c9c2ed2949bc221e8b172eda2d9de23a09fcfc9d` carries
only the three test/support files. Its unchanged native cancellation and fresh
builder proof plus all 20 original site cases pass locally: 21 tests and 1,057
assertions in 114.10 seconds. An 18-row native transform probe retains proven
cleanup, zero exits for natural and candidate-helper completion, and exit 7
when that nonzero status is set before candidate shutdown. The probe does not
reproduce Linux. The stop API requests shutdown only; the parent still requires
exit zero and proven collection.

PR 164's fresh run `34384757759`, attempt 1, checks head
`2b43c22a59b595afd87b8da41ea2282c55322c24`, tree
`592ed46a9f7cfa36b214ddb3a534de7ee1d181d8`. Ubuntu remainder passes all 163
site cases with 8,382 assertions, including native cancellation and every
original build case. All six source shards and CodeQL pass. This closes the
observed compiler failure on that candidate, not a universal liveness claim.
The browser job fails before tests because upstream Chrome package metadata
disagrees with its advertised hash. Verification remains enabled; the release
owner retains the failed run and owns provider convergence and any bounded
retry. Complete matching Required and protected merge remain outstanding.

Independent review of PR 168's failed run `34380309752` finds two additional
unchanged service cases combining independent native fixtures under one
five-second limit. The dedicated fix `4bd42e35` preserves their original
24 and 22 statements, 10 and four matcher sites, and both scenario sets while
returning the existing private fixture owner for each row. This candidate
integrates only those two test spans as
`513436a1a213f99729ce8dfa4a8ff04152993c49`; no Effect implementation enters.
Independent review confirms all other service-test bytes, including the prior
immutable-send and paged-recovery repairs, unchanged. The current-tree four
rows pass with 28 assertions in 9.69 seconds, each below its unchanged
five-second limit. Scoped lint and typecheck pass; fresh integration CI remains
required.

The September 8 integration checkpoints now include canonical main through
schema 50 at `ab56d3bc5034abedd12a20b5b405caf42bfa174f`, then the clean
release-policy join at `9d6e2e12a42215e9201ae2ed3f64ed1b41e5c47d`, tree
`78189f73fd35407b433b9a8009a23e8f1c5f5cb3`. The reviewed runtime and historical
fixture repairs are committed as `4c252d72b5e9f3a90e1897bfd36889a7f3f985a3`,
tree `313d85318b3533632601f07436b1cfde8d2bd862`. Integration and delivery gates
remain incomplete. The earlier PR 140 draft at `8f05930` is superseded by the
foundation candidate above; its successful checks remain historical evidence.
Earlier exact-tree checks do not cover this integration. Canonical schema 50
is now governed by PR 151's merge at
`d5376e34dcf2ace99009fd6eeaed3dcae917bcca`, tree
`14ccd71d668411851ec5f65e03f16f6e63ec78f7`. The exact fully qualified main
ref was refreshed after the merge. This usage candidate includes that ancestry
but still needs to validate its own changes. Usage slots 51 through 59 and the
joined evidence/recovery bridge at 60 remain private candidate allocations;
recheck competing ownership before push, review readiness or merge. The
canonical owner's successful gates are not this branch's acceptance evidence.

The governed main ref also contains release-policy merge `b856c661`, now
joined here without source or workflow conflicts. Its artifact-admission
policy separates optional live qualification from publication; operational
capacity, identity and intended-target gates remain binding. The release owner
reports complete immutable admission for the baseline `v0.7.0` and has released
that main window. The owner also reports PR 157's documentation/site successor
at `7ad1607df15a112125351ee01fb46fcdd9ccad98`, with actual-main CI and public site
verification complete. That successor is included in the current join and does not
republish the immutable baseline artifact. This is not usage delivery. A later usage release must own
its own version, exact-source checks, protected merge and artifact admission.

The preceding scoped main join included
`5027d21d8e4a128f87f2a78810b3f23929404061`, the separate custody-scoped
attention-key installer after StyleX successor `3da9744`. Independent review
found no storage or service implementation
delta in either successor. The installer requires its own operational handoff
and does not activate attention or clear hosted capacity gates. The reviewed
test-fixture resolution preserves registered cleanup, daemon-generation
authority and the explicitly expected Claude custody refusal without a generic
catch. The selected service cases passed. A stale retired-Devin fixture was
replaced with authentic canonical-39 source history and explicitly separate
synthetic compact-cache input, preserving immutable source rows and zero
provider or command effects. The joined retired-provider and four actor cases
passed five tests with 32 assertions. Plugin checks passed 108 tests with 421
assertions, and repository adoption was current. CI coverage and handoff checks
passed 36 tests with 2,593 assertions. Phase 10 now explicitly follows the
independently reviewed complete-CI source policy while retaining separate local
browser, native, coupled-run, installation and operational acceptance.

Independent review of the complete seven-file production repair diff against
`9d6e2e12a42215e9201ae2ed3f64ed1b41e5c47d` found no actionable issues. It
traced original attachment request and effect authority, atomic terminal
acknowledgment, explicit abandonment routing, peer no-effect receipts,
historical switch audits, quarantined maintenance and Claude reservation
cleanup. All seven inspected file hashes remained unchanged across review.
This is source-review evidence only. The historical cases, full StateStore
diagnostic, fresh typecheck and scoped lint now pass after test-only typing
repairs. Neither final integration nor operational activation is admitted.

The joined source passed a fresh typecheck and Effect architecture check. A
private-48 CLI regression exposed an actual stage mismatch: the canonical
waypoint audit required joined queue and peer guards before their installers
ran. Intermediate retained-usage waypoints now require the exact historical
guards, while final schema 60 still requires the exact successor guards. The
previously failing CLI case passes. Six independent stage and no-write refusal
cases pass with 529 assertions, covering the exact pre-installer guards and
current missing or reverted guards. These focused results do not replace the
final exact-tree aggregate.

The broader service and storage diagnostics exposed stale legacy fixtures and
current service or admission gaps. Interaction methods now validate the
captured provider tuple before runtime access; three supported routing controls
and two no-write refusal controls pass. Queue recovery now explicitly requests
the bounded detailed projection required to prove one exact message, while
abandonment retains its metadata-only read. The original transcript finalizer
already uses the captured source tuple and connection; no authority substitution
was needed. The two queue controls pass with 52 assertions. The current store's
assertion-only audit now covers every retained switch journal, including
terminal receipts, without historical repair or authority invention. Independent
review approved its transactional admission and full keyset coverage. Thirteen
focused controls pass, including the 101st retained journal, inert terminal
reopen, and older settled switches after account removal and restart. The new
precheck bounds joined-row materialization; subsidiary readers retain their
existing contracts. This is not a measured large-history performance guarantee.

Actual archived interactions reproduced a maintenance failure: quarantined
history could throw during deadline selection and prevent supported callbacks
from being processed. Deadline, next-timer and attention selectors now exclude
only explicit interaction or session quarantine before applying their limits.
The regression passes with exact original-row preservation and a supported
callback positive. A separate retired-session abandonment regression exposed
facts-memory cleanup before the provider refusal. The existing provider guard
now runs before cleanup inside the serialized reread. Authentic bound-send and
started-target controls pass, preserving the original receipts and refusing
provider execution and memory cleanup. Neither repair invents historical
authority or deletes evidence.

A fresh exact-writer capture supplies a genuinely unbound canonical-43 login
and an independent canonical-50 ledger predecessor. The retained recipe digest
is `c59bb6c47df35f1e58f798c030323bae7d2197f0f3cc36f173d3d201c9ac0463`.
Schema 43 bytes hash to
`f77d0f2a1d225f7b199e21e75be27f53c8569466c2f8719db461a1f5596b4ef3`;
schema 50 bytes hash to
`34c3c97bb6a4db64791135be265ba318227677dab44b0f16d014020c472f7801`.
Both archived writable and readonly reopens are unchanged. The schema-43
service case passes with 26 assertions, preserves the original ambiguous
attempt and effect through two boots, refuses provider replay and leaves the
unaffected account usable. No provider process or network effect is claimed.

The canonical-profile migration and recovery lane has focused passing evidence
for all 55 cases. Its authentic-49 control distinguishes exact migration-row
preservation from the first live Work projection: the latter safely releases
an unproved claim. Original intent JSON and effect evidence remain immutable,
and public replay reports current released state without reviving the claim.
The adapted archived generator has byte-identical transpiled runtime to its
retained exact original recipe; the original database fixture is unchanged.
Authentic schema-50 ledger controls pass 15 cases with 23,419 assertions.
Four additional exact-writer schema-39 switch images preserve actual old effect
and progress bytes, including an aliased target. Their five service controls
pass with 4,562 assertions after explicit optional-row type narrowing, preserving missing account-identity refusals rather
than manufacturing execution authority. Five more exact-writer schema-39
images retain bound-send, in-flight-start, interaction-deadline and both
started-target retired switch histories. Their archived writable and readonly
reopens are unchanged. A new exact-writer schema-48 Work image preserves four
claimed, dispatching, running and recovery-required attempts. Its source is
`5838ec446d5cfbf6d0edeaae9a67bcc9e95c82e4` and its database digest is
`aa7dbe6453ce2e69520ba2baa1eafaa6db028632ee73a22063533fa1c3869a35`.
Twenty-four migration and refusal cases pass without inventing runtime rows.
Six schema-47 negatives and a positive use an explicitly source-derived stage:
only the exact empty schema-48 memory component and its original ledger row
are removed transactionally, with all remaining rows and objects preserved.
This is not a captured or released schema-47 artifact. A further exact-writer
schema-50 image proves a retained queue source and generic steer source can
share one public source identifier without conflating their immutable effects.
Its database digest is
`77bd12ae229983ee83e0f4541795b1b671749d266f4f5738b162562d65fe1d24`.
The joined readback, idempotent completion and inert reopen control passes
with 40 assertions. A schema-34 capture from exact source
`127c1e7dcf8ef1461b7d71ab4d077a93f85cc682` retains a synthetic desktop recovery
receipt, original Sol runtime and a separately unbound pending queue. Its
database digest is
`95d9e375061ac090f1409e50937d68f66ae702176fae06287ff137c23f049e6b`;
the original recipe digest is
`511a6f6bcc791a46a947e323b4f19954c8f6bff644fe5100a5c2a8dbba3350c3`.
Both archived reopen modes preserve every row and schema object, and readonly
reopen preserves the whole image digest. The first, unpublished attempt failed
its unchanged-reopen check. The revised recipe explicitly reserves an unused
usage revision through the archived public API, avoiding a known old startup
backfill; the failed image remains unmodified and is not an accepted fixture.
Four additional exact schema-33/39 session-start images retain both applied
and effect-started requests with their actual original request shapes. All
four historical service controls pass; a separate current prepared-request
control also passes with the required original provider-authority sidecar.
The four schema-34 migration and refusal controls pass with 9,892 assertions.

Eight further early-migration images retain exact schema-10 and schema-17
public-writer state plus byte copies observed inside the archived 10-to-17
transaction at stages 11 through 16. These stages are not released-writer
fixtures. They preserve full snapshot and standalone readback evidence without
changing source SQL or disabling secure deletion. The stale note sentinel in
stages 11 through 13 is independently attributable old note data, not evidence
of erased MCP contents; the final schema-17 image proves its physical removal.
Two schema-39 attachment images passed storage and privacy checks but failed
service replay because the first recipe did not use the archived parser's
reference-key ordering. Those original outputs remain unchanged; a separate
capture through that exact archived parser now replaces the repository
fixtures. Both historical service replays pass with 48 assertions while
preserving original request, effect and result bytes; they read no blobs and
make no provider calls. Nine early migration controls now pass using the
authentic schema-10/17 images and explicitly observed intermediate stages.
Two exact schema-17 Unicode label collision controls also pass, proving
different read-only and writable refusal paths without changing the database.
The expanded privacy suite passes 52 cases with 421 assertions, including both
UTF-16 byte orders. Independent review confirms that the sole historical
public-root exception remains exact-image and exact-whole-field bounded.
These synthetic control-plane fixtures do not prove native provider effects.

The full provider-switch diagnostic passed 108 tests with 5,539 assertions
before the type-only narrowing above. Fresh no-bail diagnostics completed for
the full service file (539 passing, 13 failing, 4,592 assertions) and full
StateStore file (556 passing, 150 failing, 99,697 assertions). These are failed
diagnostics, not admission receipts. Parallel repairs address exact historical
producers, current input custody and retired-provider behavior. All 85 original
historical/stage failures now have focused passing evidence. Three newly repaired queue20,
resolution40 and synthetically populated observed2 controls pass with 7,862
assertions and independent review. All three authentic adoption35 controls
pass, including exact old-cell preservation and two inert corruption refusals.
The captured v38 widening control passes with 4,402 assertions and preserves
a genuine archived generation rebind while refusing new retired-provider
execution. Its larger runtime/lineage matrix now passes with 14,541 assertions.
Both authentic v39 attention cases pass with 9,889 assertions. They drive the
actual storage boot transition, preserve the original attention and optional
callback, and create no runtime, event or execution proof. A third new exact
image retains a v40 claimed Work attempt and mixed pending owners. Both v40
identity cases and the independent authentic v34 no-proof control pass with
19,878 assertions under unchanged individual deadlines. The three images preserve old rows and schema
across archived writable and readonly reopens; their decoded privacy controls
pass with 24 assertions. All three synthetic v36 contracts now pass, including
the two positive migrations with 10,829 assertions. Their local stream and
allocator maintenance expectations come from the exact migration definitions,
not post-hoc fixture changes. Independent review approved these boundaries.
The obsolete current-to-legacy downgrade helper chains are removed after their
last consumers moved to authentic images or explicitly synthetic contracts.
The fresh complete fixture-privacy suite passes all 75 cases with 614
assertions. The revised anchored v38 queue probe passes before the matrix
reaches a stale predecessor-event diagnostic assertion. The test now requires
the exact joined successor refusal and complete unchanged snapshots after all
six event probes; independent review approved that correction and its rerun
passes. The full StateStore diagnostic passes all 715 cases with 336,015
assertions in 776.09 seconds. That run loaded before the subsequent type-only
comparison repairs; the unchanged final gate must still run on the joined
delivery tree. Fresh typecheck exposed
test-only readonly comparison, map-key and mutation-ID typing errors. Reviewed
repairs preserve fixture values and production contracts. The fresh typecheck,
scoped lint and whitespace check now pass.
The authentic-39
joined migration positive preserves old input and effects, adds default peer
policy without execution authority, and passes with 3,667 assertions. All 40 current-input
and effect-contract failures have focused passing evidence, including the
authentic source-identifier collision above. All 19 root-owned recovery cases
now have focused passing evidence; the direct-send acknowledgment control
passes with 1,528 assertions, preserving the original resolution and effects.
All 28 new storage acknowledgment cases now have focused passing evidence,
including rollback, immutable-source corruption, shared-blob retention,
postcommit scrub failure and a real 101-record keyset audit. All 13 original
service failures now have focused passing evidence. The fresh full service
diagnostic passes all 568 tests with 4,928 assertions, including the new
terminal acknowledgment path. The final aggregate gate remains open.
Six login and memory
controls pass with 60 assertions,
including exact memory-owner transfer and unchanged refusal while a submission
is unsettled. Four pending/settled transcript controls pass with 53 assertions,
using actual turn completion to prove restart replay and refusing missing turn
runtime evidence without writes. The public boundary now maps the exact closed
login-binding failure to sanitized `RECOVERY_REQUIRED`; its unbound-generation
negative and supported cancellation control pass with 12 assertions, preserving
all rows and issuing no provider call on refusal. The full StateStore
diagnostic above closes those behavioral repairs, not the final delivery gate.

Adoption-v36 historical writer provenance remains unavailable: exact source
`42c4235` is v35, retained PR113 ancestry is v40 or later, and the observed
released 35-to-40 path does not match the v36 recognizer's schema. Supplemental
v36 contract tests instead construct an empty database from independently
frozen canonical34, adoption and Work SQL, then seed explicitly synthetic rows
under intact constraints. They exercise current migration and refusal, not
proof that a historical v36 producer emitted those rows or that schema.

Two additional product regressions have focused passing evidence. Current
schema admission now asserts the exact four queue scrub guards before trusting
the absence of cleanup debt. The reproduced missing-trigger case previously
opened with an unscrubbed settled body. Four guard matrices cover missing,
weakened and wrong-table definitions in both open modes without repair or row
changes; the intact scrub-generation control also passes (five cases, 83
assertions). A joined-only peer transition now accepts the exact terminal-only
cancellation receipt when the outer action is effect-started or ambiguous but
no nested provider effect exists. Frozen predecessor SQL is unchanged; wrong
receipts, revisions, effects and custody remain refused. The coupled peer and
waypoint group passes 43 cases with 7,429 assertions. Focused repairs are not
a passing full-file rerun or final integration gate.

A real direct-message custody test exposed an additional cleanup gap:
provider deletion records an immutable abandonment reason and ends transcript
finalization, but that reason is not explicit user acknowledgment of an unknown
provider outcome. Retaining the attachment custody is correct; its current
terminal/resolved state previously had no proved later acknowledgment path
and could retain the slot indefinitely. Do not release custody from provider deletion or
transport loss alone, rewrite its original resolution, or call this case
complete until a bounded explicit cleanup path is verified. The reviewed design
adds a separate immutable, anchored acknowledgment for an explicit terminal
`session.abandon`, tied to the original generic input, custody, source-selected
effect and unchanged automatic-abandonment resolution. It grants no provider
action and does not reinterpret original-send or unknown historical custody.
The storage implementation and 28 adversarial cases have been independently
reviewed. The local-only service path now skips unrelated memory maintenance
only for an exact terminal abandonment selection and rechecks the selected
session revision and daemon authority under local serializers. It preserves
ordinary recovery maintenance and the existing postcommit scrub-stop lifecycle.
All 11 service acknowledgment cases now pass, covering deletion and transport
loss, inert replay, final authority fences, selection and abort failures, and
postcommit scrub shutdown. They also pass in the full service diagnostic.
The repository integration gate is still required.
An adjacent review also confirmed a current Claude-manager reservation leak
when configuration lookup rejects before entering its cleanup boundary. The
bounded cleanup repair passes seven adapter regression and existing control
cases with 56 assertions. It also passes the full service diagnostic. A
separate type-only correction preserves the foreign host-capability runtime
guard while satisfying lint; four focused cases pass with 35 assertions.
Neither change
is an Effect architecture migration or proof of native Claude execution.

The exact schema-27 reset writer and explicitly source-derived partial-28
boundary now pass both migration controls with 8,678 assertions. Their initial
failures compared lexically sorted captured ledger rows against numeric SQL
ordering; sorting a copy corrected the oracle without changing fixtures or
product code. The exact schema-25 preset control passes with 2,247 assertions,
including the deliberate three-field quarantine for missing native authority.
Eight schema-35/36/37/38 consumers pass with 18,569 assertions from five exact
archived writers and one explicitly uncommitted observed stage. The six new
images pass privacy checks with 48 assertions. These results preserve original
history and distinguish explicit email consent from a damaged lookalike.

Historical adoption source retrieval remains bounded to its identified PR and
immutable commits. PR 113's final head contains schema 40, not the earlier
adoption cohort. A separate exact-commit fetch recovered the original
`42c4235e35daed1dec7eca4ff985bd9e8606b78a` schema-35 writer. The schema-36
producer has not yet been identified; a different cohort cannot substitute for
that missing evidence.

The candidate runs canonical upgrades before usage installation. For admitted
private-48 and combined-49 inputs, it relocates the nine original usage ledger
rows in descending order without changing their timestamps or replaying their
installers. Immutable source evidence is sealed before current interpretation;
canonical schemas 43 through 46 use their separately frozen source dialect.
The new current-version open is assertion-only. It cannot reconstruct missing
provenance, move a ledger or replay historical installers.

The repaired matrix covers fresh creation and actual canonical-39/40/43/45/49,
private-48 and combined-49 archives, including a populated prepared switch.
The 30-case history, adoption and runtime-profile group passes with 48,053
assertions. Retained custody selects an explicitly historical audit context;
queue layout recognition admits only the exact appended canonical-43/47 tail.
Canonical-50 profile backfill preserves every original session field under a
transactional replacement fence and restores the exact original switch guard.
Its five positive/fault cases pass with 119 assertions, including complete
rollback after a late migration failure. Frozen historical DDL remains intact.

Current switch containment is explicit, not repair-on-open. Five cases with
104 assertions preserve valid execution-context evidence through containment
and reject missing or changed context/anchor evidence without writes. The
effect-admission suite passes 22 cases and 29,620 assertions; peer authority
projection passes six cases and 185 assertions. These are storage-contract
proofs, not native provider acceptance.

Current-schema writable open now retains the same read-only row-integrity
audits it previously skipped. All 33 automatic-policy cases pass with 210
assertions, including readonly/writable refusal and unchanged database rows.
The repaired Work/session-task group passes 126 cases and 1,360 assertions;
14 current autorespond cases pass with 100 assertions. Current login-cancellation
restart now uses immutable, paired transition intents and anchors tied to the
original login, exact cancellation and actual binding update. Its 26 focused
cases pass with 477 assertions. The authentic canonical-45 upgrade and all 31
account-successor controls pass together with 4,866 assertions. That archived
writer advanced the pending login while recording only the cancellation's
account-successor chain, not the later login-successor ledgers. The narrow
compatibility path requires exact selected historical evidence to establish
the captured import baseline, then proves every later transition. It neither
synthesizes missing historical edges nor changes frozen DDL. Broad regressions,
the final typecheck, aggregate and delivery gates remain outstanding.

The joined attachment terminal guard now admits source-selected current
message actors while preserving its exact historical codec. All 68 focused
reservation, custody and terminal-guard cases pass with 422 assertions. The
bounded schema-guard reread passes 13 cases with 52 assertions, and two real
applied/cancelled reopen controls pass with 19 assertions. Terminal attachment
release cannot rely on a wider raw parser or an inferred historical actor.

Current switch execution context seals the actual target preset contract while
retaining the frozen journal's legacy contract-2 shadow. Its 21 context cases
pass with 1,312 assertions; 15 joined storage, contract-1/2 rebind and seed-receipt
cases pass with 503 assertions. A missing context anchor still refuses the SQL
session update and rolls back the transaction. An exact existing host-capability
binding is retained unchanged, rather than deleted and recreated; conflicting
bindings refuse. The pre-provider-call race reproduced target construction
after a conflicting binding arrived during the daemon await. The repaired
six-case group passes with 84 assertions: both providers issue no target call,
source release or seed; the exact no-effect receipt remains, the Claude launch
is cancelled, and replay is inert. Four post-release conflict variants preserve
all rows and schema. The broader daemon group still fails integration cases.

Historical canonical-43/45 fixture capture passed after the complete script
and installed scheduler were reviewed and the unchanged invocation received
renewed automatic approval. Both archived writers reopened their actual output
unchanged through writable and readonly APIs. The schema-43 image hash is
`b541c3d22359e4c02b8c499b23b13e9f9e39c0f12d830e29f9f1ed58ef841f82`;
schema 45 is
`532c3c694567528f215f445b7f30fe8ddd90cee399b4b1cdbbc1df28c0ecfea4`.
These originals are packed and their repair cases run against real archived
bytes. A supplemental capture records synthetic runtime profiles through the
same exact archived APIs, after initializing daemon custody. Its canonical-43
hash is `7ab3b21f2cafabb0e1494a20bae58c77e08e17a82423a337976651bee61a3322`;
canonical 45 is
`a9bc642ef88af111b9a7d8dc358dc2819b6ca1cf710bffb9a186950316157dc0`.
Both archived writable/readonly reopens preserve the supplemental images.
A further exact-writer capture now supplies canonical-44/45/46 authentication
and budget fixtures, including the real legacy pending-login cancellation.
Their original 17-case migration group had 16 passes and one canonical-45
compatibility failure; the original failing upgrade now passes in the 32-case
account-successor group above. The captures, generator and exact input
metadata remain checked fixture inputs. No newer database was restamped, no
original unsafe row was fabricated, and no provider/network effect or scheduler
bypass occurred. Synthetic runtime records do not establish an actual provider
process observation.

Protected main includes peer-causal recovery PR 148 and installer
receipt-parser PR 153. Their semantic join remains in progress.
Peer recovery must select proven evidence before filtering actor or thread,
retain missing or opaque candidates as refusals, and use finite keyset pages.
The installer parser source and its four original regressions pass with 1,570
assertions. Its generated pins and final governed-main ancestry still need
convergence. A joined-only queue transcript guard now uses the captured queue
and exact current provider tuple, preserving divergent Claude generations;
its 20 SQL controls pass with 52 assertions. The peer-causal group passes 18
cases with 76 assertions, including multi-page missing-evidence refusal,
reserved-marker rejection, actor contradictions, turn boundaries and capacity.
The new cancellation representation is a terminal control-plane receipt under
the original global request key, never an invented provider effect or
attachment-input proof. Its 20 cases pass with 605 assertions, including
ordinary-input positive controls, key retention after actual causal pruning,
and terminal settlement of genuinely retained attachment custody. The lost
switch-response replay also passes without another provider effect. The full
peer-queue file passes 12 cases with 94 assertions. The legacy switch's exact
synthetic process-exit cleanup passes without changing product custody. Three
test-only typing errors from the last typecheck are repaired, with scoped lint
passing; a fresh final typecheck is still required.

The actual governed-main join now includes daemon-lock observation race
handling, CLI recovery boundaries, hosted configuration recovery and the
eight-job complete CI partition. New test conflicts retain authentic archived
inputs and current version 60; they do not restamp a newer database as an old
source. The legacy-43 unbound-login case and canonical-50 predecessor ledger
controls now have the exact-source fixtures and focused results recorded above.
Installer inner pins and the security-primitive inventory were regenerated
before the subsequent repairs and must be rechecked after convergence. Package
inventory, the joined regression groups and final gates remain outstanding. Focused
checks do not authorize a release or production activation.

The join preserves source-selected historical evidence bytes and adds immutable
format provenance before current readers or SQL authority can consume them.
Malformed bounded historical payloads stay opaque. New switch requests use V2,
retain an omitted caller contract as `null`, and commit renderer V2 and exact
target host capabilities before provider IO. Historical V1 keeps its original
request bytes, renderer and capability behavior; it cannot silently replan.
Fresh target starts require the active preset contract. Sealed queued input
retains its original provider tuple and cannot cross a switch implicitly.

Devin is retired in this integration. Historical account, runtime, mutation,
queue and joined-close records remain readable and auditable, with existing
cleanup paths. No new capture, joined receipt, consumption, process successor,
session, login or dispatch is admitted. Inert account-order housekeeping remains
compatible with profile creation/removal and grants no execution authority.

## Outcome

Oompa will expose one truthful usage-management model for Codex and Claude without pretending that the providers expose equivalent data. Each machine will keep an ordered, provider-scoped account list and one active default account per provider. Codex will preserve its existing weekly reset-credit behavior and may move an automatically managed session to the next fresh, signed-in Codex account after reset handling is exhausted. Claude sessions will start with the pinned CLI's native Fable-to-Opus fallback armed at max effort only when automatic usage management is enabled and the exact pinned live-acceptance gate has passed; otherwise the fallback remains visibly unavailable. Oompa will not infer a model-specific Claude quota or speculatively replay a turn.

The CLI and encrypted browser settings projection will show every observation with its source and observation time, the active/default account, account order, readiness, reset windows, reset credits where the provider exposes them, current automatic-policy state, and a plain-language explanation of the next supported action. Claude data will always be labelled as observed during a particular turn, never as a current account-wide read.

## Owner decision and adversarial corrections

The request attached to this work deliberately changes the earlier Oompa v1 decision that all account selection is operator-directed. The governing contract will be updated visibly, but only for the bounded automatic behavior proven by this plan. Explicit operator selection remains authoritative and can choose a non-default account.

The supplied implementation prompt is not executable as written. This plan adopts these corrections:

| Supplied assumption | Approved decision |
| --- | --- |
| A profile is one provider account. | A profile remains an isolation container with separate provider homes. A provider-account binding under that profile owns provider-specific readiness, credential generation, ordering, active/default state, usage authority, and local identity. |
| Existing SQLite objects may be rewritten in place. | Preserve released migration definitions and every admitted historical cohort. The current integration composes canonical adoption 40 with the exact private task-48 checkpoint into 49. Later canonical migrations require a separately reviewed composition of only unpublished task migrations, never reinterpretation of a historical version stamp or mutation of retained evidence. |
| The existing usage payload is provider-neutral. | Introduce a discriminated usage observation v2. Continue decoding Codex v1 byte-for-byte. Claude turn accounting is never represented as a Codex lifetime counter. |
| Any old observation may select the next account. | Missing, malformed, unknown, or stale observations cannot authorize an automatic mutation. Exhausted evidence may remain valid only through its identified reset boundary. |
| Claude unified windows prove a Fable-specific quota. | Unified windows are account-level unless an admitted provider field explicitly identifies a model scope. Current Claude fixtures do not establish model-scoped quota. |
| Oompa should restart a Claude thread under Opus. | The exact pinned Claude CLI supports native `--fallback-model` in print mode. Oompa will arm Fable with the pinned Opus fallback at process start and preserve max effort. Oompa will not build an unproven resume/replay path. |
| The five proposed policy actions cover all input. | Add closed `observe_only`, `disabled`, and `reconciliation_required` results. Unknown evidence must be representable without guessing. |
| Existing `session.switch` is safe for automation. | Harden it with action-specific durable evidence, target authority locking, crash recovery, and idempotent seed delivery before any automatic caller may use it. |
| Session classifier state proves replay safety. | Oompa will not author an automatic continuation or replay in this release. Lexical `working` classification is advisory only. Claude's pinned native fallback owns any in-turn continuation it can perform. |
| One daily hosted snapshot is fresh enough for settings. | Keep the daily history and add a revisioned current head. Project source device and provider-account join identities so the browser can explain freshness honestly. |
| The hand-written command list is the final gate. | The repository's authoritative aggregate gate is `bun run check`. It runs once after convergence through the Oompa host scheduler's heavy compute lane. |

## Semantics and safety boundaries

### Provider-account identity

- A provider-account binding is identified locally by `(profileId, provider)` plus an Oompa-owned binding generation.
- Every non-removed profile owns separate Codex, Claude and Devin bindings. New or migrated non-Codex bindings begin `unverified`; they do not become signed in merely because Codex is signed in.
- Existing Codex public account IDs, usage history, reset-policy identity, and profile behavior remain stable.
- Claude and Devin receive distinct opaque local public IDs. Neither claims subscription identity across machines. Released cloud account selectors remain routing addresses; the daemon resolves exact local binding authority before an effect.
- Raw auth output, provider payloads, credentials, email addresses not already admitted by existing Codex handling, and provider thread content never enter usage storage or hosted sync.
- Provider readiness is separate. Codex continues to derive it from the existing supervised account authority. Claude uses the released bounded `claude auth status --json` parser in the profile's isolated configuration directory. Its exact first-party exit/status/auth-method matrix admits signed-in or signed-out status and discards optional identity fields. Invalid or unavailable evidence remains `unverified`. New Claude work requires exact signed-in proof; an unverified observation cannot authorize dispatch or automatic movement. This replaces the earlier task-base signed-out-only probe. Native model fallback remains independently unavailable until its exact live acceptance gate passes.
- Provider-account generation is an execution fence, not display metadata. New session, turn, interaction, switch, queue, reset, and remote-command evidence binds the provider, binding ID, binding generation, and the applicable provider-scoped runtime process generation. The legacy profile process generation remains the Codex compatibility mirror; Claude and Devin own independent process generations. Legacy Codex account-scoped login, usage, reset, and desktop-switch evidence decodes through that compatibility binding; non-Codex foreground login records preserve their original provider. A sibling restart or readiness transition cannot silently replace another provider's authority. A binding transition never rewrites a session's captured authority in place: stale sessions and effects remain fenced until a separately proved journaled rebind.
- An exact unsettled foreground login grant retains its original provider process authority across daemon restart because the invoking CLI owns the child. Completion proves that original immutable account, binding and process before and after reading authentication. Historical terminal replay and a proven not-started child require no provider read. A changed binding cannot settle the original login from replacement credentials.
- Retained Devin context and optional session cost are historical information only. Devin cannot enter subscription quota schemas, reset handling, automatic policy or managed following. Provider retirement closes new login, start, continuation, switch and dispatch paths while preserving historical readback and cleanup.
- Earlier task checkpoints captured joined-writer close evidence and one-use restart successors. Those immutable records retain their exact historical interpretation. The current join neither creates nor consumes another close receipt and never advances a retired Devin process generation. Empty managers, old connection caches, daemon stop markers and counter arithmetic cannot revive execution.
- Claude's admitted auth status does not expose stable subscription identity. Its binding generation fences only Oompa-owned transitions and observed readiness changes; it cannot detect an out-of-band credential replacement that remains logged in. Claude observations therefore remain turn-local under an opaque machine binding, never form a cumulative account counter, and cannot authorize automatic account movement.

### Active/default account

- Exactly one non-removed provider-account binding may be the active default for each provider on a machine when at least one binding exists.
- Initial order is deterministic by profile creation time and then profile ID. Migration chooses the first signed-in Codex binding in that order, or the first binding when none is signed in; each other provider begins on its first unverified binding. Profile creation appends to each provider order. Profile removal soft-removes its provider bindings, compacts their orders, and advances an affected pointer to the next surviving binding in the prior order, wrapping once.
- Active means the default and automatic-rotation cursor for new or automatically managed work. It is not a provider-wide execution lease.
- Session account selection records `explicit` or `managed` routing provenance. Existing sessions migrate as `explicit`; an explicit account selector creates an `explicit` session; omitting the selector creates a `managed` session from the active binding.
- An explicit account selector remains sovereign. It may start or continue a session on a non-default account and automatic account rotation never rehomes it.
- Changing the pointer never moves an existing session by itself. A session moves only through an explicit switch or a separately authorized automatic action.
- Order edits are exact permutations of the current eligible bindings. Invalid, duplicate, missing, or cross-provider selectors make the whole mutation inert.

### Observation authority and freshness

- Codex observations come from the existing account poll/read path. A below-threshold observation may authorize selection only while it is no more than 90 seconds old, and the coordinator performs an authoritative reread of source and target before a movement. The existing 15-minute failure backoff therefore becomes visibly stale and non-authoritative for mutation.
- Claude observations come only from a particular session turn. The UI always displays their exact observation time and turn provenance. A blocking event may establish that the source account was exhausted through its reset boundary, but an old `allowed` observation cannot prove that a different Claude account is currently available.
- Provider reset timestamps use the existing bounded seconds-to-milliseconds conversion. Impossible timestamps, non-finite values, negative utilization, unbounded maps, and unknown statuses are rejected or reduced to non-authoritative observations.
- Usage exhaustion remains `99` percent used, meaning 1 percent remaining. The existing Codex weekly-reset decision remains the sole reset-credit authority and retains its legacy primary-window fallback behavior.

### Automatic behavior

Automatic management uses a default-enabled baseline and a closed per-provider `inherit | on | off` override. `defaultEnabled` supplies only the value inherited by a provider, so an explicit provider `on` remains effective when the default is off; it is not a master global kill switch. An effective disable prevents new automatic actions but does not undo an already settled provider effect.

The existing automatic Codex reset path must honor that effective policy before preparing work and again at durable begin. Disabling suppresses fresh, retryable and ambiguous reset dispatches; an ambiguous or already-started attempt remains visibly recovery-pending with its original key. Once begin admits an effect, a later disable does not cancel its provider call, discard its result or skip the authoritative usage reread. Usage observation itself remains enabled. A final begin refusal prevents reset-begin authority, state transition and provider dispatch; it cannot roll back separate preparation transactions that completed earlier. This bounded suppression repair is independent of managed account movement and requires no schema allocation.

1. A fresh Codex observation below 99 percent continues.
2. At or above 99 percent on the admitted weekly Codex window, an available reset credit is consumed through the existing reset attempt state machine before any account move. The daemon rereads usage before another decision.
3. Codex has an empty model ladder.
4. If no reset action remains, the Codex active pointer may advance by transactional compare-and-swap to the next signed-in binding with a fresh below-threshold observation. The order wraps at most once. A `managed` Codex session bound to the exhausted account may move through the hardened switch state machine; an `explicit` session is left in place with an explanation.
5. If no proved Codex target exists, Oompa reports the earliest still-valid recheck boundary and waits visibly. A reset time does not prove that an account will be available. Oompa does not spin or probe accounts with provider effects.
6. A Claude process starts on pinned Fable at max effort with pinned Opus as the CLI-native fallback when automatic management is enabled only after exact pinned authenticated acceptance proves Opus with max effort and proves that the combined primary/fallback argv starts successfully. Oompa reports the fallback as armed, but does not claim which model ran unless the terminal result names it. If live proof is unavailable, fallback remains unavailable rather than being enabled from argv help or binary strings alone.
7. Oompa does not automatically rotate Claude accounts in this release. The provider has no admitted noninteractive usage read for an idle candidate, so Oompa cannot prove a target is available before moving work. Claude ordering, activation, readiness, usage capture, and manual switching still ship. A later plan may enable rotation after exact pinned evidence supplies target authority.
8. No observation callback performs an effect inline. It sanitizes and persists a bounded fact, then enqueues evaluation after callback return.
9. Oompa does not send an automatic continuation after a model or account transition in this release. A provider-native fallback may continue its own in-flight Claude request. Every interrupted, failed, or ambiguous provider outcome remains visible for explicit operator action and is never replayed by classifier inference.
10. Observation-triggered evaluation may move only the active pointer. It never starts a provider thread or sends a transcript seed. A managed session moves only at its next explicit send boundary through one crash-safe `switch_and_forward` action that combines the bounded transcript handoff and that exact pending user input into one target turn. It never sends the current `Continue the work` seed and then dispatches the input as a second turn. Pre-effect sizing preserves the pending input and attachments exactly, truncates transcript context first, and refuses inertly if minimum framing plus the legal input cannot fit the target message bound.
11. Pointer advancement requires the exhausted source binding to equal the current active binding. Each settled move records from/to binding IDs, from/to pointer revisions, order revision, `automaticPolicyRevision`, and source/target observation authority. A managed session stores the last pointer revision it applied and may follow only a contiguous settled move chain from its bound account; a gap, branch, or reset requires reconciliation instead of guessing from the current pointer.

## Non-goals

- No populated Codex model fallback ladder.
- No Oompa-driven Claude model restart, resume, or replay based on inferred quota scope.
- No automatic Claude account rotation without an authoritative candidate-availability read.
- No Oompa-authored automatic continuation or replay after interruption, failure, model fallback, or account movement.
- No cross-machine active-account coordination or cross-machine Claude subscription matching.
- No hard provider-wide lease that blocks an explicit operator-selected account.
- No billing budgets, forecasts, or decisions based on Claude cost data. Bounded cost and model accounting are informational only.
- No raw provider event or auth payload persistence.
- No background scheduler or speculative wake loop. Existing daemon observation and turn boundaries trigger evaluation.

## Constraints and convergence ownership

- The canonical adoption-40/private task-48 join into 49 has passed its local checkpoint gates. Provider retirement, Effect and timestamp proof 41 are on canonical main but are not joined here. The reviewed memory checkpoint preserves timestamp 41, local/peer memory 42 and hosted memory 43. Its governed 0.7 integration and release remain separately owned. Join the exact admitted source, preserving the cohort composition below; another task's focused tests do not prove its delivery gate.
- The upstream owner permits isolated local preparation against provisional checkpoint `a2d3872ab5334f0bfb07410eaf193ac585997578`, tree `b43cd35527e048feb2cd893731a31e162f23c220`. This is not final governed source, live acceptance or release evidence. Its canonical-43 producer and timestamp guard remain unchanged. Before delivery, join the final governed source, review any intervening changes and rerun the affected and final gates; do not duplicate the upstream owner's validation or publication work.
- Main at `eb6275ee091d142196080c0e7f970c90576f730d` has different migrations 42 and 43 from the memory checkpoint. The memory owner's merge is still in progress. Recompute the physical migration allocation from the final governed result before changing this task's ledger; the 44–52 composition below is an earlier candidate, not a settled destination. Numeric version alone admits neither source cohort. Main's successful CI and deployments do not contain this usage branch or establish its release acceptance.
- Main subsequently advanced to `136ad4098a6f0c223483fc9a2455f1110f2c6a4e`, verified by its exact remote ref. The authentication owner reports a pending auth migration 44 before planned memory 45/46, but its final validated checkpoint is not ready. These reported allocations are coordination inputs, not admitted schema evidence. Preserve its login/cancel/logout evidence guards, usage identity preflight and atomic cancellation settlement at the eventual join. This task's bounded reset-disable repair does not change those paths or allocate a migration.
- Follow every applicable `AGENTS.md`, `CONTRIBUTING.md`, `WRITING.md`, `STYLE.md`, and hosted deployment rule.
- Keep Bun pinned at 1.3.14 and preserve the exact Claude Code 2.1.260 and Codex package pins unless a separately reviewed pin update is required.
- One storage integration owner owns schema versions, migrations, `state-store.ts`, and store fixtures across all phases.
- One daemon integration owner owns `service.ts`, runtime coordination, action journals, lock ordering, and restart recovery. Workers may propose focused changes but do not merge overlapping service edits independently.
- One cloud contract owner owns payload versions, exact-key parsers, byte bounds, Convex schema/functions, and daemon adapters.
- One CLI contract owner owns parsers, JSON schemas, help, and renderer compatibility.
- One app contract owner owns wire types, decryption, framework-free view models, tests, and settings rendering after the hosted contract is fixed.
- Generated protocol pins, security primitive inventories, manifests, and lockfiles are convergence files. Only the integration owner updates them, and only when the owning command proves they changed.
- Every provider effect has one durable owner and one event-driven waiter. No provider effect runs from the Claude fact-reader callback.
- Phase implementers run focused validation and report exact results. Independent reviewers check acceptance criteria before the phase advances. The integration owner runs the aggregate gate once after convergence.

### Canonical adoption integration prerequisite

Canonical `6f056dc` adds session adoption as schema 40. This task's unpublished schema 40 means provider-account authority, and its later migrations depend on those objects. Finish the custody checkpoint before joining adoption and the separately owned Devin removal. The storage owner must distinguish exact canonical and task-private schema cohorts before repair, preserve canonical migration definitions and immutable historical evidence, and move unpublished versions after the canonical sequence. Changing only the maximum version or deleting the task's Devin migration does not resolve the collision.

Retain task migrations 40–48 as logical 41–49. For an exact private-48 database only, run frozen schema and row/inverse audits before repair and prove the adoption footprint absent. Add the missing frozen provider-account DDL manifest; row relationships alone are not schema identity. One immediate transaction applies adoption with composed guards and ownership-aware quarantine, relocates private migration rows in descending order while preserving their `applied_at` values, records canonical 40 at its actual bridge time, and sets version 49 only after combined audits. Do not rerun private migrations or rewrite request evidence, source IDs, authorities, JSON or digest preimages. Other private versions or partial/mixed footprints require their own proved recognizer, never this bridge by approximation.

Adoption's `session_provider_account_authorities` records account key and runtime scope. This task's `session_provider_authorities` records the independent provider-account tuple, authority revision, routing and pointer cursor. Execution requires both applicable proofs. The adoption scope `managed` means an isolated provider home, not automatic routing; adopted personal sessions remain explicitly pinned. New adoption admission must establish the mandatory session, runtime and event sidecars atomically. Do not reinterpret historical shared profile generations as independent Claude generations, infer Claude identity from a Codex email, or replace exact authority with an account-key match.

Quarantine, detach, runtime revocation and restart must use mode-aware owner, switch, queue and attachment settlement. Upstream bulk mutation cancellation cannot bypass an original outcome or release unproved custody, and pending queue quarantine must retain its body. Preserve same-boot restart idempotence while joining real personal-process release obligations. Keep the sealed scheduled-task enqueue callback and Work's frozen signal tuple alongside the new scope/account predicates. Composed guards need a versioned exact adoption/Work audit surface; unchanged names, broad footprint acceptance and `CREATE IF NOT EXISTS` are not compatibility proof.

Keep service-owned cloud reads fenced by the complete provider tuple, scope/account identity and cache clock checks. Merge public runtime-profile projection across fresh, historical replay, raced replay and recovery responses without rewriting stored receipts or dropping historical native-fallback parsing. Upstream converts Codex thread timestamps from seconds to milliseconds: timestamp-only recovery must prove compatible units or refuse legacy stop/rename settlement. Mere numeric inflation is not evidence that a provider effect happened; exact client-message proof remains separate.

Use an adapter-owned `unix_milliseconds_v1` marker alongside a validated current projection timestamp, copied into new stop/rename evidence only. Both proofs and strict time advancement are required for time-based recovery. Unmarked history remains readable but cannot establish those units, including older Claude rows. Preserve send/steer's exact baseline shape and all stored digest preimages. Close new `proven_applied` admission in both the typed store and an additive SQL guard. A non-proven stop/rename resolution cannot carry an accepted-effect receipt into replay; an authorized no-receipt release needs no timestamp proof. Existing account reconciliation, unsettled-free session-status recovery, direct confirmed receipts and explicit abandonment remain distinct and unchanged.

Required join evidence includes exact canonical-39/40 and task-private checkpoint upgrades; partial or mislabeled schemas refused before writes; divergent provider generations; missing identity or tuple proofs; adoption sidecar rollback; detach/revocation with unclaimed and claimed owners, retained input, dedicated switches and quarantined queues; same-boot restart; adopted scheduled enqueue rollback; unchanged public replay privacy; and the historical timestamp-unit regression. Storage, daemon, cloud/Work and fixture owners may review independently, but shared-file edits remain serialized. Run their focused cases before the root source integration gate, then retain the complete `bun run check` delivery requirement.

### Timestamp and memory composition prerequisite

Independent source review of canonical checkpoint `65f688397a29498e3cd82fa7c4ea052e3106de11` approved the following candidate integration route, not its implementation. The accepted combined-49 checkpoint is frozen at `0ae317793d5ff694b4d333effe25f85f7e7f1491`, tree `8d66385130378febb9be4358dc40fe84de4d0591`. Isolated preparation may use the owner-approved provisional source above; delivery still requires the final governed source. Preserve the task's original DDL constants and evidence formats. The candidate physical slots 44–52 must be reassigned after the later main/memory collision is resolved.

Live main `0aa3fd563e369f75875136ca1f550016e70035e8` adds canonical migration 46 for the default-off after-hours protocol policy and retained history. The memory candidate `cf33a7abfa7ff9b0c6ea42a98c3210f5f02db4d7` still assigns provisional 46 to peer authority and 47 to memory. Therefore neither the historical 44–52 route below nor the later conditional 48–56 assessment is a current migration allocation. Preserve canonical main's migration and wait for the new governed composition before assigning this task's physical slots. Do not reinterpret a database from its version stamp alone.

| Admitted starting cohort | Ledger transition |
| --- | --- |
| Fresh or canonical 40–43 | Preserve existing canonical rows and times, apply missing canonical migrations, then task 44–52. |
| Exact private 48 | Relocate original 40–48 by four in descending order; insert canonical 40–43 at the bridge time. |
| Exact combined 49 | Preserve canonical 40; relocate only original 41–49 by three in descending order; insert canonical 41–43 at the bridge time. |

Every route classifies and audits before maintenance in one immediate transaction. Freeze the combined-49 schema and row recognizer before extending current Work, adoption, process-custody or switch auditors. It must remain distinct from a damaged final-composition database. Separate canonical timestamp-guard proof from predecessor-only terminal ledger checks: `[41]`, `[41,42]` and `[41,42,43]` remain exact historical admission rules for their reviewed source, not the ledger expected after task composition. Do not rerun adoption or initialize existing combined-49 capsules as legacy authority.

Frozen Work admission recognizes two exact 23-table layouts in canonical-40, private-48 and combined-49: fresh creation places `works.preset_contract` after `objective`, while the shipped v38 upgrade appends it after `updated_at`, before the final table constraint. Authentic canonical-30 metadata plus the literal v38 ALTER reproduces the second layout; the other 22 tables and all constraints remain identical. Admit neither arbitrary column reordering nor extra columns. Current-49 adoption recognition freezes its 68 objects, six Work guards and 38 Claude/switch footprint names while retaining outer profile-key and custody/row audits. The exact legacy nullable-launch DDL is a separately bounded compatibility variant, not authority for an unproved NULL-key row.

The compatibility closure includes the adoption manifest, its six Work guards and Claude/switch footprint names; fixed v38/v39 and switch preset contracts; changed mutation-evidence variants; and exact parent-table tails. Preset contracts 1 and 2 now have explicit historical registry keys independent of new-write defaults. The shipped v38/v39 DDL and audit literals, manual-v1 switch target contract 2 and legacy switch inference precedence `[2,1]` must remain fixed. New defaults require an appended migration rather than reinterpretation of those values.

Keep both historical Claude runtime-profile shapes, including their optional native-fallback fields, byte-stable through private and public readers. Private and public Claude parsing uses admitted historical model/effort tuples, not the current model alias. Nine synthetic private canonical preimages and three public projections are pinned to archived-49 parser output, including absent, unavailable and armed fallback records. An armed historical record is readable schema evidence, not live fallback acceptance. Strict stored evidence is not the supported-provider admission schema. Preserve version-one pointer-policy replay semantics and the task's full provider-interaction authority tuple. Unchanged, independently versioned task leaf formats may remain shared; copying the whole StateStore is not required.

The extracted combined-49 effect codecs now bind explicitly versioned V1 provider, preset and runtime-profile definitions. Existing public exports alias those definitions; historical definitions never follow current aliases. Runtime-profile V1 names this frozen document format, not SQLite schema version 1 or preset contract 1. Its admitted tuples remain the fixed preset contracts 1 and 2. Future writer extensions require a separate format without changing these definitions.

The evidence join must not turn previously unvalidated historical JSON into trusted canonical authority. Provisional canonical source adds top-level `messageActor` to send/steer, `providerTimestampUnit` to stop/rename and `targetHostCapabilities` to switch evidence. Baseline and enclosing queue declarations are unchanged, but the canonical runtime-profile leaf rejects the task's historical Claude `nativeFallback` field. Preserve that leaf rather than replacing it with the narrower canonical parser. Current-49 open audits cover specific ownership and cleanup relationships, not every generic effect payload. Generic recovery deliberately retains malformed JSON or digest failures as unresolved.

Use immutable per-row evidence-format provenance for the eventual join. Assign every retained mutation and queue effect its exact source dialect, including malformed rows, inside the migration transaction after cohort admission and before maintenance or new consumers. Canonical 41/43 and task-private 48/combined 49 require their respective historical formats; a source version is not permission to interpret fields introduced by a later writer. New effects receive the explicit joined writer format atomically. Missing, conflicting or changed provenance refuses authority. A failed historical decoder never falls through to a newer decoder, and migration never rewrites evidence JSON, digests, resolutions or containment history. Preserve current-49 startup admission until this transaction is integrated.

Archived source inspection distinguishes five mutation decoder formats. These identify the admitted interpretation of a starting cohort, not proof of which writer originally produced every retained row.

| Source format | Exact checkpoint | Distinction from the other formats |
| --- | --- | --- |
| Canonical 40 | `6f056dcafd6435cd11ae504c75e9b1f869955ca7` | Optional switch account key; both Claude home shapes; no native fallback, actor, timestamp unit or host capabilities. |
| Canonical 41 | `576ccd76a6742cd62759ab6176a6a41844846daa` | Canonical 40 plus the stop/rename timestamp-unit field. |
| Canonical 43 | `eaf0448e19383ac899c30d0a9cd70bbea71ff8b3` | Canonical 41 plus send/steer actor and switch host capabilities; evidence dependencies are identical at provisional `a2d3872`. |
| Private task 48 | `3f6ac733dc17b3eec881ad98f2d65faadbcbaf37` | No switch account-key field; only Claude's isolated-config-dir shape, with optional native fallback. |
| Combined 49 | `0ae317793d5ff694b4d333effe25f85f7e7f1491` | Canonical-40 outer union, but both Claude home shapes accept optional native fallback. |

The outer queue declaration is identical across these sources, but its runtime-profile leaf requires three decoder implementations: canonical, private-48 and combined-49. Canonical 42 has no separately committed writer in the inspected ancestry. The actual version-42 sources there are the differently recognized private-v42 cohort without timestamp proof, not a canonical-42 oracle. Keep the exact transitional-schema test distinct from authentic writer evidence, and close its evidence-format admission before a populated canonical-42 route may grant new authority.

The five source-selected mutation readers and three queue readers are now implemented as pure codecs. The closed format names identify these exact source interpretations, not other branches with the same version number. Readers bound raw JSON to 512 KiB of UTF-8 before parsing, choose exactly one codec, and return a closed opaque reason on refusal. This parser bound does not widen existing SQLite admission. Envelope checks hash historical canonical output, preserve normalization and absent optionals, bind all three mutation kinds, and separately bind queue, session, thread and profile generation. They do not grant execution authority or prove immutable format provenance. Per-row provenance storage, canonical SQL projections and production format dispatch remain unimplemented.

A scan that refuses only documents rejected by the old codec but accepted by the new codec is insufficient. Provisional peer-source SQL trusts raw `json_extract` values even when both codecs reject the document. SQLite can also extract JSON5 rejected by `JSON.parse`, and the decoders disagree on duplicate keys. Format provenance selects the decoder; it does not replace full-document, digest, parent-kind or source/account authority checks. Typed and SQL consumers must use validated, format-bound provenance before interpreting actor, timestamp or host-capability fields. Retained malformed records stay opaque and unresolved rather than becoming trusted defaults such as `human`.

The actor audit includes `sessionMessageActorForSource`, turn-completion autorespond accounting, peer-source lookup/pruning and message-source insert/delete guards. The classifier and turn-completion paths currently omit the stored digest in provisional canonical source; fixing the cloud projection alone would miss persisted event attribution, switch-seed labels and autorespond-budget effects. Timestamp-resolution SQL needs the same format boundary. Regressions must cover valid and wrong digests, parent-kind mismatch, malformed-both documents, duplicate keys, JSON5, absent optionals, exact canonical serialization, raw-SQL authority attempts and restart-safe migration. Preserve the separate owned-direct-send v1 codec and attachment terminal-proof/SQL key allowlists. These are approved integration requirements, not a delivered migration.

Canonical memory appends `message_actor` and `peer_action_id` to queues. Those columns precede task custody columns on fresh/canonical routes but follow them on private-48/combined-49 routes. Admit both exact produced layouts while rejecting quoted-declaration camouflage, altered constraints and extra suffixes. Preserve upstream physical SQL names and canonical aliases, the sealed enqueue callback, native custody hooks and literal-preserving SQL comparison. Audit phase-specific missing-table exemptions instead of widening them to admit missing current authority.

The join also introduces live host-tool and peer-session entry points. Their canonical profile-level checks do not supply this task's provider-specific authority. Adapt actor, live-call, activation and response boundaries to the captured full provider tuple, exact runtime scope, connection and call, and committed capability binding; recheck after awaits. Compose actor and target locks in provider-policy, account, then session rank order, retaining the existing peer policy, provenance and causal guards alongside task ownership and switch fences. A sibling Codex rollover must not revoke a valid Claude call, while replacement of its own binding or process must refuse it.

Peer send and steer use the closed input preparation and atomic native begin. New peer queue admission must atomically join its peer action, causal rows and original key to a sealed empty-attachment queue with exact target authority. The scheduled-task enqueue callback does not cover this separate producer. Do not retain an unsealed raw insertion path or manufacture nested receipts for historical peer queues. Preserve canonical peer and memory rows, digest preimages and historical DDL; queued delivery retains its original peer policy contract rather than requiring a still-live actor turn. Peer origins remain `peer_session` and cannot authorize managed following or pointer movement. Neither an `actor: human` field nor generic, hosted or peer execution supplies direct-local human ingress authority.

Targeted join regressions cover divergent provider counters; stale binding, process, connection or call; revocation and rebind during lock wait or activation; atomic peer action, lineage, provenance, queue authority and identity admission with complete rollback on seal failure; canonical-43 peer history retained without invented receipts; source labels and exact replay through send and steer; pending switch and original-owner conflicts; and refusal of automatic behavior from non-local-human origins.

Retain canonical feature-collision recognizers separately from task-private cohorts. Missing timestamp proof remains a refusal; only a proved empty legacy provider-switch journal may follow the upstream removal route. Memory maintenance and legacy authority repair run only after exact cohort admission. They must not reintroduce regex whitespace normalization of SQL literals.

Required new archived-producer fixtures cover canonical 41 and 43 and frozen combined 49, alongside unchanged canonical 40 and private 48. Canonical 42 has no independently archived constructor ending at that version; test its recognized transitional schema separately with explicit frozen-migration provenance, never by relabelling a restamped 43 fixture as authentic. Canonical 43 has a genuine producer at `eaf0448e19383ac899c30d0a9cd70bbea71ff8b3`; that is source provenance, not evidence of final 0.7 admission. Prove both queue layouts, populated owners and pins, immutable timestamp evidence, preserved ledger times, writable and read-only reopen, and no-write refusal of mixed footprints, altered guards, missing or extra ledger rows and unsupported stamps. Run these focused gates before the new full source integration gate. No automatic producer is enabled by this schema join.

### Provider retirement composition prerequisite

Canonical retirement `5c6d397c920ae955cf6c2734fcf4a80960f2c1f0` removes live Devin execution while retaining historical provider and runtime decoding. Its join remains pending. Preserve the private-48 and combined-49 DDL, provider bindings, order state, original requests, authority sidecars, custody and joined-close evidence. Use the supported-provider discriminator for new selection and execution, not for historical parsing. The existing completeness audit requires all three compatibility bindings and order heads; retain Devin's inert metadata rather than silently omitting rows or weakening missing-row detection. Codex-only pointer evidence and the two-provider usage policy need no format change.

Remove live Devin runtime, authentication, callback, dependency and installation wiring. Close task-only readiness, order, activation, process advance, owned-send, attachment-input, queue, switch, interaction, Work and scheduled admission as well. A retired source or target cannot begin a new switch. Preserve original-key classification, corruption refusal, historical replay and authorized cancellation before new-admission rejection. Mirror these execution refusals through additive guards without rewriting frozen guard definitions. Retired status is local and cannot inspect credentials. Acknowledged abandonment of an old login proves its original attempt key and full provider tuple, never the sibling profile counter.

The admission inventory includes the new pre-owner `reserveOriginalSessionSendIngress` as well as both owned-send preparation APIs and direct claim. An archived prepared Devin login must not start through `beginPreparedMutationEffect` or generic `transitionMutation` after its specific login API is closed. Keep retirement out of historical provider schemas, original-key classification and shared account-authority readers: those also protect cancellation, settlement and recovery. Supported-provider boot must not consume an unused Devin joined-close receipt or advance its account generation, and must not abort because retained Devin history exists.

Retain joined-close readers and audits but remove new capture, recording and consumption. Even a valid unused Devin close receipt cannot authorize a successor after retirement. Local quarantine must not advance its process generation, invent child exit proof, release retained input without its canonical terminal evidence, or block supported cleanup. Preserve exact source tuples and immutable successor evidence; do not transplant canonical scalar-generation inequalities into independent provider counters. Pending retired approvals may expire locally; begun responses remain uncertain and cannot starve supported-provider deadlines.

Required fixtures cover authentic private-48 and combined-49 Devin bindings, original owners with pins, sealed queues, mixed-provider switches, login grants and unused joined-close receipts. Prove retained immutable rows, digests and ledger times through migration and reopen, with no new close consumption, successor or provider IO. Hot tests cover each closed producer, original-key collisions, corrupted owners, divergent provider counters, malformed historical evidence, supported cleanup and approval fairness. Package and import checks must find no Devin executable or ACP dependency. After the join passes, update the current provider identity, ordering, authentication and continuation promises to distinguish two supported providers from retained history; keep earlier dated validation logs as historical evidence.

## Phase map

| Phase | Outcome | Depends on | Write scope | Parallel with |
| --- | --- | --- | --- | --- |
| 1 | Governing contract and pinned Claude capability become explicit | none | plans, root/public contract docs, Claude capability fixtures and focused pin/runtime tests | none |
| 2 | Provider-account and session authority with append-only migration | 1 | storage account/session types, authority adapters, migration, provider readiness, focused tests | none |
| 3 | Provider-neutral usage observation v2 and Claude capture | 2 | usage domain, Claude protocol/assembler/facts, usage store, focused tests | none |
| 4 | Crash-safe manual session/account switching | 2 | switch attempt storage, daemon switch/recovery/locking, switch tests | none |
| 5 | Pure exhaustion policy, durable configuration, and explanations | 3 | usage-policy domain, policy store, tests, no provider effects | 4 for domain-only work; storage waits for convergence |
| 6 | Durable automatic action authority, then supported runtime actions | 4; 5 for storage/runtime | automatic action migration and renderer, daemon coordinator, existing reset integration, pointer and switch-and-forward actuation, focused tests | 5, pure renderer only; storage and runtime remain sequential join gates |
| 7 | CLI account order, activation, optional start account, usage, and policy controls | 6; policy controls need only 5 and reset admission | CLI parser/client/renderers and command schemas | 6 for policy controls only |
| 8 | Hosted current usage and session-join contract | 7; codec-only preparation needs 2, 3 and 5 | cloud payloads/adapters/Convex, daemon upload, hosted docs | 6 and 7 for codec-only preparation; no production publication |
| 9 | Browser settings usage visualization | 8 | app wire/data/model/screens and app tests | none |
| 10 | Contract convergence, final review, aggregate validation, and delivery | 9 | maintained docs, plan status/log, convergence artifacts only if proven | none |

## Phase 1: Contract decision and pinned Claude capability

- **Status:** Done
- **Depends on:** none
- **Objective:** Make the changed account-management boundary explicit and prove the exact Claude runtime behavior used by later phases.
- **Scope:** `AGENTS.md`, `src/claude/AGENTS.md`, `src/daemon/AGENTS.md`, `README.md`, `kb/plans/oompa-v1.md`, `docs/providers/claude.md`, Claude pin/runtime argument construction and focused tests or reviewed text fixtures.
- **Out of scope:** Account schema, usage persistence, policy effects, hosted projection.
- **Approach:** Replace the blanket no-rotation language with the bounded rules in this plan. Preserve explicit operator routing. Represent the pinned Claude ladder as reviewed data, but use it only to build `--model claude-fable-5-1 --fallback-model claude-opus-5 --effort max` after a sanitized exact-version authenticated acceptance fixture proves Opus with max effort and proves that the combined argv starts to an ordinary terminal result. The acceptance need not and must not claim that a forced fallback was observed. If a suitable isolated signed-in profile or provider access is unavailable, keep the runtime fallback capability disabled and project `unavailable: live_acceptance_required`. Admit terminal result model identity separately from quota scope.
- **Acceptance criteria:**
  - Root, daemon, Claude, public, and active-plan governance agree that Codex-only automatic account movement is allowed under fresh exact evidence, while speculative rotation and replay remain forbidden.
  - The exact pinned Claude build and the runtime-profile digest cover the fallback model and max effort.
  - Runtime argument tests prove fallback enabled and disabled forms without starting a provider process.
  - A sanitized live evidence record proves exact Claude Code 2.1.260 accepts Opus with max effort and starts with Fable plus Opus fallback, or the shipped capability remains disabled with an exact unavailable reason. No credential, configuration path, prompt, or raw provider payload enters the record.
  - Unknown or absent model identity remains representable.
  - No automatic effect is reachable in this phase.
- **Validation:** `bun test ./src/claude ./src/domain/presets.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`; exact pinned live acceptance through an existing isolated signed-in Claude profile when available, with only sanitized version/model/effort/argv-shape/result evidence retained.

## Phase 2: Provider-account and session authority with migration

- **Status:** Done
- **Depends on:** Phase 1
- **Objective:** Give each admitted provider independent local account authority and bind every new provider effect to it while preserving profiles as isolation containers.
- **Scope:** Provider-account records and schemas, session routing provenance, provider-account fields in runtime/session/turn/interaction/switch/queue/remote evidence, authority adapters and ports, append-only migration from v34, storage and service APIs, Codex compatibility mapping, bounded Claude auth-status probe, storage and adapter tests.
- **Out of scope:** Usage observations, policy decisions, session movement, hosted sync.
- **Approach:** Add a child authority keyed by profile and provider with local public ID, readiness, Oompa-owned binding generation, provider-scoped process generation, order position, active/default revision, and timestamps. Create each provider binding for every non-removed profile on migration and on later profile creation; Codex mirrors the established authority and legacy profile process generation while Claude and Devin start unverified with independent process authority. Preserve existing Codex profile IDs and public IDs. Backfill deterministic order and active pointers by the rules above. Migrate existing sessions with `explicit` routing provenance and no applied pointer revision; Phase 2 adds the internal managed-session primitive but keeps the public local selector required until Phase 7. Persist the exact captured binding and process generations in session/effect sidecars; never synthesize historical authority from a mutable current profile or account and never retroactively advance session bindings after a readiness change. Make full provider authority mandatory on every live runtime, callback, and client protocol; legacy optional shapes exist only at storage decode and must be upgraded from immutable evidence or quarantined before reaching a live port. For legacy session-scoped evidence, derive the binding only from its immutable historical runtime profile or other immutable per-effect or per-turn provider authority, never from the session's mutable current provider; durably quarantine any unsettled local or cloud row whose historical provider cannot be proved without guessing. Map legacy Codex account-scoped login, usage, reset, and desktop-switch rows to Codex; preserve exact provider provenance for foreground Claude and Devin login. Every newly prepared reset attempt freezes and revalidates the exact Codex binding and provider-scoped process generation before dispatch. Desktop switching always carries and revalidates an exact target authority. It carries a source authority only when independent process evidence proves that source; migration and recovery leave an unproved source absent and never infer it from the active pointer. Logout and quarantine atomically retire every old exact authority before advancing the binding, with the existing transition triggers still enforced. Enforce one active row per provider and total deterministic order with transactional compare-and-swap. Probe Claude through the released bounded status parser on explicit refresh or user-initiated session start; require exact signed-in proof for new dispatch, and never store raw auth-status output. Unverified Claude evidence remains informational and cannot authorize dispatch or automatic movement. Since the pinned Claude transport has no resume path, daemon or binding loss terminally quarantines both active and idle nonterminal Claude sessions with explicit abandon/new-session guidance; Oompa never invents a resume. Do not claim to detect a logged-in out-of-band Claude credential swap.
- **Acceptance criteria:**
  - A profile can hold distinct Codex, Claude and Devin readiness and generations without aliasing.
  - Existing Codex rows, selectors, public IDs, login/logout, sessions, usage, and reset policy read identically after migration.
  - Re-running an interrupted migration is safe and produces no duplicate binding or order position.
  - Removing a profile soft-removes all its bindings; an Oompa-owned sign-out/login transition or an observed readiness transition invalidates stale provider-account authority. Claude's inability to detect a still-logged-in out-of-band replacement is explicit in public state and tests.
  - Provider process generations advance independently; the Codex generation remains byte-compatible with the legacy profile mirror, and no transition silently upgrades captured session authority.
  - Every newly prepared provider effect and interaction, including reset attempts, validates the provider-account generation in addition to the applicable provider-scoped runtime process generation; account-scoped legacy Codex evidence remains recoverable through its compatibility binding.
  - No live runtime, callback, client, desktop-switch, or recovery path accepts providerless effect authority. A desktop-switch target is always exact across restart and effect boundaries; its source is exact only when independently proved and otherwise remains absent, never inferred from the active pointer.
  - Settled and unsettled legacy Claude session, turn, switch, queue, and interaction evidence migrates through immutable historical Claude runtime/effect authority or is narrowly quarantined; no legacy Claude row is blessed as Codex.
  - Every migrated session is explicitly routed, while a newly omitted local selector can be durably distinguished as managed.
  - Order replacement is atomic and exact; invalid permutations produce no mutation.
  - Migration and profile lifecycle produce the exact deterministic order, initial active choice, append behavior, and removal repair stated above.
  - Claude auth output outside the released bounded status schema yields `unverified` and is not persisted raw. New Claude work requires exact signed-in proof; automatic target selection remains disabled for Claude regardless of sign-in status.
  - A lost Claude daemon/runtime deterministically quarantines active and idle nonterminal Claude sessions without resume or replay; later observation returns actionable recovery state rather than an unhandled adapter error.
- **Validation:** Repaired focused service and storage slices each passed `3 pass/0 fail`; typecheck and diff checks passed. Root integration passed `366 pass/0 fail` with `3368 assertions` through `oompa-host-run --mode=heavy --lane=compute --label=oompa-phase2-provider-authority -- bun test ./src/storage/state-store.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1`.

## Phase 3: Provider-neutral usage observation v2

- **Status:** Done
- **Depends on:** Phase 2
- **Objective:** Persist truthful, provider-discriminated Codex and Claude usage without changing existing Codex behavior.
- **Scope:** Usage observation types/parsers, truthful provider-specific observation provenance, Claude rate-limit and result parsing, assembler and daemon fact reduction, usage storage migration/APIs, retention, focused tests.
- **Out of scope:** Automatic decisions or provider effects, CLI presentation, hosted upload.
- **Approach:** Add immutable discriminated v2 observations keyed by provider-account authority and component-specific idempotency key. Fresh Codex usage freezes the exact provider, account, binding generation, and process generation in the existing immutable `account_scoped_provider_authorities` sidecar. The usage-observation migration adds the required write guard and read join without rewriting historical payloads; migrated rows with a null process generation remain byte-identical, display-only evidence and cannot authorize a mutation. A Claude quota observation separately owns quota windows, rate status, admitted overage fields, observed and received times, turn ID, and source event digest. A Claude accounting observation separately owns bounded cost, token and model accounting, its own observed and received times, and terminal turn ID. Accounting may advance without refreshing or overwriting quota authority. Decode v1 Codex payloads through the existing path and project their established combined snapshot into the v2 read model. Sanitize Claude `rate_limit_info`, convert utilization to used percent, and correlate it with the current turn. After neutral fact reduction, the callback schedules deferred persistence and returns first. The persistence task is tracked immediately and drained on close without `#serialize` or a live daemon fence.
- **Acceptance criteria:**
  - Claude rate events retain bounded windows, reset instants, status, rate-limit type, admitted overage state, turn provenance, and observation time.
  - Claude result accounting retains bounded cost, canonical model keys, token counts, context windows, and output limits without treating them as quota or lifetime counters.
  - Storing Claude data cannot change Codex latest usage, counter epochs, reset policy, poll cadence, or hosted v1 identifiers.
  - Parser totality covers missing, extra, oversized, non-finite, negative, millisecond-shaped, excessive-window, excessive-model, and unknown-status input.
  - Duplicate or reordered facts converge idempotently by provider-account, turn, and observation revision.
  - A later result accounting fact cannot change quota freshness, status, windows, or reset authority; latest projections merge components while retaining each component's source time.
  - Every fresh Codex usage row has one immutable exact provider-account and process authority; a migrated null-process row remains byte-identical and display-only.
  - The fact callback returns after neutral reduction and scheduling, before persistence. The deferred task is tracked immediately, drains during close, and does not depend on `#serialize` or a live daemon fence.
  - Claude provider observations never claim `codex_app_server` provenance; Codex retains its existing source value byte-for-byte.
- **Validation:** `bun test ./src/claude/protocol.test.ts ./src/claude/assembler.test.ts ./src/claude/client.test.ts ./src/daemon/claude-session-facts.test.ts ./src/domain/provider-usage.test.ts ./src/domain/usage-metrics.test.ts ./src/storage/state-store.test.ts ./src/daemon/service.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/cloud/daemon-adapters.test.ts --isolate --max-concurrency=1`

## Phase 4: Crash-safe manual session switching

- **Status:** Done; Devin integration independently reviewed and source gate revalidated
- **Depends on:** Phase 2
- **Objective:** Make the existing explicit session switch safe enough to serve as the later Codex account-move primitive.
- **Scope:** Dedicated switch-attempt records and migration, immutable source/target authorities, canonical multi-key locking, target start receipt, source release evidence, rebind commit, seed delivery journal, restart recovery, switch tests.
- **Out of scope:** An automatic caller, automatic policy, active-pointer movement, and automatic continuation.
- **Approach:** Replace the generic switch effect with an action-specific write-ahead journal: `prepared -> target_starting -> target_started -> source_releasing -> source_released -> rebound -> seed_dispatching -> seed_settled`, plus terminal `reconciliation_required`, `failed`, and `cancelled` dispositions. Atomically claim the request key in the global mutation-idempotency namespace and link its immutable mutation attempt to exactly one dedicated switch journal through a unique foreign key with matching request key and digest before resolving replay or performing any effect; a key owned by any other mutation shape conflicts, while same-key replay resolves the linked switch before current-state no-op validation. Preparation rejects a terminal or recovery-required session, an active turn, a dispatching or ambiguous queue item, in-flight response or interaction state, another active switch, and stale session or session-authority revisions. Commit each intent before its provider call and each exact result after return; an ambiguous target start or seed dispatch is never replayed, while only the exact idempotent release may resume from its in-flight state. A `failed` disposition requires durable positive evidence that the relevant provider effect did not start, never merely the absence of a receipt. Freeze immutable source and target provider-account authorities, the original session revision and session-authority revision, source and target thread/runtime evidence, the deterministic seed dispatch identity, the request key, and a retention-pinned half-open transcript event range `(stream_id, after_sequence_exclusive, through_sequence_inclusive)` with its accepted-head/event-stream revision and canonical digest. The journal retains only that range and its digests and bounded metadata, never transcript plaintext; seed bytes and their digest are derived once from exactly that range rather than rerendered from latest state, and retention cannot prune the referenced events until the switch reaches a disposition that no longer needs seed recovery. Acquire source and target provider-policy locks, account locks, then the session lock in one ranked canonical order, reread every authority, and use the original frozen revisions for the rebind compare-and-swap. Every journal transition and receipt API independently enforces the expected prior state, exact authorities, frozen revisions, and request digest in storage rather than trusting service-side checks. While a switch is open, storage admission fences block queue dispatch, interaction response preparation and timeout, state-changing callback admission, and due-task materialization; a pending queue item may remain durable but cannot dispatch. The rebind transaction changes a manual switch to `routing_provenance=explicit` with `applied_pointer_revision=NULL`, updates the runtime and automation bindings, and records exactly one switch event without changing order, pointer, or policy. Seed recovery normally remains bound to the frozen target authority. It may adopt only a newer process generation for the same profile, provider, provider-account ID, and binding generation after immutable session-authority successor rows prove one contiguous old-to-new lineage from the rebound authority with every expected authority revision compare-and-swap bound; a missing or branched lineage, an account or binding substitution, or merely current mutable state requires reconciliation instead of dispatch. Tear down the local source runtime only after the exact durable source-release receipt exists. Dedicated per-session restart recovery owns these rows and excludes their phases from generic unresolved-mutation and broad Claude restart handling so one ambiguous switch quarantines only its session and never blocks unrelated daemon startup. Phase 4 exposes only the existing manual command and adds no policy or automatic caller.
- **Acceptance criteria:**
  - Crashing after every switch boundary cannot leave an unhandled mutation that prevents daemon boot.
  - The target cannot race logout, credential-generation change, removal, or another switch.
  - At most one target provider thread and one seed delivery are accepted for a switch key.
  - Ambiguous target start or seed delivery is visible as reconciliation-required and is never guessed or replayed.
  - No target start, source release, or seed dispatch occurs before its durable intent; only exact idempotent source release can be resumed after an in-flight crash.
  - Every state transition is rejected by storage unless its prior state, immutable authorities, frozen revisions, and request digest match; a terminal `failed` row contains positive no-effect evidence.
  - The exact transcript event range remains retained until seed settlement or reconciliation, while the switch journal contains no transcript plaintext.
  - Local source teardown follows the durable source-release receipt, and seed dispatch accepts only the frozen target authority or a newer same-account, same-binding process generation proved by one contiguous immutable session-authority successor lineage.
  - Rebind validates the originally frozen session and authority revisions. A manual switch always settles as explicit with no applied pointer revision and never changes provider order, active pointer, or policy.
  - Pending or ambiguous queue work, unresolved provider interactions, and due-task materialization cannot cross a switch boundary under stale source authority.
  - Storage, not only the service lock, keeps queue dispatch, interaction response preparation or timeout, state-changing callbacks, and due-task materialization inert while the switch is open; pending queue evidence may remain without dispatching.
  - Same-key replay returns the settled switch receipt without another target, switch event, or seed, even after the current session already matches the target.
  - Generic mutation and daemon-generation recovery exclude dedicated switch rows; ambiguous or malformed switch evidence is session-local recovery state rather than a daemon-wide boot failure. Writable reopen validates terminal as well as open receipt chains. A malformed historical terminal journal retains its phase and gains an immutable blocking disposition, so multiple historical attempts cannot conflict with the one-open-switch index.
  - Source release, positive target no-effect, and reconciliation receipts each have an independent immutable digest anchor binding the attempt, prepared plan, complete receipt, and observation time. Receipt relocation or field mutation cannot authorize rebind, failure, or abandonment.
  - Accepted seed settlement freezes its event digest before the storage-authored event is admitted and validates the whole settlement chain before commit. It retains no second plaintext seed or event payload in a custody table.
  - Every admission consumer resolves a disposed journal through its trusted disposition session and immutable mutation account authorities, not corrupt plan identity. A separate immutable source-thread anchor preserves callback custody. Safe pre-effect cancellation does not obstruct recovery for later switches.
  - A dedicated plan freezes and hashes both preset contracts. The source retains its historical interpretation; new targets use the current contract. Storage validates both reviewed runtimes and atomically updates the contract with the account rebind. Released legacy switch evidence remains recoverable without creating a new provider effect.
  - Existing explicit provider and same-provider account switches retain their public results and refusal codes unless a documented recovery code is required.
- **Validation:** Host-scheduled `bun test ./src/daemon/provider-switch.test.ts ./src/storage/state-store.test.ts ./src/storage/session-task-store.test.ts ./src/daemon/service.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/codex-runtime-adapter.test.ts ./src/daemon/facts-memory-lifecycle.test.ts --isolate --max-concurrency=1` passed 542 tests with 5,684 assertions. Independent recovery review, typecheck, focused lint, and diff checks passed.

## Phase 5: Pure exhaustion policy, configuration, and explanations

- **Status:** Done; upstream integration revalidated
- **Depends on:** Phase 3; storage work joins after Phase 4
- **Objective:** Produce one deterministic decision and explanation from a frozen provider-account snapshot and persist revisioned default/per-provider configuration, without performing provider IO.
- **Scope:** New `src/domain/usage-policy.ts`, schemas, pure selectors, threshold alias, freshness helpers, append-only automatic-policy configuration and revision storage, exhaustive unit and storage tests.
- **Out of scope:** Provider effects, CLI and app rendering.
- **Approach:** Store `defaultEnabled` plus closed per-provider `inherit | on | off` overrides, not a master global enabled bit. An inherited provider uses the default; an explicit `on` or `off` wins independently. Advance one monotonic `automaticPolicyRevision`, distinct from the existing reset-credit `resetPolicyRevision`. Bind decisions to provider-account generation, quota-component observation revisions, order revision, active-pointer revision, `automaticPolicyRevision`, session revision, turn ID where present, and reset boundary; accounting components are informational and never enter selection or follow decisions. Keep active-pointer target selection and per-session following as separate pure operations. Selection may propose advancement only from the current active source and emits `propose_pointer_move`; only a storage commit creates a named `SettledAutomaticPointerMove`. Following accepts only a contiguous named move lineage from the session's applied pointer revision and never reselects from current global state. For Codex, select exact `byLimitId.codex` whenever the keyed map has any entries; if that exact key is absent the observation is non-authoritative. When the keyed map is null or empty, use the admitted legacy top-level primary limit. Within that selected limit, each non-null primary or secondary window must have finite 0-to-100 usage, valid duration, and a bounded future reset; a malformed present window makes the observation non-authoritative, while a null slot means the provider exposed no window there. At least one valid window is required. Any applicable window at or above 99 percent exhausts the source; a candidate is available only when every applicable window is below 99 percent. A provider reached-type that conflicts with the numeric windows yields reconciliation-required. Delegate weekly reset eligibility to the existing proven function and its separate `resetPolicyRevision`, then reread all windows because a reset credit covers only its exact weekly authority. Walk account order once. The recheck time for one account is when all of its currently exhausted windows have reset; the ladder reports the earliest such boundary without claiming fresh availability. Model ladders are provider data, but `fallback_model` requires explicit model-scoped quota evidence; current Claude inputs instead report native fallback armed. Unknown or stale evidence returns a non-mutating result.
- **Acceptance criteria:**
  - Reset precedes model fallback, which precedes account movement, which precedes a bounded wait.
  - The existing Codex 99 percent weekly reset table remains byte-compatible, including the legacy primary fallback when `byLimitId` is empty.
  - No stale or missing below-threshold observation selects an account. Freshness uses quota-component received time: age 90,000 milliseconds is fresh, age 90,001 is stale, and a future received time is invalid. Exhaustion expires at the exact reset boundary.
  - The pure selector emits `propose_pointer_move`, never a settled move. Storage alone creates `SettledAutomaticPointerMove`; session following accepts only that durable type.
  - Weekly reset eligibility uses an explicit `AutomaticUsageResetGate` bound to the exact source authority, quota observation revision, reset boundary, and separate reset-policy revision. A policy proposal cannot infer reset settlement from usage v2 alone.
  - An exhausted observation is not carried past its reset boundary.
  - Multiple exhausted windows wait until all blocking windows for one account reset, then choose the earliest recheck boundary across the order without claiming fresh availability.
  - Order traversal wraps no more than once and concurrent input ordering cannot change the result.
  - A non-active account observation cannot move the active pointer, and a managed session follows only a contiguous named pointer-move lineage from its stored revision.
  - `defaultEnabled` is inherited rather than globally dominant, provider overrides are closed and independent, and `automaticPolicyRevision` never aliases `resetPolicyRevision`.
  - Quota components alone authorize policy decisions; cost, token, model, and other accounting fields cannot change selection or following.
  - Keyed Codex limits without exact `codex`, malformed present windows, no applicable windows, and reached-type conflicts are non-mutating; primary/secondary threshold conflicts follow the any-exhausted rule.
  - Claude unified windows never produce `fallback_model` without an explicit admitted model scope.
  - Disabled, observe-only, ambiguity, policy conflict, and no-target states are closed and explainable.
- **Validation:** `bun test ./src/domain/usage-metrics.test.ts ./src/domain/usage-policy.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`

### Phase 5 configuration contract

After upstream convergence, schema 43 adds one immutable configuration-revision table. Revision 1 is the exact domain default; a current-schema database missing it fails closed instead of silently re-enabling automation. A closed local update claims the global mutation key and atomically commits the configuration revision and receipt. Freeze the original request key independently in the revision so single-table corruption cannot relocate a receipt. Resolve replay before current-state CAS, preserve every unaddressed field, and advance the revision for every accepted new key, including a same-value command. Same-key replay returns its original configuration even after later edits. Validate migration, tampering, rollback, competing CAS, revision exhaustion and receipt integrity independently.

Foreground reads and replay resolve indexed head, genesis and exact receipt rows without loading the history. Reopen validates the immutable prefix in bounded joined pages and rejects orphan configuration intents. Revision exhaustion remains guarded by safe-integer and SQL bounds; an exact maximum-revision fixture must not weaken the contiguous ledger merely to reach an impractical branch.

Threshold and freshness remain code constants. Configuration never edits reset policies, observations, accounts, order, pointers or sessions. Claude decision input has null reset policy and reset gate; it cannot borrow Codex authority. A global automatic-policy revision means the later command boundary must hold both provider-policy locks, including for a one-provider override. An account order beyond the selector's admitted bound is an explicit non-mutating overflow, never a truncated candidate set.

## Phase 6: Supported runtime actions without speculative replay

- **Status:** In progress (pure renderer, original-request storage ownership, pointer ledger, queue identity, attachment custody and adoption-49 checkpoint done; later canonical integration and managed journal remain)
- **Depends on:** Phase 4 for the pure renderer; Phases 4 and 5 for storage and runtime
- **Objective:** Act on only the policy branches supported by authoritative provider evidence, with one durable coordinator and no Oompa-authored replay.
- **Scope:** Versioned automatic action journal and append-only migration, framed renderer and attachment retention, asynchronous coordinator, existing Codex reset integration, active-pointer movement, managed-session forwarding, Claude native fallback arguments, action evidence and tests.
- **Out of scope:** Automatic Claude account rotation and Oompa-driven Claude model restart.
- **Approach:** Implement the durable action contract below before wiring its coordinator. Observation-triggered evaluation may settle only a pointer move, never start a provider thread or turn. The next eligible direct human send may follow a verified contiguous move chain under one ranked lock acquisition, fresh source/target rereads, and current policy/order/reset/session fences. Reuse the existing Codex reset state machine, including its original-key reconciliation, then require a later authoritative quota reread before movement. A managed forward is one versioned action of the switch journal, not a manual switch followed by an ordinary send. Preserve explicit routing, provider-owned continuation, and the separately gated Claude native fallback.
- **Acceptance criteria:**
  - Existing Codex reset cases `reset`, `noCredit`, `nothingToReset`, `alreadyRedeemed`, ambiguous settlement, identity change, and window rollover do not loop and retain current output.
  - Several sessions observing one exhausted Codex account coalesce pointer advancement and cannot create a switch herd.
  - Migrated and explicitly routed sessions remain pinned. One managed send may follow several contiguous settled pointer moves with at most one physical forward; a same-binding round trip updates only the applied cursor and preserves the exact current process authority.
  - An observation by itself never starts a provider thread or turn. A managed send that switches produces exactly one target user turn, including attachments and the bounded handoff, with one durable dispatch identity.
  - A maximum-size legal input is never truncated. Transcript context shrinks first; an input that cannot fit with minimum framing fails before target start. Same-key replay proves the input digest, completes a pre-dispatch attempt once, and never retries an ambiguous dispatch.
  - A provider fact callback never awaits session closure or switching.
  - User stop, explicit send, queue dispatch, policy disable, order edit, target logout, and credential-generation change win through revision conflict before an automatic action.
  - A rate-limit failure, any other failure, and lexical `working` classification never authorize an Oompa-authored continuation.
  - Claude fallback-disabled and fallback-armed argv remain pinned and max effort remains invariant; the armed form is unreachable without Phase 1 live evidence.
  - Every automatic result has a bounded event and evidence row with safe explanation fields.

### Phase 6 storage and runtime join gates

The storage owner finishes and independently validates the action migration, renderer, immutable anchors, retention and recovery contract before the daemon owner wires any automatic effect. Both remain part of Phase 6; neither partial gate marks it done.

Implementation proceeds through bounded slices: original send ownership; durable pointer-move evidence; attachment custody and complete rendering; the versioned managed journal with shared fences; trusted ingress and ranked locks; mode-aware recovery and forwarding; then observation-triggered pointer evaluation and reset integration. Both the pointer ledger and durable attachment custody are storage prerequisites for journal admission, not authorization to wire an automatic producer early. Each slice preserves manual switching and original send receipts. The narrow local input contract admits attachment-only input in this phase while still refusing empty input without attachments; it does not broaden hosted authority.

The pure byte-budgeted renderer may be implemented and independently tested alongside Phase 5 in disjoint domain files. It has no configuration or IO dependency, does not mutate manual v1 rendering, and cannot dispatch an action. Its later storage consumer must still pass every journal, retention and recovery gate before runtime wiring.

- **One request owner:** Claim or replay the original human `session.send` key and request digest before mutable routing lookup. Add a versioned managed-forward action variant; preserve manual v1 receipts. Freeze mode, original managed routing and applied cursor, verified move IDs and endpoint, policy/order/reset/observation revisions, both preset contracts, exact input digest and UTF-8 length, ordered attachment-manifest reference and digest, and framed renderer version/bound/envelope digest. Every effect anchor and reopen validator includes these fields. A parsed branded move is not proof: storage must verify its immutable committed evidence.
- **Exact input custody:** Do not create a plaintext input or envelope table. Before target start, pin the existing attachment manifest and blobs against pruning. Retain only bounded references, digests and lengths in the action. Before dispatch is proved, recovery waits for identical same-key caller input; it cannot reconstruct text from a digest or dispatch a standalone continuation seed at boot. Changed text, attachment order, bytes or manifest is an inert conflict. Once dispatch may have escaped, never replay it. A durable accepted receipt remains replayable after response loss.
- **One framed turn:** Add a deterministic byte-budgeted renderer for the complete provider message, including framing and exact validated human input. Shrink transcript first; refuse before any target effect if minimum framing cannot fit. Keep transcript, input and envelope digests separate. Preserve human authorship and switch context under one target turn without storing a second plaintext envelope. Cover maximum multibyte input and attachment-only input.
- **Entry and lock authority:** Only a direct local human send may initiate following in this release. Work, autorespond, queue dispatch, boot recovery, classifiers and hosted commands with separately frozen provider authority cannot initiate it. Enforce that origin at the trusted entry boundary, before taking ranked source/target/provider/session locks; never nest a switch under an already-held ordinary-send lock. Observation evaluation remains pointer-only.
- **Freshness and races:** If the source is available at the next send, keep it and its current applied cursor; this rule also takes precedence over same-binding round-trip catch-up. Otherwise a same-binding chain may advance only the cursor without replacing process authority. Follow only the verified settled-chain endpoint; a stale or unavailable endpoint does not permit choosing another account. Revalidate policy, order, active pointer, exact account/process authorities and session revisions immediately before the first effect. After target start, a conflicting edit produces visible recovery rather than silent rollback or a replacement effect.
- **Reset compatibility:** Preserve the released reset reconciler's original provider-idempotency key. No new reset key, message replay or movement is permitted while reset outcome is unresolved. Settlement must precede a strictly later authoritative quota revision. Automatic-policy revision remains independent of reset-policy revision.
- **Reset eligibility and disabling:** Preserve weekly-reset eligibility for signed-in non-active and explicitly pinned Codex accounts; `not_active_source` forbids pointer movement, not the existing reset behavior. Effective automatic-off prevents every further consume RPC, including ambiguous-key reconciliation, because the existing idempotent consume operation can still redeem a previously uncommitted credit. Preserve the original unsettled key and report recovery pending; accept an already-in-flight response, but dispatch again only after re-enable and fresh exact authorization. Never infer settlement from lower usage, zero credits or a new window. Quota reads remain available while disabled.
- **Concrete integration boundaries:** Parse the ordered attachment references, reserve their exact blob identities before reading, then re-prove bytes while custody is held; the durable manifest is not yet present at the current ordinary-send preparation point. Pin admission and blob deletion must share an exact custody exclusion, closing the unreferenced-query/delete race. Budget the provider-expanded text, including attachment headers and fences, not just handoff text. Supply non-wire direct-local ingress authority from the authenticated socket handler; generic service execution, hosted `executeLocal` and an `actor: human` field cannot grant it. Claim the original send owner even for cursor-only catch-up, and keep a pre-dispatch managed action input-required across boot rather than dispatching a manual seed. Schedule pointer evaluation after account-held usage refresh and callback work releases its locks.
- **Wire-size proof:** Codex's outbound JSON frame limit is four MiB of serialized characters, distinct from its incoming eight-MiB line bound and one-million-character text field. Bound managed provider text to 512 KiB, including attachment expansion. Even six-character JSON escapes then leave at least one MiB for the eight bounded local-image paths and request framing. Keep the maximum legal human input intact; excessive minimum framing or attachment expansion refuses before target start.
- **Required regressions:** Crash at every phase with and without caller input; replay after rebind and accepted-response loss; policy/order/manual activation races; A→B→C and A→B→A lineage; two source sessions sharing one pointer move but separate explicit inputs; target readiness/binding/process changes; pending or ambiguous reset and window rollover; exact attachment custody; and zero provider effects from observation callbacks, queue, autorespond, work or boot recovery.

- **Validation:** `bun test ./src/daemon/usage-poller.test.ts ./src/daemon/provider-switch.test.ts ./src/daemon/service.test.ts ./src/claude/runtime.test.ts ./src/storage/state-store.test.ts --isolate --max-concurrency=1`

### Phase 6 original-request ownership decision

The existing send path resolves live authority and provider observation before its generic mutation lookup. Its generic digest also includes the process generation. That ordering cannot serve managed following or restore an accepted original request independently of later routing changes.

| Approach | Decision |
| --- | --- |
| Retain the current send path unchanged | Insufficient: mutable authority is consulted before historical request ownership. |
| Add separate request and switch/send mutations | Rejected: introduces cross-attempt settlement and a second dispatch owner. |
| Preserve one `session.send` mutation with explicit request format and execution claim | Selected: retains original key and dispatch identity, with explicit new storage joins and unchanged legacy receipts. |

The first slice is storage-only with no production producer. Add an immutable nullable request-format discriminator, an immutable request owner and independent anchor, and a one-shot execution claim. Preserve the original canonical session, source authority and mutation generation; freeze actual execution authority separately. The owner stores selector and input digests, input UTF-8 length, ordered attachment-reference digest and count, source thread, authority revision, routing and pointer cursor. It does not persist selector text, input text or a second envelope. Compute the versioned request digest from parsed caller input before any current routing lookup. A new key still requires one atomic canonical-session and source capture; do not insert incomplete placeholder owners.

Every generic mutation entry rejects new-format ownership, including unclaimed and direct owners. Check owner or anchor presence as well as the discriminator before legacy fallback. Use null-safe discriminator immutability and bidirectional mutation, owner and anchor consistency on hot reads and bounded reopen audits before schema repair. Retain the original key in the independent anchor so moving a mutation key cannot relocate its receipt. Historical sends retain their original generic digest and canonical-session-ID semantics; do not infer an old raw selector from a current label.

The impact review also found direct-ID and bulk-SQL paths outside generic preparation: turn completion and runtime receipts, session mutation resolution, provider terminalization, daemon restart, and Work nested mutation restoration/cancellation. These require ownership-aware SQL guards and a shared leaf storage classifier used by both StateStore and WorkStore, without a circular import. Classify the original key before treating an absent mutation as new. Keep tagged diagnostic/history reads separate from legacy receipt acceptance. Skip only a fully validated unclaimed owner in unrelated blockers; partial ownership or a claimed effect must never disappear merely because generic recovery filters it out. Cover effect-evidence, resolution and provider-authority inserts as well as mutation state/result writes.

Request ownership is not an execution lease. Unclaimed owners are bounded, non-executable, and do not block unrelated account or session operations, acquire transcript custody, or require provider availability. A later claim revalidates the frozen source and session revision; an intervening manual change may make that claim an inert conflict. Define input-required restart disposition for every supported pre-dispatch mode. An execution claim freezes its actual provider tuple, session authority revision and original dispatch identity; direct and managed entry points cannot consume each other's claims. Cursor catch-up never settles the input before its one accepted turn. Missing or corrupt ownership cannot become a legacy request or receive generic restart cancellation/rebinding by accident.

For direct sends, create the unique execution claim atomically with write-ahead effect evidence and the transition to `effect_started`, at final dispatch admission. There is no durable direct claimed-but-prepared state. Only that transaction's first successful caller receives permission to dispatch; replay never issues another permit. Freeze the explicit caller daemon generation and boot ID as well as provider authority. A crash after this boundary is ambiguous even if no native write can later be observed. An unclaimed owner's `input_required` state promises input custody, not unconditional executability: identical input may still receive inert `source_changed`. A proved no-effect settlement may terminate a claim, never reset it. Later managed journal phases may own preparatory target effects, but their one user-turn claim is created only at final seed/input admission and any cross-boot preparation recovery needs explicit immutable successor proof. They cannot reinterpret or replace a direct claim.

The current closed direct-admission API must receive complete attachment metadata for an attached owner. Parse and detach it before use; bind the ordered references to both the original request's version-one digest and the distinct retained-custody digest, count and canonical blob identities. Text-only owners accept omitted or empty metadata. Write the existing message manifest while the mutation is prepared, read back its exact ordered references, and create the unchanged version-one claim, evidence and state transition in the same immediate transaction. The existing manifest writer may prune eligible unprotected display rows toward its 200-source cap; any later failure must roll that pruning and reference accounting back with the new manifest. Retain owner pins through unresolved effects and daemon restart; retained input does not revive restart-retired source authority. This is a guarantee of new closed-API admission, not a retroactive assertion that historical or raw-SQL claims already have complete manifests. Preserve their frozen schema and receipt bytes. Runtime profile/turn projection admission and production wiring remain separate migration and implementation gates.

Settlement uses a bounded immutable outcome chain with independent anchors, not connection-local SQL bypass flags. An unclaimed owner may be cancelled atomically against claim admission. A direct claim may settle accepted, proved no-effect or ambiguous; only an ambiguous outcome may receive one later accepted, proved no-effect or explicitly abandoned resolution. Terminal outcomes cannot branch, rewrite history or grant another dispatch permit. Historical acceptance remains recordable against its frozen claim after account or session changes. Applying any current-session projection is a separate exact-authority compare-and-swap; routine provider facts must not erase an accepted receipt merely because they advanced a mutable revision.

The owned completion join must cover runtime-profile insertion, turn-profile insertion and `runtimeProfileSourceRequiresSettlement`, including the compact-projection reader of native user-message client IDs. Claude's early usage receipt also depends on the exact turn-profile binding. Current JavaScript ownership checks and frozen SQL guards independently reject these paths for owned attempts. Add version-aware exact-claim and accepted-outcome admission only after canonical schema integration; substituting another source ID or relaxing a generic guard would detach the projection from its receipt. Prove orphan and mismatch refusal, atomic projection/receipt failure, late acceptance without authority revival, compact projection and early usage handling, and unchanged historical version-one bytes before enabling a producer.

The first storage-only API deliberately omits claimed no-effect settlement: current runtime ports do not issue a durable proof that an earlier ambiguous send was never written. Neither an enum reason nor a missing receipt is such proof. Until a reviewed native proof contract exists, claimed uncertainty remains ambiguous or explicitly abandoned; unclaimed cancellation remains available.

Direct-local provenance will be a per-service closure returned by a composition factory and retained only by the authenticated local socket handler. It is not an exported token, a command field, an actor value or an option to generic `execute`. The socket proves authorized direct-local caller provenance, including intentional CLI/script requests, not physical human presence. Generic, hosted, Work, queued, autorespond and boot entry points remain policy-inert. This entry must share normal service shutdown, daemon fencing and error handling, then acquire the existing ranked policy/account/session locks before calling already-locked primitives.

The first composition refactor preserves ordinary command behavior: a factory constructs one new service and returns a frozen wrapper containing that service and its lexically bound private local entry. It never vends that entry from an existing shared service reference. Both entries initially delegate to the unchanged operation-tracking, daemon-fencing, housekeeping, error and deferred-stop lifecycle. Only the already authenticated socket handler receives the closure, after its separate exact daemon-stop branch; hosted commands and background polls keep the generic service entry. This is placement of an in-process capability, not authentication against code already entrusted with service-construction authority. It adds no request owner, dispatch permit or automatic producer.

Independent review approved this direction with the discriminator, nonblocking ownership, execution-authority and restart requirements above. Allocate only an unpublished append-only migration after the exact canonical main schema at implementation time; reconcile it if another canonical migration lands. Runtime wiring and full Phase 6 acceptance remain separate gates.

### Phase 6 managed-action journal decision

Use a separate versioned managed-action journal under the same original `session.send` owner. This is physical separation of the managed switch action, not a second mutation or a second turn claim. The existing manual journal requires a `session.switch` mutation, target-generation ownership, manual seed receipts and explicit routing on rebind; extending it would branch all of those authority contracts. Preserve its existing rows, digest preimages, mappers and manual receipts unchanged.

Admit a managed plan only with a fresh original owner in one transaction, including an immutable managed marker on the original mutation INSERT. A plan and independent anchor alone cannot detect both disappearing while the parent survives. The initial marker closes that gap without adding a prepared-to-prepared exception to the historical v45 mutation guard. Existing direct owners retain their exact read, direct-claim and cancellation eligibility; they cannot acquire a managed plan later. This restriction affects no deployed original-owner producer and prevents a prepared direct request from silently changing execution mode.

Fingerprint parsed original input and classify its key before mutable routing. For an absent key, transient blob reads require a closed reservation derived internally from that original fingerprint, not the generic send digest. The final immediate transaction reclassifies the key, revalidates current source, policy, lineage and reproduced rendering, then binds that same reservation while inserting the owner, initial marker, plan and independent anchors atomically. Do not consume a second slot. A competing direct owner remains direct; a competing managed owner restores only its existing plan; changed input conflicts. Failure before admission leaves no original owner and releases only the invocation reservation. The original-send reservation must support the attachment-only input already admitted by its fingerprint and renderer without broadening generic queue or steer input. Historical v45 and v48 guards retain their exact bytes, with only exact additive schema-suffix recognition extended.

The pre-owner reservation API and same-slot direct-owner transfer are a storage prerequisite, not a managed producer. A replay after redundant reservation release returns the existing owner's history only after proving that invocation's complete original input and released custody record. It never takes a new slot or upgrades an unproved owner. The final managed journal still needs its separate atomic marker, plan, lineage, renderer and policy admission gates after canonical schema integration.

Reuse exact provider custody, atomic rebind mechanics, transcript retention and the admission-only fence pattern. Add bidirectional manual/managed exclusion before any target preparation. An owner with active managed preparation is no longer an inert unclaimed owner: it blocks direct-claim admission, generic effects and unclaimed cancellation even while the original mutation remains prepared. Inverse audits and key reservation must also recognize orphan managed plans, receipts and anchors. Work uses the same preparation fence without gaining managed authority.

Cancelling a managed plan before any target-effect intent atomically cancels the original send owner and releases its owned custody. Cancellation never restores direct or generic executability or permits another plan under that key. Keep one permanent plan and independent anchor per original attempt and key, including after cancellation. Ordinary owner cancellation must refuse an active plan; the closed joint cancellation operation and its reverse SQL guards settle both lifecycles together.

The managed final claim is a separately versioned branch of the existing unique owner claim. It retains the original attempt, key, owner digest and client message identity; references the immutable plan and committed managed rebind; and freezes actual target authority and revisions. Direct-v1 claim bytes and validation remain unchanged. Preparatory receipts never substitute for acceptance of the one user turn.

The final v2-claim migration must replace only the claim-admission trigger with the exact v1 predicate as one branch and a separately closed managed branch. Its version-aware schema audit preserves historical v45 DDL and digest preimages. The current v1 SQL and reader require the original source, thread and revisions, so additive reverse guards alone cannot authorize a different-binding claim. Forward evidence keeps the original input fingerprint separate from renderer metadata and the expanded envelope digest; do not weaken v1 input-digest equality globally.

Implement immutable pointer-move storage before admitting managed plans. Reparse of the pure branded move schema is not proof of a committed move. The storage transaction must verify the source and target quota evidence, policy, order, pointer and reset fences against authoritative rows, then settle the pointer and independent immutable move evidence together. Managed admission verifies the exact committed contiguous lineage. Automatic observation dispatch remains a later integration slice.

The first pointer-ledger request freezes the triggering source tuple and quota revision/digest, caller daemon generation and boot, and policy/order/pointer/reset revisions. Storage selects the target from its own complete bounded account snapshot. A non-active or superseded observation cannot reevaluate another active source. Freeze only canonical quota evidence or closed absence/refusal records, with a 1,000-account and four-MiB canonical UTF-8 capsule bound. Historical replay recomputes the recorded decision independently of later quota pruning, account edits or manual pointer changes. Source and target foreground authentication or unresolved resets prevent new admission.

Current reset attempts lack the original authorizing quota revision. The first capsule and ledger therefore support only a proved reset-not-eligible branch; same-window historical reset settlement cannot substitute for the missing baseline. Add immutable reset-admission evidence under the existing reset key before enabling the settled-reset movement branch. This preserves existing reset RPC identity and behavior and is a remaining Phase 6 dependency, not a completed reset integration.

Managed admission independently proves current source reset-not-eligible and no unresolved reset on either source or endpoint. A historical move proves its recorded decision only; its reset-policy revision cannot authorize the current send after a window or credit change. The first journal slice performs no consume RPC and never rewrites a reset key. Freeze fresh admission evidence separately from immutable move references without duplicating their bounded historical capsules.

Current quota proof is separate from historical pointer evidence. A freshly available source keeps its existing applied cursor and uses ordinary send admission, including after an A-to-B-to-A round trip. Stale, unknown, invalid or ambiguous source evidence authorizes no automatic action. A freshly exhausted source may follow to the exact different-binding endpoint only while that endpoint is freshly available. A same-binding endpoint instead permits cursor-only catch-up: do not require the exhausted endpoint to be available, replace its current process authority, start or release a thread, change a preset, or add handoff context. All normal readiness, interaction, authentication, reset, daemon and session fences still apply.

The cursor successor and final managed turn claim must commit together; cursor catch-up is not acceptance of the input. Forwarding claims reference the already committed managed rebind. Both use a version-2 managed branch of the one execution claim and original client message identity; direct-v1 bytes remain unchanged, and direct APIs cannot settle a managed claim. No pre-dispatch continuation runs without identical caller input, exact retained attachments and reproduced framing. Boot recovery cannot load or start a target or send a turn. Once target preparation starts, a conflicting edit requires recovery rather than pre-effect cancellation.

Use new additive managed admission and reverse guards. Do not change the historical `sessionSendUnclaimedSql` or manual `SESSION_SWITCH_FENCE_SOURCE` definitions to refer to future tables: they are embedded in earlier migration DDL and contain mode-specific exemptions. The first journal checkpoint admits only prepared/cancelled plans and their immutable anchors after custody exists. It must already enforce every active-preparation fence and inverse audit, but exposes no target-start or dispatch permit until both full lifecycles pass review.

Prepared forward plans also pin their verified transcript range against both retention pruning and raw event deletion. Extend the existing range-retention boundary without introducing a second transcript table. Managed boot handling must precede restart-gap and generic successor writers so valid input-required plans retain their pins without broad session guards aborting an otherwise valid restart.

Later target preparation records separate write-ahead intent and immutable receipt for target start, source release and rebind before the unique user-turn claim. Keep the original mutation prepared until that final claim. Admit the claim after runtime review at the last synchronous dispatch boundary; the manual seed dispatcher is not an implementation shortcut. Boot handles managed phases explicitly without provider reads, loads, seeds or fresh permits: prepared input remains input-required or source-changed, and any escaped target or turn intent remains recovery-required unless a separately reviewed immutable successor proof permits the next distinct phase.

### Phase 6 attachment custody decision

The current sweep snapshots unreferenced rows, awaits unlink and only then rechecks accounting. A concurrent session can add a reference during that await and retain an accounting row whose bytes are gone. The unaccounted-file sweep has the same stale-snapshot problem; a grace window is insufficient because storing an existing digest does not refresh its file time.

Use the existing SQLite immediate writer transaction as the cross-process exclusion. Candidate enumeration is only a hint. A closed deletion operation must recheck the exact current daemon generation and boot, live message references and unresolved original-owner pins, then perform bounded synchronous file inspection and unlink before releasing that transaction. No await separates the last eligibility check from deletion. Daemon replacement uses the same writer boundary, so an old sweep cannot acquire deletion authority after replacement. Missing or corrupt pin ownership refuses cleanup.

Use a closed canonical blob candidate or validated single-directory stale filename, never an arbitrary path. Both accounted and unaccounted cleanup must pass this boundary. Recheck file age at deletion; refuse symlinks and non-regular files. SQLite rollback cannot undo a successful unlink. If later accounting or commit fails, retain only the already-unreferenced accounting conservatively; a subsequent missing-file result may finish cleanup. Do not claim an atomic filesystem rollback or treat a stale candidate list or cached reference count as deletion authority.

Managed actions need bounded immutable owner-to-blob membership independent of the retention-pruned message manifests. Pin the exact ordered references before long provider work and re-prove bytes while the pin is held; a pre-pin read is not continued-custody proof. Missing or changed bytes refuse before a target effect. Pins survive daemon restart and unresolved recovery, and release only with an authorized terminal disposition or an atomic transfer to retained message custody. One owner's release cannot remove another owner's pin. Validate both race orderings, old timestamps, manifest pruning, restart, failed unlink and conservative rollback before wiring a managed producer.

The renderer verifies transient content, not path lifetime. Recompute its input and manifest digests and the original-request fingerprints separately from the same exact bytes and ordered references; their versioned hash domains differ. Pass its unexpanded message and the same prepared attachments to the provider exactly once. Existing send, steer and queue paths also have pre-manifest awaits; cleanup exclusion alone does not prove their full attachment custody.

The pre-repair queue implementation had an earlier correctness defect: rolling retention dropped a pending queue's manifest after 200 newer sources, while dispatch interpreted the missing manifest as no attachments. Queue admission also hashed only the message and committed the manifest separately. The repair must preserve unresolved queue attachment custody independently of the rolling display cap, bind new queue requests to exact ordered references, and commit queue evidence and manifest together. Retries cannot add, remove, reorder or replace attachments. Preserve released empty-attachment request digests and original receipts; missing historical attachment identity must not be fabricated. Prove these failures with regressions before the managed journal depends on the repaired custody boundary.

Migration 47 adds an explicit bounded queue identity and independent anchor under the existing queue mutation, sealing even an empty attachment list. Keep only message/reference digests and lengths in that immutable evidence; retained live manifests own the actual ordered references, and existing terminal body scrubbing remains authoritative. At each nonempty manifest admission, prune historical display sources toward 200 per session while excluding at most 200 unresolved attached queue sources; settling protected queues may temporarily exceed the historical target until later admission. A current-schema missing identity or malformed manifest is not an empty message. Legacy receipts retain their original canonical-session/message semantics, but neither absent nor retained old manifests establish original attachment identity because the old writer could append mismatched retries. Old-key lookup never rewrites attachments. Unproved legacy pending queues remain visibly quarantined with their bodies retained until explicit abandonment; do not skip the FIFO head, load a provider or fabricate an empty identity during migration.

### Phase 6 reservation and pin implementation contract

The next custody migration is storage-first, after the queue checkpoint and the exact canonical-main join. Keep transient invocation reservations distinct from original-send recovery pins. Neither owns a provider effect. Reserve before the first attachment read, generate the existing send/steer key before that read, then re-prove bytes while retention is held. A deletion that wins before reservation must cause missing-byte refusal before dispatch, not successful custody inferred from stale buffers.

Use five additive custody structures: immutable origin headers, bounded ordered blob members, independent anchors, at most two immutable linked dispositions, and 64 numbered live slots. A sixth cleanup-only metadata table records historical uncertainty as described below; it is not another effect owner or pin set. Each custody set has at most eight references and the existing ten-MiB message bound. Store the full ordered-reference digest but no message text or second filename history; members and anchors need only digest, canonical type and length. Empty requests and already protected queue manifests consume no live slot. The 64-set limit applies globally across boots to unresolved attached custody, with atomic backpressure before any effect.

Headers and anchors each carry a separately indexed, one-way terminal-disposition pointer. New parent mutations carry an immutable custody ID and a one-way release pointer. Audit the bounded union of both live indexes, the parent live index and every live slot, refusing overflow, missing origin/member/anchor/parent, or mismatched commitments. This must detect an entire set disappearing while its parent remains. Reopen performs paged full inverse and disposition checks before repair. Terminal member cleanup requires canonical release; anchors retain only their bounded content-free blob descriptors.

Every concurrent ingress invocation gets its own token, even for the same request key. The token binds canonical session, original operation/key, exact request and reference identity, captured provider authority and explicit daemon generation/boot. It grants retention only. New legacy send/steer preparation atomically binds its first token to the one existing mutation and appends `mutation_owned` as disposition one. That reservation then survives a pre-effect review failure: ordinary invocation cleanup cannot release it. An exact prepared retry verifies the original parent and retained set, releases only its redundant invocation reservation, and uses the original custody at begin. Existing mutation state and effect evidence own subsequent execution; there is no additional dispatch owner or independently executable custody phase.

Begin commits the exact manifest, native write-ahead evidence and existing mutation transition together. Terminal disposition two releases only against actual accepted, failed, cancelled, resolved or acknowledged-abandoned evidence. Stored `effect_started`/`ambiguous` plus an append-only resolution must be interpreted through its validated original contract, not a projected state label. Session terminalization, process advancement and a daemon restart alone are not release proof. Queue admission atomically transfers its invocation reservation into the independently sealed, protected manifest; a raced historical replay releases only the caller's reservation and never appends references.

Original-send owner and recovery pins are created in one transaction, with the new custody marker initialized on the original mutation INSERT. Do not retrofit a marker onto an existing owner or rewrite historical v45 guard SQL. Old attached, unpinned owners remain readable/cancellable but cannot claim a turn or enter the managed journal. New claims require the exact live pins; terminal owner outcomes release them. Only exact additive schema suffixes may be recognized by the historical schema audit.

Boot retires only old-boot invocation reservations that never became mutation-owned. A prepared parent must first receive its existing authorized cancellation; unresolved native effects and original-send pins survive. Release never uses a TTL. Cleanup takes only a closed candidate and captured daemon fence, uses a fixed constructor-owned synchronous filesystem port, and rechecks live closure, actual message references and canonical accounting inside the immediate writer transaction. Unlink failure retains accounting; SQL rollback after successful unlink retains conservative metadata for a later fully rechecked ENOENT retry.

An unresolved historical send/steer without provable attachment identity conservatively blocks cleanup, not ordinary recovery. Never reconstruct old pins from retained manifests. A bounded indexed existence check must detect this condition. The new closed legacy preparation API records positive empty-attachment identity without consuming a slot, so new text-only operations are not misclassified as historical uncertainty. This requires a guarded additive format discriminator, not a fake custody ID or a caller assertion that missing references mean empty.

The bounded historical check uses an immutable, new-INSERT-only input format and a one-way canonical terminal-proof digest on the original mutation, plus a separate cleanup-blocker row and an independently discriminated anchor. Index each unresolved projection directly; do not scan historical ambiguous states through a resolution anti-join. Migration and reopen page the complete original history before repair, validate exact existing terminal contracts, and close only proved terminal projections. Missed settlement hooks retain a blocker instead of granting cleanup. Preserve historical v45 guard SQL unchanged. Consequently an old v45 empty owner also conservatively blocks cleanup until its ordinary terminal outcome, while its read, empty claim and cancellation semantics remain unchanged. This deliberate historical breadth affects no deployed original-send producer: v45 is still a storage-only task checkpoint. New empty owners commit positive empty identity and never consume a slot or create this historical uncertainty.

An unmarked historical prepared send/steer cannot acquire verified empty identity or retained custody from a retry. The closed runtime preparation path refuses that unresolved replay before effect dispatch; completed historical receipts and canonical cancellation/recovery remain available. During the storage-only checkpoint, existing generic producers must atomically create conservative cleanup blockers. Closing new generic send/steer admission joins the later production-wiring change, never an intermediate broken service tree.

The storage checkpoint must prove both writer orderings, same-key independent holds, prepared retry, atomic transfer rollback, restart, retention pruning, inverse corruption, bounds and post-unlink rollback. Only then switch all production deletion paths and send/steer/queue reservation consumers together. CLI ingestion and hosted materialization may race before reservation, but the daemon must re-read and refuse missing bytes before any provider effect. Managed journal and automatic runtime wiring remain later gates.

## Phase 7: CLI account and usage contract

- **Status:** In progress, automatic-policy controls and cached provider-account listing verified
- **Depends on:** Phase 6 for account selection, managed routing and integrated usage explanations. Automatic-policy controls depend only on the completed configuration store and reset-admission guard. Cached provider-account listing depends only on the Phase 2 local authority model. These bounded slices may proceed independently.
- **Objective:** Give human and JSON callers one exact contract for order, activation, optional account resolution, policy controls, observations, and explanations.
- **Scope:** CLI grammar/help, daemon commands and public schemas, JSON/text renderers, parser and command tests.
- **Out of scope:** Hosted/browser surfaces.
- **Approach:** Add `oompa account order <provider> <selector...>`, `oompa account activate <provider> <selector>`, and provider-aware `oompa account list [--refresh]`. Extend `oompa account usage [--refresh]` rather than add a competing read command; refresh runs the provider's admitted read, which for Claude is auth readiness only and never fabricates usage. Add `oompa usage auto on|off` for the inherited default, `oompa usage auto on|off|inherit <provider>` for an override, and `oompa usage auto status [provider]`. Make the local `session start` account selector optional: resolve same-key replay from the original request before reading the active pointer, then freeze one exact active binding for a new request; that omission records managed routing, while any explicit selector records explicit routing. Keep remote `session_start.accountPublicId` mandatory and explicit.
- **Acceptance criteria:**
  - Ambiguous or missing active accounts fail before any provider effect with a stable recovery instruction.
  - Explicit account selection preserves existing behavior and does not mutate the active pointer implicitly.
  - Order, active marker, readiness, observation time/source/freshness, limits, reset credits, reset-policy state, native fallback state, next supported action, and wait boundary agree with the pure policy result.
  - Claude always prints `as of` turn-derived freshness and never says current.
  - JSON additions are versioned and old fields retain meaning; text output remains bounded and contains no raw provider payload.
  - Remote session start remains explicit and unchanged.
  - `oompa usage auto on|off` changes the inherited default; `oompa usage auto on|off|inherit <provider>` changes only that provider override, and `status [provider]` reads it. Fresh configuration is default on with both overrides inherited and automatic-policy revision 1.
  - An omitted local account selector is part of the original request. Same-key replay resolves its immutable receipt before looking up the mutable active pointer, so later activation cannot redirect a retried start.
- **Validation:** `bun test ./src/cli ./src/cli.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1`

The initial policy-control command requires `--revision <n>` and `--idempotency-key <uuid>` for every change. Status supplies the revision; the caller retains the exact key, revision and change for response-loss replay. Do not fill a missing revision from the current head on retry, which could turn an old request into a new mutation. The command returns the immutable accepted configuration, not a claim about the latest head. Status remains a separate read. Both text and JSON validate the configuration and derived effective provider settings before output. These local controls neither refresh providers nor move an account or session. The remaining Phase 7 commands and full phase acceptance are still pending.

The next read-only slice adds `oompa account list --provider codex|claude` without changing the unqualified command or its response. Its strict version-one result binds provider, ordered account/profile IDs, labels, cached readiness and observation times, and the order/pointer revisions and default marker. Read the provider head, account rows and profile counterparts in one bounded transaction; retain the existing Codex pointer-proof audit and refuse missing bindings, invalid canonical label keys, mismatched or removed profile counterparts, inconsistent ordering and defaults. Codex readiness and process generation must match its profile mirror; Claude retains independent readiness and generation. Present removed bindings remain intentionally excluded, not reconstructed. The read verifies at most 10,000 live profiles and returns at most 10,000 accounts; a separate 3 MiB canonical-result limit leaves room inside the 4 MiB transport envelope. Oversized or incoherent results fail closed without truncation. Preserve nullable and clock-skewed observation times and use existing terminal-safe output. Readiness is cached local evidence, not quota freshness or dispatch permission. Add no refresh, automatic callback, mutation, schema repair or managed start; normal existing daemon housekeeping remains unchanged.

Manual order and activation setters cannot be exposed directly: they have CAS guards but no original-key receipt and return a mutable head after commit. Their future closed mutation API must resolve historical replay before selector/head reads and atomically retain an immutable accepted receipt, including no-op acceptance. Any persisted format or guard requires the governed schema join. Do not weaken those requirements merely to expose the commands earlier.

The bounded current-source command guide is [Provider accounts and automatic usage settings](../../docs/usage-management.md). It states the independent cached-read and reset-disable behavior without claiming the unfinished movement, fallback or browser features.

## Phase 8: Hosted current usage and session-join contract

- **Status:** In progress; standalone component, context, display, composed-head and encrypted-envelope codecs prepared
- **Depends on:** Phase 7 for publication and joins; the pure component codec may proceed from Phases 2, 3 and 5
- **Objective:** Publish encrypted, joinable, freshness-honest usage heads while preserving the existing session stream as session authority.
- **Scope:** Usage payload v2 and dual-read, recalculated bounds, current-head and daily-history Convex storage/functions, provider-account/device/session join fields, daemon upload, cloud and Convex tests, `docs/hosted-sync.md`.
- **Out of scope:** Browser mutations for account order or automatic policy, raw credentials, cross-machine rotation.
- **Approach:** Preserve existing Codex HMAC/public IDs. Add provider and source-device identity, component observation times/sources, freshness inputs, reset credits, automatic-policy state, order, active marker, and next-action explanation to encrypted usage v2 payloads. Keep session state out of the usage payload: extend the existing encrypted session head or registry contract with provider-account public ID, provider, and actual/requested model fields for later app joins. Add a revisioned current usage head that coalesces the newest local observation and uploads at most once per provider account per 60 seconds. Give current-head admission its own monotonic revision rule, server interval, and recalculated daily write quota; keep the existing 24-hour cadence and retention only for daily history. Dual-read v1.
- **Acceptance criteria:**
  - Existing v1 encrypted payloads still parse and project with explicit unavailable fields.
  - V2 exact-key, tamper, source-device, account-join, revision-order, oversize plaintext, and oversize ciphertext tests pass against newly documented bounds.
  - A current-head update changes encrypted payload and revision within the documented 60-second coalescing cadence without waiting for a new daily bucket; its server admission interval and quota are distinct from daily history, which remains bounded at the existing archive cadence.
  - Device registry accounts, usage accounts, and the existing session-head stream join by provider-scoped opaque IDs without exposing local profile IDs or credentials; pagination or subscription, not usage-payload truncation, remains session completeness authority.
  - Claude projection fields retain component observation times and cannot imply idle polling or per-model quota.
- **Validation:** `bun test ./src/cloud/usage.test.ts ./src/cloud/payloads.test.ts ./src/cloud/daemon-adapters.test.ts ./src/cloud/daemon-bridge.test.ts ./convex --isolate --max-concurrency=1`

### Phase 8 head identity decision

V2 current heads belong to one cloud user, device enrollment and local provider binding. A separate optional link retains the existing Codex account-match identity, not proof of a unique subscription. The source codec may be prepared independently of Phase 7; production publication, source revisions, registry/session joins and full Phase 8 acceptance still require the preceding runtime and CLI contracts. No V2 writer or wire format is admitted by this design decision.

| Approach | Consequence |
| --- | --- |
| Codex account-match quota heads plus separately revisioned binding metadata | Preserves a shared Codex quota head, but readiness, order, defaults and policy require a coherent cross-stream join. The current v1 cross-device winner cannot own those binding-local facts. |
| Device/provider-binding heads with an optional account-match link | Represents signed-out or unverified bindings and multiple profiles independently. Duplicate observations must not be summed or pooled; grouping through the separately proved link grants no routing authority. This is the selected scope. |

The current uploader derives `codex_` identities with the existing `codex-account-match` HMAC over normalized email and rejects duplicate same-account projections. Preserve that v1 identity, its unversioned ready `{state,data}` and unavailable/loading/failed `{state}` payloads, and its 8,120-byte plaintext and 10,848-character ciphertext bounds. Registry `acct_` and provider-qualified addresses are reversible profile selectors, not the privacy-safe V2 source identity. Do not expose them as a new usage join key or infer missing-provider state from v1 omissions. Session completeness remains in the existing session stream.

The source derivation and key-change replacement decision below fix the identity contract. Standalone context, head and bounded-envelope helpers implement the codec portion; trusted-context acquisition and the replacement and retirement lifecycle remain publication gates. A codec cannot mint identity from labels or email, grant execution authority, or prove that an upload's source is current. Unknown Codex identity must not reuse a previous identity's quota; Claude keeps turn-local provenance without invented subscription matching. A coherent producer snapshot, durable source revision and outbox, old-head retirement, hosted admission and deletion rules, and an explicit registry/session mapping remain required before publishing V2.

Binding/process/readiness generations remain freshness fences, not new account-match identities. Identity transitions invalidate the prior quota and link. A new cloud user or device enrollment cannot inherit a prior head, cursor or receipt even if copied local IDs match. Same-device rollback requires explicit revision or epoch recovery. A full credential clone still presents the same enrolled identity; retain device/auth fencing and same-revision conflict refusal without claiming hardware uniqueness or clone detection. Claude's same-signed-in out-of-band replacement remains unobservable under the admitted provider contract.

Before admitting a producer, implement and validate the key-change replacement and old-head retirement/recovery lifecycle selected below. Do not implicitly merge across keys, re-encrypt an old pending request or reuse its cursor. Separately arriving binding heads must not fabricate a coherent machine-wide order, default or policy from conflicting shared revisions; the later join contract must represent incomplete or inconsistent snapshots honestly.

The existing hosted snapshot API is daily-history admission, not a current-head writer. Within its 24-hour interval it advances a source cursor with a coalesced disposition without replacing the displayed envelope. Its replay compares the keyed projection digest and observation time, while the current uploader may encrypt the same observation again after response loss. Preserve that V1 behavior; do not copy it into the exact-byte V2 outbox or claim that coalesced acceptance published a new current head. The V2 contract must distinguish durable request acknowledgement from the currently selected displayed revision, bind exact framing and ciphertext for same-request replay, and retain enough admitted history to reconcile a lost response after later head advancement.

Current bounded listings are not completeness proofs: the V1 uploader admits 32 account candidates per cycle, the registry payload accepts at most 100 account rows, and hosted account listing takes at most 100 without a continuation cursor. These differ from the 10,000-row local provider listing ceiling. The new mapping and current-head read must define pagination and explicit incomplete or capacity-refused states rather than infer absence from these caps. Before hosted admission, calculate retained current heads, replacement/retirement records and replay receipts separately from 90-day daily snapshots, then bind their byte, record and accepted-write budgets to the exhaustive quota, genesis, deletion, device-revocation and maintenance maps. The existing 200 MiB identity tier, category ceilings and counters remain hard authority; this plan does not raise or silently reuse them as a minute-scale write budget.

V1 usage encryption binds the user, account-match ID and key version, not the source device or source revision. Its current snapshot read omits the device and the local parser discards the revision. A separate V2 API must require its complete expected source context from an admitted head, without widening V1 or retrying a failed V2 decode as V1. The account encryption key is shared across devices: source fields in authenticated additional data prove context consistency under that key, not a per-device signature, hardware identity or freshness. Authenticated hosted-device admission and trusted head/revision selection remain separate requirements; replaying an old envelope with its old context does not prove it is current.

### Phase 8 source identity and deployment scope

Use a key-scoped HMAC source ID rather than a separately allocated random mapping. The random alternative would preserve identity across key changes, but adds allocation, loss and rollback recovery that this contract does not need. The selected ID is `usrc2_` followed by all 64 lowercase hexadecimal characters from the existing `hmacSha256Hex` helper, purpose `usage-head-source`, over this exact JSON array:

```text
[2, canonicalApiOrigin, userPublicId, sourceDevicePublicId, provider, localProviderAccountId, keyVersion]
```

The local provider-account record ID is a private derivation input, validated for its provider. It is never a public head, AAD or public receipt field. Labels, email, generations and active pointers do not participate. An unchanged deployment/user/enrollment/key/binding-record tuple keeps its ID across process and readiness changes. A new deployment, user, enrollment, account key or key version replaces the source ID; it cannot inherit an old cursor, pending request or receipt. Provider identity changes instead invalidate the old quota and optional account-match link at a higher source revision. Rollback recovery and old-head retirement remain producer gates, and a full credential clone does not acquire a distinct hardware identity through this derivation.

Adversarial review found that local deployment custody prevents normal retargeting but does not cryptographically exclude the same copied identity tuple at another deployment. Therefore bind the canonical Convex API origin directly, not a new stored deployment digest, private daemon binding ID, browser page origin or authentication-site origin. The future separate V2 AAD is the UTF-8 encoding of this exact JSON array:

```text
["hra-control-plane-usage-head:v2", canonicalApiOrigin, userPublicId, sourceDevicePublicId, provider, sourcePublicId, sourceRevision, keyVersion]
```

Expected origin comes from the actual transport's trusted configuration, not an incoming head. Preserve current URL rules: HTTPS, or HTTP only for normalized `localhost`, `127.0.0.1` and `[::1]`, with no credentials, non-root path, nonempty query or fragment. Existing URL admission has no explicit length limit. This V2-only boundary adds a 4,096 UTF-8-byte ceiling on both the string supplied to this boundary and its canonical origin, checked before and after normalization without truncation. An already-canonical deployment-authority URL cannot retrospectively bound its original environment input. This does not change legacy URL admission, V1 or local operation. Keep existing bounded opaque user/device identifiers, exact `usrc2_` identity syntax, the closed Codex/Claude provider union and positive safe revisions/key versions. Origin is external authenticated context, not additional payload capacity.

The standalone context helper implements only this derivation and framing contract. `parseUsageHeadContextV2` accepts unknown input, takes a bounded foreign-JSON snapshot, validates the exact scalar keys and returns a detached frozen context with canonical origin. `usageHeadAadV2` encodes the exact public array. `deriveUsageSourcePublicIdV2` separately accepts the private local binding input and returns only its opaque ID. The key boundary uses native typed-array brands and a fixed 32-byte copy before inspecting context or awaiting HMAC. It honors a view's offset without invoking caller iterators, species or shadowed getters. Shared, detached, proxy and wrong-kind key views are refused; genuine Uint8Array subclasses remain valid. Invalid input has a fixed diagnostic without input values.

The context helpers, composed-head parser and separate V2 envelope wrapper have no production caller. A valid context is not proof that its caller selected the actual transport, user, device or current revision. The standalone codecs check plaintext/context agreement and preserve the process-wide GCM budget, but trusted-context acquisition, persistent budgeting, coherent revisioned outboxes and all hosted/device/registry/session replacement and retirement gates remain required before a producer is admitted. V1 APIs and bytes, legacy URL admission, local execution and storage remain unchanged.

The separate V2 encryption wrapper copies the genuine nonshared 32-byte key before foreign input inspection, snapshots and parses the independently supplied expected context and payload or envelope, and constructs owned AAD and canonical plaintext before its first asynchronous boundary. The existing encryption primitive awaits budget-key derivation before copying its AES key and later copies plaintext and AAD; decryption also reads envelope fields after key import. Passing only owned snapshots preserves those primitive APIs without exposing V2 to caller mutation. Encrypt the validated detached full head, not its original input. Keep the existing shared key/version message-budget bucket, typed key-rotation refusal and no-refund semantics; a new provider, source or deployment must not reset the bucket. Persistent producer high-water admission remains independently required across restarts.

The wrapper uses the independently reviewed full-head plaintext bounds below. For a maximum of P UTF-8 plaintext bytes, the unpadded base64url ciphertext bound is the ceiling of `4 * (P + 16) / 3`, including the GCM tag but excluding envelope framing. Decryption must bound and snapshot the exact envelope, match its key version to expected context, authenticate, check raw plaintext length before fatal UTF-8 decoding and JSON parsing, and check every repeated context field after full-head parsing. Invalid UTF-8, malformed JSON, context mismatch and V2 authentication failure never retry through V1. Focused acceptance must exercise mutation across awaits, each AAD field, typed key inputs, valid/invalid budget consumption and unchanged V1 maximum boundaries before a producer can use this wrapper.

V2 must additionally reject noncanonical base64url spellings instead of normalizing them. The existing V1 shape parser admits some impossible lengths and alternate trailing pad bits; a read-only probe confirmed that different accepted strings can decode to identical ciphertext bytes. Preserve V1. After V2 string bounds, decode and require exact re-encoding equality for both nonce and ciphertext, a 12-byte nonce and 16 through P-plus-16 ciphertext bytes. The composed-head bounds imply 93,303 Codex and 25,991 Claude ciphertext characters, excluding envelope framing. Canonicality does not make encryption deterministic or replace the exact-byte outbox: GCM authenticates decoded bytes and expected AAD, while replay admission must separately retain and compare the original full request. Use the existing default process budget without a new injectable budget parameter. Preserve the original typed key-rotation error; other wrapper failures have fixed operation-specific diagnostics without raw causes or input values.

### Phase 8 reset and advisory display boundary

The reviewed display design keeps Codex reset policy, current-identity history and independently retained pending recovery separate. A failed identity check must not hide a proved pending attempt. A failed recovery inspection must not become `none`. Current-identity policy and history therefore have their own unavailable state; pending recovery separately distinguishes unavailable, none, prepared, retry pending and recovery pending, retaining the reset window and whether its identity is current, different or unavailable. A whole-source unavailable result is reserved for failure of the coherent read. Reset-policy `active` describes its reconciliation latch, not automatic management enabled, reset eligibility or permission to dispatch.

Known recovery pending takes blocked precedence even when automatic management is off or identity differs or is unavailable. Unreadable pending evidence instead makes next action unavailable with a snapshot conflict. Prepared or retryable attempts can remain visible beside disabled advice, but a different identity requires reconciliation and cannot authorize a fresh reset or become current-identity history. A local closure caused by account identity change is not a provider outcome. Keep completed pointer movements in their independently verified storage history; a proposed movement is neither dispatch nor completion.

Claude's reset display is only provider unsupported. Its actual advisory decision subset is disabled by policy, invalid-input reconciliation, or one of the two Claude observe-only reasons with no recheck time. It cannot advertise reset blocking, Codex reset, movement, wait or continue. Codex excludes the Claude reasons. Non-null recheck times must exceed evaluation time, not necessarily the browser's current time. The current Codex source-stale and wait outputs derive them from still-live windows. Other producible observe-only outputs carry null; the declared `no_target` branch has no current witness because exhausted source evidence already supplies a future recheck.

The standalone browser-safe display parser now implements this closed schema. It snapshots foreign input, requires every declared key, refuses unsupported variants and inconsistent combinations, and returns a detached deeply frozen object. Codex current-identity prepared or retryable work may coexist with `continue`, because the reducer's below-threshold branch precedes the reset gate; it cannot coexist with advice to reset, move or wait. Different-identity prepared or retryable work permits only disabled or reset-reconciliation advice when an evaluation is present. The parser does not equate current-identity history, policy windows and independently retained pending work. The outer joined contract must still bind any disabled advice to the actual automatic configuration.

That policy join must preserve reducer ordering: invalid input returns reconciliation before effective policy is resolved. Configured-off therefore permits disabled or invalid-input reconciliation advice, not an unconditional off-to-disabled equivalence. Other evaluated decisions require effective-on; unavailable configuration cannot substantiate disabled or a successfully parsed evaluation. Non-advisory snapshot conflict and independently known recovery retain their existing precedence. Similarly, source-active checks follow input, policy and account-order checks, so an inactive source does not rule out earlier diagnostics. Public display fields cannot reconstruct the omitted private authority or prove the reducer's evaluation.

Independent branchwise JSON calculations replace the retired 467-byte estimate with conservative standalone ceilings of 538 bytes for Codex and 245 for Claude. The largest branch components are not jointly reachable: tests reject their incompatible combination and separately prove that valid wide displays fit. These are not complete-head or encrypted-envelope limits. This parser grants no execution, identity, freshness or publication authority.

A new bounded, coherent read must bind current source and identity, configuration, quota, reset policy, independently recoverable attempts, current-identity history, order and pointer inputs. Existing recoverable and latest-history methods filter by fingerprint, while `account usage` assembles separate reads and lacks some inputs. Neither can supply this snapshot unchanged. Duplicate recoverable evidence or malformed rows must remain unavailable. Refresh, reset authorization and recovery helpers can mutate or dispatch and cannot serve as a cached projector. Until runtime integration supplies a proved evaluation, next action stays explicitly unavailable.

The read-only implementation may proceed without a new schema, but must return private domain facts from one synchronous database snapshot, not cloud IDs, an outbox revision or execution advice. A returned-row limit alone does not bound query work: the existing latest-history index orders identity and window before attempt sequence, and the Codex identity filter inspects stored JSON. Use index-compatible bounded raw candidate reads, strict row and provenance checks, and explicit unavailability on incomplete verification. Reset pruning bounds only expired terminal history, not all live or unresolved attempts. The pending-only index excludes malformed states outside its predicate, so it cannot alone prove a complete valid reset snapshot. Missing sidecars must not disappear through inner joins. These are implementation requirements, not a completed producer or an approved new retention rule.

Capture detached private identity inputs before leaving that transaction. Reset fingerprints preserve `email.trim().toLowerCase()` before SHA-256, whereas the existing Codex account-match HMAC preserves `email.normalize("NFKC").trim().toLocaleLowerCase("en-US")`. These are distinct historical preimages. Never substitute one digest or normalization for the other, or reread a mutable profile after an asynchronous derivation. A coherent cached source is not proof of live authentication or publication currentness after an await.

For quota, select the newest raw retained Codex row before identity or sidecar filtering, then validate its bounded body, original digest and exact current attribution without falling back to older data. Claude receipt selection and validation stay independent per component, preserving their own clocks. A source-local receipt scan can detect a missing selected component, but cannot detect every orphan component whose receipt disappeared or an entirely deleted newest pair. Do not claim that stronger inverse guarantee or introduce a global scan that silently makes one source's availability depend on unrelated accounts. A stronger source-indexed ownership or retained-head proof needs a separately reviewed schema and lifecycle design.

The first preparatory storage slice is `readProviderUsageSourceMetadata`: one synchronous read transaction captures independently available source, order and automatic-configuration blocks. It accepts an exact provider and provider-account ID, verifies the selected non-removed binding and profile inverse, and requires Codex readiness and process-generation mirrors. Claude retains independent readiness and generation and cannot inherit the profile's Codex identity. Process generation zero and nullable, zero or future readiness observation times remain cached facts. Existing coherent listing and append-only configuration readers keep their full proofs inside this outer snapshot; a component failure does not invent absence or discard independent blocks. No labels, plan names, quota, reset history, action advice, cloud IDs or publication revision enter the result. This helper alone is not a coherent usage observation or a new user-visible command.

Private Codex identity input has a new read ceiling of 1,024 UTF-16 units and 3,072 UTF-8 bytes, without changing storage admission or V1. Capture bounded original bytes, require fatal UTF-8 decoding, reject empty-after-trim, raw control characters and unpaired surrogates, and preserve the admitted string without normalization. Do not add RFC email validation or apply the narrower cloud account-match admission here. Either over-limit mirror takes precedence over raw mirror mismatch; mismatch takes precedence over equal missing or invalid scalar input. Each refusal affects identity only. This is cached derivation input, not live authentication or permission to publish. A future complete read must join quota and reset facts inside the same database snapshot, rather than compose separately returned metadata and observation reads.

That next composition must establish retained recovery ownership separately from usable current source metadata. A proved binding/profile link may still identify pending reset work when current readiness, generation mirrors or email are invalid. Select recovery by that verified scope, not current fingerprint; an unproved link or incomplete scan means unavailable, never none. The completed observation-only read can then back the provider-qualified cached `account usage` command without altering legacy refresh, V1 publication or history selection.

### Phase 8 component-codec boundary

The first approved implementation is a standalone browser-safe component parser, not a head, envelope, uploader or new wire-format admission. Its closed provider union carries quota, accounting, cached readiness and automatic configuration. Every field is required; every object is exact-key, detached from foreign inputs and deeply immutable. Collections retain all 101 supported Codex limits, 16 Claude quota windows and 32 Claude model-accounting rows, reject duplicate keys and sort canonically. Malformed or oversized inputs are refused without trimming, truncation, defaults or manufactured unavailable states. A later reviewed projector may explicitly mark an entire unrepresentable component unavailable.

Codex quota retains each limit ID, reached type and both nullable windows; display names, plan names and redundant limit IDs are excluded. Claude quota retains account-scoped windows and the known or unknown status and overage fields. Claude accounting means the latest observed terminal result, never lifetime or account-wide accounting. Codex accounting is explicitly `not_projected`: existing daily, lifetime and derived history stays outside the frequently uploaded current-settings block, not falsely classified as unsupported. Raw local account, profile, session and turn IDs, generations, authority digests, idempotency keys and action receipts are excluded.

Observation and receive times remain component-local. Claude's event contract requires equal local receive timestamps within each component, but new accounting cannot refresh quota. Codex's observation time follows its usage RPCs and its receive time is separately stamped; neither is a provider clock. Cached readiness keeps its nullable observation time, and configuration retains its revision, default and provider override without an invented timestamp. Missing counters stay null. The current native Codex decoder collapses missing reset-credit availability to zero, so a future projector must not present stored zero as observed zero without independent presence evidence; positive counts remain distinguishable.

Public codes use the bounded ASCII alphabet already needed by provider codes, with at most 256 characters for a Codex limit ID and 128 for other codes. They additionally refuse absolute paths and the existing complete redactor's recognized credential grammar. Independent review found that the older public-text credential predicate omitted several already-recognized vendor families. A behavior-preserving extraction shares the canonical grammar with this new parser while leaving existing complete and streaming redaction, scalar normalization and historical codecs unchanged. The predicate is a refusal boundary, not permission to publish arbitrary secrets or a guarantee of universal credential detection.

Independent symbolic calculations bound the complete selected component block at 68,738 UTF-8 JSON bytes for Codex and 18,598 for Claude. The calculation includes all rows, longest fixed states, maximum safe integer scalars and a conservative 24-byte bound for finite nonnegative numbers. These are component bounds only; 64 KiB is insufficient even before outer framing. The composed head, reset/advisory display and authenticated envelope have their separately reviewed codec boundaries and bounds. Identity lifecycle, complete order/default joins, durable revision/outbox and the coherent producer remain separate implementation and review gates. V1 bytes, APIs and limits stay unchanged.

### Phase 8 composed-head codec boundary

The next approved standalone parser composes the existing component and display objects, retaining their provider discriminants and requiring all three providers to agree. Flattening would save only 65 to 67 bytes while changing both reviewed codec boundaries. The exact head keys are `version`, `userPublicId`, `sourceDevicePublicId`, `provider`, `sourcePublicId`, `sourceRevision`, `keyVersion`, `codexAccountMatchPublicId`, `order`, `components` and `display`. Version is 2. Parse and detach an independently supplied expected context before inspecting the head, then require every duplicated public context field to match. Canonical API origin remains external AAD context, not a payload field. Codex's optional link is null or the existing `codex_` plus 48 lowercase hexadecimal characters; Claude's is always null. Current-identity unavailability with reason `identity_unavailable` forbids that link, but does not itself prove that newly captured quota is invalid; `snapshot_conflict` is not the same identity claim. No labels, session lists, additional outer model-selection fields or private authority enter this head. Existing bounded Claude per-model accounting remains inside its component.

Cached order has exactly `state`, `orderRevision`, `pointerRevision`, `orderPosition`, `accountCount` and `active`. Revisions are positive safe integers; position and count are integers with `1 <= orderPosition <= accountCount <= 10000`. Count means complete non-removed provider-order membership at its order revision, not signed-in accounts or loaded browser rows. Count 1 requires the sole binding to be active. Unavailable order carries only `state` and a `snapshot_conflict` or `representation_limit` reason. The existing coherent listing validates complete membership and the pointer but may still refuse at its inverse-profile or byte limit; refusal cannot become a truncated cached order.

The actual policy-input maximum is 1,000 accounts, smaller than the listing bound. Cached count above 1,000 permits only invalid-input advisory for either provider, including configured-off, because input parsing precedes both policy and provider branches. Independently blocked recovery and unavailable advice remain representable. At smaller counts, policy/advice agreement preserves the invalid-input-before-off exception described above. For cached Codex order, not-active-source advice requires an inactive source; disabled, invalid-input and account-order-conflict advice precede that check and permit either value. All other admitted Codex advice requires an active source. Claude does not run the active-source check. No extra quota/readiness/history/time equality is inferred from omitted private reducer evidence.

Independent field, punctuation and whole-skeleton calculations bound the composed plaintext at 69,961 bytes for Codex and 19,477 for Claude, including the existing nested provider fields and a 144-byte maximum cached order. These are conservative ceilings, not reachable maxima: the largest count itself excludes many advisory branches. This parser does not encrypt, publish, acquire trusted context, prove an evaluation or admit hosted writes. Matching counts and revisions across arriving heads do not prove collection completeness. Complete coherent producer inputs, durable source/outbox/retirement lifecycle, registry/session mapping, encryption and final hosted admission remain separate gates.

## Phase 9: Browser settings usage visualization

- **Status:** Not started
- **Depends on:** Phase 8
- **Objective:** Render the hosted usage and existing session authorities as one clear, accessible settings view without inventing missing provider facts.
- **Scope:** App function references, usage and session decryption, wire types, framework-free view model, relative-time formatting, settings screen, accessibility behavior, and app tests.
- **Out of scope:** Browser account-order or policy mutations, hosted schema changes, provider effects.
- **Approach:** Load and paginate the existing session-head authority, join it to provider accounts and usage current heads by opaque provider-account ID, and keep v1/unavailable paths explicit. Derive every visual and sentence in a framework-free model before rendering. Use accessible progress bars and text labels, relative reset countdowns with absolute instants, and component-specific freshness.
- **Acceptance criteria:**
  - Settings groups every loaded connected session by machine, provider, and account and shows state, requested/actual model when known, and active marker.
  - Each account shows remaining percentage, window length, relative and absolute reset time, readiness, order, reset credits, reset-policy state, component freshness, and the exact next supported action.
  - Claude displays `as of the last observed turn` and never implies idle polling, current availability, or per-model quota.
  - Missing keys, old payloads, locked keys, stale observations, pagination gaps, and unknown readiness have useful non-mutating empty states.
  - App view-model fixtures and CLI fixtures produce semantically identical policy explanations for the same frozen inputs.
- **Validation:** `bun test ./app/src/data ./app/src/model ./app/src/screens --isolate --max-concurrency=1 && bun run build:app`

## Phase 10: Contract convergence, validation, and delivery

- **Status:** In progress for the scoped foundation delivery; whole-feature completion remains pending Phases 6 through 9.
- **Depends on:** Phase 9 for whole-feature completion. The current delivery checkpoint above explicitly limits the foundation artifact's scope and claims.
- **Objective:** Converge documentation and code, obtain independent whole-feature review, pass the authoritative gate, and deliver through repository policy.
- **Scope:** `docs/usage-management.md`, `docs/providers/claude.md`, `docs/hosted-sync.md`, `README.md`, active plan evidence, generated convergence artifacts only when proven, delivery records.
- **Out of scope:** Expanding the explicitly deferred Claude automation boundary.
- **Approach:** Audit public claims against tests and exact runtime behavior. Run independent final review against this plan. Repair every in-scope finding and rerun invalidated focused checks. Follow the reviewed [final validation policy](../../CONTRIBUTING.md#final-validation): complete `Required` CI owns the final source aggregate when command coverage and shard equivalence to the unchanged `bun run check` are established. Independently review the complete diff and impact, run the existing command-coverage and shard-equivalence tests, and require fresh CI for the final PR head and current-base integration candidate. Retain separate local browser, native, coupled-run and installation acceptance, and diagnose observed failures or stalls even if CI passes. If coverage or equivalence is absent or uncertain, run the unchanged local `bun run check` through the resolved absolute `oompa-host-run` with `--mode=exclusive --lane=compute`; its process-recovery journal remains shared. Commit coherent task-owned changes, push, open the PR, wait for required checks/reviews, merge, perform any repository-required release, and deploy hosted changes only through the attested candidate chain in `docs/hosted-sync.md`. Do not weaken a gate or bypass an enforced approval.
- **Acceptance criteria:**
  - Documentation states the 99 percent threshold, reset-before-switch order, active/default semantics, provider observation sources and freshness, switches, supported actions, and deliberate deferrals.
  - Independent final review finds no unresolved correctness, recovery, privacy, compatibility, or contract issue within scope.
  - Fresh complete `Required` CI passes for the final head and current-base integration candidate, including all eight macOS/Ubuntu jobs and the separate browser job. Record the head, base, checked tree, run, attempt and final `Required` result; head or base movement requires fresh matching evidence. Coverage and equivalence are independently reviewed and tested, or the unchanged exclusive local `bun run check` passes as the source fallback.
  - Explicit local browser, native, coupled-run, live and installation acceptance passes where applicable. Source CI does not substitute for these checks or dismiss an observed failure. Release, deployment and production-readback gates remain separate.
  - The final branch, commits, PR, required checks, merge SHA, release evidence if applicable, hosted candidate/deployment evidence if applicable, and production readback are recorded.
- **Validation:** Relevant focused contracts, plugin/adoption checks when applicable, and existing `scripts/release-workflow.test.ts` coverage/equivalence tests; fresh complete exact-candidate `Required` CI as the final source aggregate under the reviewed policy above. Retain host-scheduled `bun run check:browser`, native/coupled installation acceptance, and repository PR, merge, release, deployment and production-verification checks as documented. The unchanged exclusive local `bun run check` remains the source fallback when equivalence is uncertain.

## Required scenario matrix

- Same profile with independent Codex and Claude provider-account generations, observations, order, and readiness.
- Migration restart before, during, and after provider-account backfill.
- Invalid order permutation, duplicate selector, cross-provider selector, active removal, and simultaneous activation.
- Codex observation at 98.99, 99, and 100 percent; weekly keyed limit and legacy primary fallback; credit present, absent, and ambiguous.
- Codex keyed map with and without exact `codex`; primary below and secondary exhausted; null secondary; malformed present window; no applicable windows; conflicting reached type; weekly reset followed by another still-exhausted window.
- Claude rate event before result; duplicate and reordered events; allowed, warning, blocked, denied, rejected, and unknown status; generic unified windows never treated as model-scoped.
- Claude result accounting after a rate observation; accounting time advances while quota freshness remains unchanged.
- Observation exactly at and just beyond the provider freshness boundary; exhausted evidence before and after reset.
- Two sessions see one exhausted Codex account; target logs out or changes generation; order or policy changes during evaluation.
- Exhausted non-active account observation leaves the pointer unchanged; active A-to-B then B-to-C move lineage lets a managed session on A follow the exact chain or reconcile a gap.
- Observation-triggered pointer rotation with no provider thread or turn, followed by one managed `switch_and_forward` at the next explicit input; no standalone seed plus duplicate input.
- Switch crash after prepare, target start, source release, rebind, seed prepare, and seed dispatch, followed by daemon restart at every point.
- Maximum-size pending input with no transcript room; same-key retry before dispatch; crash after target/rebind but before dispatch; ambiguous target dispatch with no retry.
- Automatic action never runs inside the fact callback.
- Classifier says working without exact rate-limit terminal cause; no continuation.
- Exact rate-limit terminal cause before and after restart; no Oompa-authored continuation or replay.
- Claude process arguments with automatic management on and off; reported terminal model differs from requested model after native fallback.
- V1 and v2 hosted payload dual-read, exact-key refusal, tamper, oversize, source-device join, 60-second current-head coalescing and server admission, out-of-order current revisions, daily history retention, locked-key state, and old-browser compatibility.
- CLI and browser render the same frozen policy fixture, including stale, disabled, observe-only, reset, switch, and wait explanations.

## Delivery policy

- Use the task-owned feature branch from current `origin/main`; preserve unrelated work and never force-push.
- Commit coherent reviewed phases. A phase commit is not proof of completion until its focused checks and independent review pass.
- Push and open a pull request after the converged final gate. Wait for all repository-required reviews and checks, repair failures, and merge through the documented workflow without requesting redundant confirmation.
- Run releases only when repository policy says the merged change requires one. Record the release artifact and verification.
- Hosted and app changes use the attested candidate and production-deployment chain in `docs/hosted-sync.md`; a PR merge is not deployment evidence.
- Never reuse a validation receipt for the required final integration, merge, release, deployment, or production readback.

## Implementation log

- 2026-09-07, source-metadata storage preparation verified: the new synchronous read captures private source identity, cached readiness, complete order summary and automatic configuration without changing existing callers, schema or writes. Independent review approved its exact source/profile attribution, independent Claude state, isolated failures and detached deeply frozen output. The first focused run exposed accessor-based request admission: 29 tests passed and one failed. The repair snapshots foreign JSON before parsing, refusing accessors and nondefault prototypes without invoking property getters. It does not claim to suppress Proxy reflection traps.

  Additional review found that SQLite's text decoding can collapse different malformed byte strings. Identity selection now materializes only bounded BLOBs, compares original bytes and uses fatal UTF-8 decoding with BOM preservation. Tests verify exact stored malformed bytes, raw mirror precedence, full-width size boundaries, independent source/order/policy failures and one read snapshot across a real second-writer commit. The whole-database no-write oracle hashes cell types and raw text/blob bytes, not lossy decoded strings. A failed BOM fixture was corrected after proving that JavaScript-string binding stripped the BOM before storage; explicit BLOB-to-text insertion and a stored-hex control now isolate reader behavior. The final focused suite passed 40 tests with 1,770 assertions. Independent review and scoped product/test lint passed. The initial TypeScript check found only an expected-value discriminator error in the test; its correction preserves full result equality. The fresh final host-scheduled TypeScript check passed.

  Independent actual-archive review approved only the 11,041-byte StateStore addition. All 187 packaged files match source; paths, modes, manifest, entrypoints and exclusions remain unchanged. Tar ordering and header formatting differ between packers and are not claimed byte-identical. The reviewed filesystem inventory retains 197 entries and 9,362 canonical bytes with digest `33137a5bb6c627a119310492709b8a12afee8b9a6cfba4295cfc8623a83c6f35`; direct package admission, installer pins, unchanged security inventory and public-text checks passed. This is metadata preparation only, not the complete quota/reset snapshot, a CLI consumer or a V2 producer. The earlier `6c7e4d1` full gate does not cover this later diff; integration and delivery gates remain required.

  A live prerequisite recheck still found [memory PR 135](https://github.com/hraness/oompa/pull/135) open at `cf33a7abfa7ff9b0c6ea42a98c3210f5f02db4d7` with failed Ubuntu and required CI. Main advanced to `b1f7743626bc93c135efdd441e235ac85ddd4c42` for v0.6.3 release preparation; its exact diff from `0aa3fd5` does not change StateStore or resolve the schema-46 collision. Release preparation is not evidence of artifact admission or this feature's deployment. No upstream mutation, CI rerun or task delivery action was taken.

- 2026-09-07, reset-integrity checkpoint aggregate gate passed: exact commit `6c7e4d104c503c2ce38ad37437305cf6cddf4793`, tree `7ffc7e4c7de04ff41f3c91531d0b3c299af59d98`, passed the complete host-scheduled `bun run check`. The isolated verification checkout retained only the exact task ref, remained nonshallow and finished clean. Pins, the 46-file security inventory, full lint, TypeScript, 673 script tests, 108 local-plugin tests, 29 cloud-plugin tests, 4,190 source tests, 286 hosted/site tests, 446 app tests, 10 package-policy tests, all builds, complete governed-history and package checks, restored PTY and isolated local/global installation and daemon lifecycle passed. The total was 5,742 tests with 251,221 assertions and no failures. This receipt covers the composed head, envelope and reset-attempt reader checkpoints, not subsequent metadata work or a complete-feature release. No task push, PR, merge, release or deployment has occurred.

- 2026-09-07, live governed-source delivery check: [memory PR 135](https://github.com/hraness/oompa/pull/135) is open at `cf33a7abfa7ff9b0c6ea42a98c3210f5f02db4d7`. CI run `34162099769` passed macOS but failed Ubuntu and its required aggregate; CodeQL passed. The Ubuntu source suite reported 3,379 passing tests and one failure with 152,471 assertions. The failed v20 physical queue-body scrub case found the resolved-ambiguous message sentinel in the main database file after migration, while its preceding terminal-message check passed. This is observed failure evidence, not a proved environmental cause or permission to retry unchanged. No upstream PR mutation, rerun, merge or deployment was performed by this task. Live main is now `0aa3fd563e369f75875136ca1f550016e70035e8`; its new schema-46 collision is recorded above. This branch's independent exact `6c7e4d1` full gate remains separate from that prerequisite CI.

- 2026-09-07, reset-attempt reader constraints verified: adversarial review found that the scalar mapper accepted cross-field contradictions forbidden by the original schema-27 table. The same constraints are present in archived canonical-40, private-48 and combined-49 sources. The bounded repair requires current generation not to precede origin generation, update time not to precede creation, and the exact pending, settled or locally closed outcome combination. It adds no current-generation, current-clock, window or inter-attempt ordering assumption and changes no schema, guard or stored evidence.

  Before repair, both legal-control tests passed while 14 malformed-row cases and the seeded inequality campaign failed because selected readers and preparation replay accepted the contradictory rows. After the 11-line mapper check, all 17 tests passed with 851 assertions. Genuine API-created states cover all outcomes and local resolutions, equality, a real generation rebind and zero/maximum-safe clock bounds. Committed disposable corruption restores the exact triggers and CHECK enforcement before product reads. Complete row hashes, schema and database-version snapshots prove the selected rejected paths leave durable state unchanged. Independent source and test review approved the repair. The existing reset, migration and daemon compatibility slice passed 73 tests with 790 assertions; TypeScript, scoped lint, installer pins, the unchanged 46-file security inventory and public-text checks passed.

  Independent inspection of the actual package approved only the 637-byte StateStore addition; all other published bytes, manifest fields, exclusions and modes remain unchanged. The inventory retains 197 entries and 9,362 canonical bytes with digest `fbbb55e62c5e8b0d00ddd12409d6fb1c8c15c35e360a170240e65bfe43330d7f`.

  This is a reader and selected pre-write replay repair, not a claim that every corrupt mutation is inert. SQL-only recovery and identity closure, and methods that update before mapping their result, remain distinct paths. The future coherent cached snapshot and full-feature delivery remain incomplete. A fresh exact-tree repository gate is required for this checkpoint; the prior display-only receipt does not cover it.

- 2026-09-07, encrypted-envelope preparation verified: the separate V2 wrapper encrypts only parsed canonical heads and authenticates the independently supplied deployment, user, device, provider, source, revision and key context. It snapshots the genuine nonshared 32-byte key before inspecting foreign objects, owns all data across asynchronous boundaries, enforces the provider-specific byte limits, refuses alternate base64url spellings and malformed UTF-8, and never falls back to V1. Encryption shares the existing process-wide key/version budget and preserves its original typed rotation refusal. Other failures expose only fixed operation-specific diagnostics. The native key-copy helper was extracted without changing its captured descriptors, body or call ordering; its unchanged context suite passed 14 tests with 2,635 assertions.

  Independent source review approved the wrapper and extraction. The focused envelope suite passed 16 tests with 2,577 assertions, including independent authenticated malformed fixtures, every AAD field, caller mutation, key brands, exact size boundaries, real V1/V2 budget exhaustion, two seeded campaigns and an in-memory browser build. Review strengthened the UTF-8 oracle: malformed bytes that permissive decoding would turn into an accepted head are authenticated successfully by the primitive but refused by the wrapper, while a valid UTF-8 sibling succeeds. This isolates fatal decoding without claiming duplicate-key rejection. Final TypeScript and scoped product/test lint passed. The package-policy-only follow-up changes three reviewed inventory literals and passed its own lint and direct admission.

  Independent raw gzip/tar and extracted-tree inspection approved the actual archive. Its only production changes from the composed-head archive are the key-helper extraction and new 4,784-byte envelope helper; every other published byte, manifest, entrypoint, exclusion and mode is unchanged. The reviewed inventory is 197 entries, 9,362 canonical bytes, digest `c176d116f76f42c039beda3ed65749ee997f8a81bdb526ba39637f4768ae4ec3`. This checkpoint adds no schema, trusted-context acquisition, persistent budget high-water, outbox, runtime action or production caller. The complete-feature integration, delivery gates and deployment remain pending. The earlier exact `c206abcd` full-check receipt does not cover this later diff.

- 2026-09-07, composed-head preparation reviewed: the standalone parser binds the expected context and both existing provider blocks, preserving their detached immutable data. Independent review approved the policy/active-source ordering and the new complete-membership count. A count above the reducer's 1,000-account limit cannot advertise successful evaluation, while the listing's 10,000-account limit remains available for truthful cached metadata. Known recovery is not hidden by either bound. The focused suite passed 16 tests with 9,599 assertions, including exact context mismatches, causal snapshot-order traps, policy/override and count matrices, independent identity/time/history semantics, cross-block alias refusal, two seeded campaigns and an in-memory browser build. Product and test lint, pins, unchanged security inventory and public-text checks passed. Full-width valid heads preserve every supported component row and fit the independently calculated conservative ceilings; no test claims that incompatible maxima can coexist. This is not encryption, a producer, hosted admission or delivery.

  Independent raw gzip/tar and extracted-tree inspection approved the actual archive: it adds only the 7,344-byte composed-head helper to the prior production bytes, with unchanged manifest, entrypoints, exclusions and modes. Its inventory is 195 entries, 9,265 canonical bytes, digest `9255cfd78468c820a8bca54bc40b5e65fd21443ba9938aad6339824a43da0f8b`. The deliberate three-constant inventory update passed direct admission and scoped lint. The encryption design review separately proved why V2 must reject alternate base64url pad-bit spellings without changing V1, and retained the process-wide budget and exact outbox distinctions. That wrapper is not implemented by this checkpoint.

  The preceding display/freshness checkpoint `c206abcd6cbd0958ff18b4c1baea55a1024a3eec`, tree `9b2f34473ff4c65d9a2ec10badf121aba08e0c8c`, passed the complete host-scheduled `bun run check`. Its existing verification checkout fetched only the exact task ref, remained nonshallow and finished clean. Pins, security inventory, full lint, TypeScript, 673 script tests, 108 local-plugin tests, 29 cloud-plugin tests, 4,141 source tests, 286 hosted/site tests, 446 app tests, 10 package-policy tests, all builds, complete governed-history and package checks, restored PTY and isolated local/global installation and daemon lifecycle passed. That is 5,693 tests with 238,193 assertions and no failures. This receipt belongs to the display checkpoint, not the later composed-head diff or complete-feature release. The composed-head product and tests separately passed their fresh host-scheduled TypeScript check.

  Upstream's documentation checkpoint `cf33a7abfa7ff9b0c6ea42a98c3210f5f02db4d7`, tree `6cf53689e1100a1ca70824f6d6b98b4429cc0f1d`, now records a passing exact-ref full gate and the remaining provider-focused check for predecessor `c4ea6a003a8cbded77eb54402f8c60e8b00c430d`. The new commit changes only documentation and explicitly requires its own exact-tree gate. Required source PR/review and merged-main validation remain open; live rollout and release proofs are still separate. Neither that update nor the separate admitted auth artifact is a usage-feature deployment or approval to mechanically compose this branch's authority schema.

- 2026-09-07, standalone display codec reviewed: the parser and its independently reviewed tests preserve provider-specific advice, independently retained recovery, exact keys, safe timestamps and detached immutable output. The focused suite passed 14 tests with 8,272 assertions and scoped lint. Its two fixed-seed campaigns cover arbitrary-input totality and valid canonical variants; the in-memory browser build has no native or execution dependency. A test-only null-prototype assumption was corrected to match the existing foreign-JSON boundary, and a valid alias fixture proves shared-reference rejection independently of shape refusal. Complete-head binding, coherent reads, producer and hosted admission remain separate gates.

  The settings freshness audit found that a future registry heartbeat made the fallback report online even when hosted presence was false. Deterministic and property regressions reproduced the bug before the change, including a one-millisecond counterexample. The fallback now requires an age from zero through the existing three-minute tolerance, preserving authoritative hosted presence, missing/revoked refusal and the original timestamp. The parser-validated machine-view fixture and command-target regressions passed within 46 tests and 1,174 assertions; scoped lint and independent review passed. Offline machines remain eligible queued command targets. This repair does not implement the Phase 9 usage view.

  Host-scheduled TypeScript and the production app build passed on the frozen product and tests. Installer pins, the unchanged 46-file security inventory, public-text policy and whitespace checks passed. Independent raw archive and extracted-tree review found only the new 15,355-byte display helper added to the preceding production bytes, with unchanged manifest, entrypoints, exclusions and modes. The actual archive's reviewed inventory is 194 entries, 9,218 canonical bytes, digest `082f78aca2dfbe55e227764306ec1c3738eb6f87a37fc45f96d718a9f8c132eb`. Direct admission and the deliberate three-constant policy update passed. The next exact-tree aggregate remains required before submission; no usage-feature release or deployment is claimed.

  The auth-to-memory join is now clean and committed at `c4ea6a003a8cbded77eb54402f8c60e8b00c430d`, tree `131a8a633e0f919bfebb385798ffe6c4ddefe71a`. Read-only review of its committed evidence preserves released budget 44 and admitted auth 45, followed by unshipped memory 46 and 47. Its exact-ref aggregate, remaining focused check and required source review are still pending; this is an immutable preparation candidate, not an admitted source join. Separate authenticated proofs and the 0.7 release remain open. This task has not adopted the merge or allocated successor migrations from it.

  Further committed-source review confirms that the earlier composition cannot be renumbered mechanically. Canonical routing 42 and transcript 43 are not the earlier memory-source cohort at the same stamps. Transcript columns extend both mutation and queue parents, while peer memory extends queues again; fresh/canonical and private/combined routes therefore require separately proved exact layouts. New optional preset-contract and switch retention-gap fields, the automation actor and current preset selection require a newly qualified evidence dialect without widening frozen readers. Upstream maintenance must be reconciled with sealed manifests, pinned original owners, quarantined queues and custody-release proofs inside this task's stronger immediate-transaction admission. The nine existing task batches would arithmetically follow canonical 47 at 48 through 56, but that is only a conditional map, not a final allocation or proof that no further provenance migration is required. Preserve every retained ledger time, fixture, definition, payload and digest until exact source and route-specific composition gates pass.

- 2026-09-07, source-context preparation reviewed: the new standalone helper binds source identity and public AAD to the canonical deployment origin, user, enrolled device, provider, binding and key context using the selected exact arrays. It retains the existing HMAC implementation and changes neither V1 nor production callers. Independent review approved the native-brand, fixed-size key copy before foreign context inspection and asynchronous work. Scoped lint initially identified unbound native-method captures; retaining their captured descriptors and invoking each with an explicit receiver preserves the checks without suppressing lint.

  The final focused context suite passed 14 tests with 2,635 assertions. It includes independent literal Codex and Claude HMAC vectors, every identity/context field, fixed diagnostics, native URL pre- and post-normalization 4,096-byte boundaries, multibyte contraction, offset views, Buffer, hostile subclasses and another JavaScript realm. Caller mutation after invocation and during foreign-context inspection cannot replace the copied key. Shared, detached, proxy and wrong-kind key inputs are refused. Two fixed-seed campaigns cover totality and valid canonical framing. Independent test review corrected an initial detachment oracle to retain and mutate the actual passed object. The first TypeScript run found only a sparse-array fixture's missing type; its explicit unknown-element annotation preserves the malformed-array test. Final repaired TypeScript, focused lint, public-text policy and whitespace checks passed.

  Existing usage, encrypted-payload and cryptography regressions passed 44 tests with 264 assertions, retaining the V1 maximum envelope and GCM budget checks. Pins and the unchanged 46-file security inventory passed. The rebuilt archive passed independent raw gzip/tar, path, type, mode, manifest and every-file source-byte inspection. It adds only the 7,157-byte context helper to the preceding reviewed production bytes. Its inventory is 193 entries, 9,167 canonical bytes, digest `9283668b17b4d05a255f59a07851e07a27d43d5e59168d784b8711a39b6712f7`; direct admission and the deliberate three-constant policy update passed. The pre-lint archive remains superseded evidence, not the reviewed artifact. The reset-display review separately corrected provider-impossible advice and identity-dependent loss of pending evidence, without implementing a display codec or producer. The governed schema join, full-head and lifecycle contracts, managed runtime, remaining CLI/hosted/browser work and every delivery gate remain open.

- 2026-09-07, browser-safe component preparation verified: independent review confirmed the closed component scope and independently reproduced the 68,738-byte Codex and 18,598-byte Claude bounds. It identified a concrete credential-family gap in the proposed narrow text predicate before codec admission. The existing canonical redaction grammar now lives in an import-free domain leaf, with original exports retained through the complete redactor. Exact comparison preserves every moved regex, flag and replacement step, and the remaining scalar/terminal wrapper is unchanged. Independent implementation review approved that extraction. Complete, streaming and session-event redaction passed 25 tests with 83,339 assertions, including new repeated-call ASCII parity and export-identity tests; scoped lint, installer pins and the unchanged 46-file security inventory passed. No V1, encryption, producer, storage or hosted admission changed.

  The strengthened component suite passed 12 tests with 1,001 assertions, including an in-memory browser build. Review found that the initial overflow fixtures also contained duplicates, which could mask a missing count guard. New unique 102/17/33-row cases validate each row and the exact-cap prefix, stay below the byte ceiling, then prove count-only refusal. Full-width fixtures attain both exact byte maxima. The root's final instruction audit then added the required property coverage: two fixed-seed, 200-case campaigns check foreign-value totality and valid nullable components, canonical JSON/parse idempotence, row/key permutation, detached immutable output and caller mutation. The initial TypeScript check found test-only raw-value equality overload errors and an unsupported pinned Bun build option. An unknown-value equality helper preserves all ten assertions; omitting the unsupported option preserves the in-memory build, and decoding its file URL also fixes paths containing spaces. No product type or parser behavior changed. The final focused run passed 14 tests with 8,053 assertions. Independent source, property and fixture-repair review, scoped lint, whitespace and the fresh converged TypeScript check passed.

  The actual archive passed independent gzip/tar header, checksum, path, type, mode, include/exclude and every-file source-byte inspection. Its approved inventory is 192 entries, 9,117 canonical bytes, digest `74e05f27a3697e489fab7977ab051f11ee214bc19d280582504df9a6a2f9f3d2`. It adds only the two reviewed production modules and reduces the original redactor wrapper; all other production bytes, bin/exports and exclusion rules are unchanged. Direct inventory admission and the deliberate three-constant policy update passed. The next exact-tree integration gate remains required before submission; this bounded checkpoint does not advance hosted publication or complete-feature delivery.

  The preceding `84eeca6eb8a1ff65df9f9f0614452d01f9de8655` checkpoint, tree `22cd1a62017c1309e000cf3c6fd85b5468cc59de`, passed the complete host-scheduled `bun run check`. Its nonshallow verification clone retained only the exact governed ref and stayed clean. Pins, security inventory, lint, TypeScript, 673 script tests, 108 local-efficiency tests, 29 cloud-efficiency tests, all 4,097 source tests, 286 hosted/site tests, 441 app tests, 10 package-policy tests, site/app/CLI builds and the full package/history/consumer gate passed. This closes the earlier documented content-parity failure on that exact checkpoint, not the later component diff or complete-feature delivery.

  Authentication is now admitted as canonical main `5c5c02ee5964167fb85e92da53cdb80c87991890`, preserving candidate `66c18cab995cf07d3c18234d2a111735456b503a`'s exact tree `3f226e97912b667b67eea29a5f2ec66fe6f071da`. Memory's `7e01b332639c9b2cfae968c32589b940dc989216` aggregate again stalled in synchronous Git fixture setup, so its earlier unread-pipe correction was not sufficient. New committed checkpoint `65a971ff84179dcfdf0d2e9d4cbb906263899a63`, tree `7069bdf4b3aa5ab04d1e11c3707ba77392dee793`, changes the test setup to the bounded asynchronous runner and is now joining exact auth main with unresolved source conflicts. That owner will preserve auth 45 and append unshipped memory 46/47. Do not consume its uncommitted integration or treat the pending repaired-fixture and joined-tree gates as passed. This task's final schema allocation and managed-runtime join remain open.

- 2026-09-07, authenticated-local composition checkpoint verified: the factory constructs one service and a frozen wrapper with a private bound local entry, retained only by the authenticated socket handler after its exact daemon-stop branch. Hosted commands and background polls keep the generic entry. Independent comparison proved the shared lifecycle body byte-identical to the preceding checkpoint, including shutdown tracking, fencing, housekeeping, sanitization and deferred-stop handling. This is a behavior-preserving prerequisite, not an original-send owner or automatic producer.

  The final composition suite passed 18 tests with 130 assertions; actual socket authentication and CLI placement passed two tests with 55 assertions; existing interaction quarantine, response-flush and exact-stop regressions passed 12 tests with 144 assertions. The first typecheck found a missing required cloud blocker in the new fixture. Supplying a typed fail-fast dependency preserved every assertion; the affected 18-case rerun and final typecheck passed. Changed-code lint, generated installer pins, the unchanged 46-file security inventory and whitespace checks passed. The actual final archive passed public-content, production-only, exact source-byte and mode checks. Its measured inventory remains 190 entries and 9,005 canonical bytes with digest `a6e05b3a1c7e2664c8d8bb41640869ecb481934a5c9d998ee01936253e0f6aca`; only README, CLI and service sizes changed. Independent source and actual-archive review approved the bounded checkpoint and deliberate inventory update, preserving every include/exclude and mode rule. The new exact-tree aggregate and complete-feature delivery remain separate gates.

- 2026-09-07, cached-list checkpoint aggregate and documentation correction: isolated commit `7d494da2975191ceb79cae07639eb964ed1bb4b7`, tree `fd76f3a96f6949b46fbb27743cd282bb5d6f9391`, passed installer pins, the 46-file security inventory, full lint and typecheck, 673 script tests, 108 local-efficiency tests, 29 cloud-efficiency tests and all 4,077 source tests. The hosted/site stage passed 284 tests and failed the public CLI-reference parity assertion. Its first missing line was automatic-policy status; exhaustive help comparison found all three automatic-policy command forms and the qualified account-list form absent. App, build and package stages were not reached. Complete diagnostics were retained; this is not an aggregate pass.

  The shared public-content source now includes those four exact command forms, cached-list bounds and uncertainty, inherited-policy and original-key replay semantics. Independent review corrected an overclaim: an admitted reset operation may remain uncertain, and settlement plus rereading follows a closed outcome rather than every provider attempt. Regeneration also exposed three earlier account-management boundary passages that existed only in README and would have been erased. A new two-surface regression failed before restoring those exact passages to the shared source. The final content suite passed 36 tests with 1,103 assertions without weakening its parity oracle; generation and generated-file parity passed, and the resulting README diff preserves every earlier boundary. Package inspection and the next exact-tree aggregate remain required.

  Authentication's later `e6b6bca7511f184170d7660b3bc901b13bdb2008` aggregate passed all source and hosted/site tests but stopped at an app fixture's old version marker. Corrected candidate `ffcee768e5dea1a889a198bee0a42e5ccaa76bcb`, tree `b391cbf1a28f12c935f778d82b093778729c613e`, still needs its exact full gate. Memory's current-main integration is now committed as `585438167137c2ee8974c110203c05b64c884d43`, tree `5b6dd1ed7e8fd0627a1d843120b370137342994c`, with reviewed focused evidence and a 173-entry archive. Its aggregate and later authentication join remain open. Physical schema allocation and this task's governed join are not yet settled.

- 2026-09-07, cached provider-account listing focused gate passed: the qualified Codex/Claude command now returns a strict, bounded, single-snapshot projection without changing bare profile listing. Independent review found that equal process generations could hide contradictory Codex/profile readiness. A real schema-valid regression returned the contradictory account before the Codex-only mirror check; the repaired storage/service gate passed 35 tests with 142 assertions. Claude readiness remains independent. Exact trigger restoration in isolated corruption fixtures, second-connection snapshot interleaving, read-only reopen, unchanged whole-database snapshots, count/byte ceilings, fixed private-error mapping and fail-on-access provider ports are covered.

  The domain suite passed seven tests with 472 assertions. New CLI tests passed 14 tests with 1,001 assertions; the existing focused parser/renderer regression slice passed 24 tests with 2,189 assertions. Both sinks reject malformed or cross-provider data before output, preserve terminal-safe labels and unknown timestamps, and retain exact bare command/output behavior. Scoped lint, converged typecheck and independent implementation review passed. The inspected archive matches source with unchanged include/exclude and mode rules; its deliberate inventory update is 190 entries, 9,005 canonical inventory bytes, digest `4e6e972876a97f88d80a026ba979e6fb074cb03c27242a10245648ebbee0ef6d`. This slice does not expose order/activation mutations, refresh providers or enable automatic routing. The exact-tree aggregate and complete-feature delivery remain separate gates.

- 2026-09-07, checkpoint aggregate and governed-join status: the isolated exact `6f3bd6c98780e21fb1f6ca0933df0b95d879c557` check passed installer pins, the 46-file security inventory, full lint and typecheck. Its script stage passed 671 tests and failed two installed-package hostile-descendant cleanup cases, with 6,722 assertions. The same two tests subsequently passed unchanged in that clean isolated tree, 22 assertions in 2.68 seconds. The original failure was not reproduced and its truncated diagnostics do not establish a cause. The runner uses a machine-wide recovery lock, but contention is not proved. No product, fixture or custody state was changed in diagnosis. The next aggregate must retain complete failure diagnostics. The failed check stopped before source tests and builds; no aggregate pass or delivery is claimed.

  Authentication now has clean committed schema-45 candidate `35c39b99afa6d2c74de4d31a948b790e9db75b77`, tree `c0ddde96f60f14a64c1ca4e2962b464f0562c8d6`, joining canonical main `4b50465c510f1e31a2cc6ac2be7b2a290391f0a4`. Its recorded full gate still belongs to the older authentication checkpoint, not this join. Memory checkpoint `7769187732846c6f70efcf16c3fda837380f9273` retains provisional memory migrations 44/45, its aggregate failed on a script timeout, and its current-main merge remains conflicted. Do not consume uncommitted integration files or allocate this task's next migration before the governed authentication-to-memory join passes its required gates.

- 2026-09-07, owned direct-send manifest checkpoint verified: a real attached request reproduced dispatch permission and committed claim/evidence with an empty manifest. The closed admission path now snapshots and strictly parses metadata, checks both ordered reference digest domains and retained canonical blob identities, and writes and verifies the manifest in the same transaction as the unchanged version-one claim, evidence and state transition. No producer, historical guard, receipt preimage or schema changes. Text-only calls retain omitted-metadata compatibility.

  The final 30-case storage matrix covers attached and attachment-only input, text-only and attached writable/read-only reopen, wrong or malformed metadata, hostile array/accessor input, accounting conflicts, six write-boundary rollbacks, rollback of normal 200-source pruning, competing claims and cancellation, retained pins, and immutable accepted/ambiguous history. The first expanded run passed 28 cases and failed one incorrect fixture assumption that a new daemon could revive retired source authority. The corrected five-case slice passed 66 assertions, including the three affected cleanup-helper callers; the other 25 cases are unchanged. A separate current-source stale-daemon test now proves rollback at the late claim fence, while real restart proves retained input and inert source conflict. The final typecheck passed after narrowing the fixture's verified canonical media type, without changing product admission.

  Shared original-request hashing passed 17 tests with 944 assertions and preserves explicit version-one preimages; existing owner compatibility passed 17 tests with 140 assertions. Scoped lint, the 46-file security inventory, installer pins and whitespace passed. Independent review approved the bounded implementation and tests. The stale package inventory was deliberately re-pinned from an independently inspected archive: 189 entries, 8,949 canonical inventory bytes, digest `182d243b62b3d6436802068a54ea5d347f1d8454c4530d437dee88c060d56f53`. Every archived file matches source and the existing include/exclude and mode rules remain enforced. No release tag or public installer URL changed.

  The memory source now has a clean checkpoint, but its physical migration allocation is not final: current main has consumed schema 44, and the authentication/current-main join is moving to an unpublished successor before memory can be composed. Do not allocate this task's destination version from the stale predecessor. The broader exact-checkpoint repository gate is next; the governed schema join, managed producer, remaining CLI/hosted/browser work, delivery gate, PR, merge, release and usage-feature deployment remain incomplete.

- 2026-09-07, bounded CLI policy controls verified: `oompa usage auto status [provider]` and revision/key-bound default or provider-override changes now reach the existing atomic configuration receipt store. Both output modes validate exact public fields, effective settings and request binding; a replay reports its original configuration, never a newly read head. Known occupied original-send keys report conflict while corrupt ownership stays recovery-required. A real CLI response-loss regression failed before adding the command to the unchanged-request replay guidance and passed afterward, two tests with 60 assertions. No automatic retry or provider operation was added.

  The converged domain/parser/renderer gate passed 126 tests with 6,357 assertions. A throwing refinement on continuable invalid revisions was repaired and now has seeded totality coverage. A later test-only literal typing correction passed its five-test, 856-assertion rerun. The final service command gate passed 14 tests with 188 assertions, including two-store CAS, unchanged unrelated receipts, immutable historical replay, sanitized failures and public disable preventing reset consumption. Its earlier failures were a superseded test-history shape and missing required fake-constructor/service options; the final typed fixtures passed unchanged behavioral assertions. Twelve real-storage key-ordering cases passed 240 assertions after correcting a queue fixture to use the existing account-key admission API. Review rejected the proposed reservation-key restriction: invocation reservations grant retention only, and final command admission owns the key. No storage code, historical guard or migration changed.

  Final typecheck, changed-code lint, the 46-file security inventory, generated working-tree installer pins, three installer-pin tests and whitespace checks passed. Actual CLI help runs with the documented grammar. Independent reviews approved this slice and the current-source guide. The upstream memory merge remains uncommitted and its separate approvals and validation are pending; main is now `c3874c71350631b145abf9934a8b14472a8710eb`, which does not contain this branch. The separate footer operator reports its canonical promotion complete, not deployment of this feature. Managed routing, remaining account controls, hosted/browser work, the full repository gate, PR, merge, release and usage-feature deployment remain incomplete.

- 2026-09-07, automatic reset disable repaired: 13 genuine service/storage failures proved that the existing reset path ignored effective Codex configuration. The repair reads that policy before reset maintenance, again after identity proof, and inside the existing immediate begin transaction before authority evidence or dispatch state. A typed refusal preserves the original key and reports uncertainty separately from suppression. In-flight settlement and authoritative reread remain unchanged. Independent code review approved the bounded repair; no migration, account movement or authentication change is included.

  The new 19-case service/storage suite passed 158 assertions, including second-connection refusal with a complete unchanged database snapshot, both final-begin races, all override combinations, disabled retained states, same-key re-enable and an admitted in-flight result. The broader reset gate `oompa-usage-reset-final` passed 63 tests with 554 assertions across three files in 32.67 seconds. Its first run passed 62 and failed one test that expected a private injected diagnostic; the corrected test requires the existing public `UNAVAILABLE` code and exact sanitized message, without changing production sanitization or no-dispatch assertions. The public/domain/renderer/reader gate passed 124 tests with 3,444 assertions. Final typecheck, code lint, security inventory and installer pins passed. Independent review found nine historical reset-helper tests outside the reset-name filter; the complementary gate included those and three pointer-ownership cases, passing 12 tests with 235 assertions. Staging removed one trailing blank line from the historical-codec test, after which 50 pure codec/reader tests passed 7,268 assertions and staged whitespace passed. This closes only a backend suppression gap; managed dispatch, full CLI/hosted/app integration and repository delivery remain incomplete.

- 2026-09-07, source-selected effect readers verified: the combined historical/runtime/storage gate `oompa-effect-formats-converged` passed 651 tests with 61,547 assertions across 12 files in 310.75 seconds. The new historical codec suite independently pins 32 archived JSON/hash oracles and format membership with 39 tests; the selected reader suite passes 11 tests covering bounded input, strict dispatch, canonical digests, duplicate-key order, normalization and separate mutation/queue envelopes. A test-only equality inference correction retained its assertion and passed the reader's focused rerun and lint. Independent review approved the codecs and reader; these are interpretation helpers, not installed migration provenance or runtime authority.

  Four genuine failures showed `readMutation` returning mismatched stored or parsed evidence kinds. The reader now requires stored kind, parsed kind and parent kind to agree after its existing parse/digest checks. All 20 admission cases passed 43,178 assertions across repeated writable/read-only reopen and recovery, retaining all rows, schema, ledger and the neighboring resolved receipt. Final combined-change typecheck passed after the test-only equality-inference repair. The six-file lint, security inventory, installer pins and whitespace checks passed. Main's later Work/transcript migrations collide with the provisional memory allocation, so physical slots remain unresolved. Managed runtime, remaining CLI/hosted/app work, the repository delivery gate and deployment remain incomplete.

- 2026-09-06, effect-format closure checkpoint verified: `oompa-effect49-converged-final` passed 601 tests with 54,263 assertions across ten files in 302.15 seconds. The final tree's typecheck, seven changed-code-file lint checks, security inventory, installer pins and whitespace passed. Independent reviews approved the versioned dependency graph, unchanged StateStore schema bindings, exact canonical history and admission tests. Thirty preset/runtime initializers independently matched their previous definitions after explicit version renames. The 37 archived-parser JSON/hash preimages cover every mutation kind and three provider queue profiles, including recursively reversed input keys; eight additional cases preserve stable primitive normalization and bounds. This is synthetic parser evidence, not an authentic archived effect capture or native acceptance.

  Twenty real-current-49 database cases passed 43,162 assertions across malformed shapes, new unit fields, wrong digests, kind mismatches, duplicate keys, JSON5 and valid recovery controls. Full-table/schema/ledger snapshots preserve a neighboring resolved receipt across writable/read-only reopen and repeated recovery. Their first run failed only because an unrelated usage allocator was lazy; fixture setup now allocates an unused sequence through the real API and proves no quota observation exists before taking the baseline. Initial typecheck errors were confined to test inference and were corrected without changing expectations. Review rejected parse-set-only collision refusal because raw SQL could still trust malformed JSON; the approved future join now requires immutable per-row format provenance and validated typed/SQL consumers for five distinct historical formats. No migration, current-49 startup-admission change, automatic sender or fallback activation is included. Schema 52, Phase 6, the full repository delivery gate, push, PR, release and deployment remain pending.

- 2026-09-06, historical contract checkpoint verified: `oompa-history49-converged-final` passed 592 tests with 18,139 assertions across 12 files. Final typecheck, all 13 changed-code-file lint checks, security inventory, installer pins and whitespace passed; independent review covers the complete bounded product and test diff. Frozen adoption admission and literal preset contracts preserve current history, and private/public Claude parsing no longer follows a mutable current alias. The first ten-file aggregate passed 562 tests and failed four older upgrade/reopen scenarios because the earlier Work manifest recognized only fresh creation, not the shipped preset-column ALTER layout. Independent canonical-30 inspection identified the single-column placement difference. The repair admits only the two exact table-group digests while retaining all other object and row checks; the four failures and a new full-history upgrade case passed together, five tests with 61 assertions. Work component coverage passed 34 tests with 227 assertions, including refusal of five altered-layout classes in each cohort. Full current-49 nullable-launch integration passed seven tests with 7,344 assertions, including an unproved NULL-key/NULL-marker row rejected without writes. This adds no migration, automatic sender or native fallback acceptance. Schema 52, Phase 6, the full source/repository delivery gate, push, PR, release and deployment remain incomplete.

- 2026-09-06, canonical fixture and pre-owner ingress checkpoint verified: `oompa-fixture-original-ingress-frozen` passed 126 tests with 6,740 assertions across nine files on the converged code. Final typecheck, changed-code lint, the reviewed security-inventory increment and installer pins passed. The unchanged canonical-41/43 captures include complete generator inputs; raw historical inspection passed 1,067 assertions without current-StateStore migration or native-effect claims. Privacy covers all 13 fixtures, recursively checks metadata, and binds canonical-43's two public-root byte spans to its entire image hash. Original-send input can now hold attachment-only bytes before ownership, then transfer the same slot, including at full capacity. Review found and repaired response-loss replay after redundant release; exact released tokens now return only retained history across boot, while unrelated tokens refuse unchanged. The queued diagnostic for that replay finding was cancelled before admission and is not RED evidence. The final aggregate covers the repaired behavior, terminal replay, stale authority, legacy-key conflicts, rollback and existing custody/owner gates. Independent code and fixture review approved this checkpoint. It adds no migration, managed plan, runtime producer, native provider effect, push, release or deployment; the full repository delivery gate and Phase 6 remain incomplete.

- 2026-09-06, frozen-49 checkpoint gate passed: `oompa-combined49-freeze-checkpoint-final` ran the Work and scheduled-task cohort suites, migration bridge, current-StateStore archived-history suite and decoded-fixture privacy suite together: 58 tests passed with 5,274 assertions across five files. Current-StateStore history alone passed three cases with 4,865 assertions after the test harness initialized query-only WAL sidecars before read-only opens. Typecheck, all changed-code lint, security inventory, installer pins and whitespace checks passed; independent review approved the current-49 boundary. Three embedded archived-49 databases retain exact owner, queue, usage, switch and retired-provider history. This checkpoint freezes Work and scheduled-task component admission, not every historical row parser or the shared v38/v39 preset predicates. The full source and repository delivery gates remain pending for the larger feature; no managed runtime producer, push, PR, release or deployment is claimed.

- 2026-09-06, canonical public-provenance regeneration passed in scratch: canonical-41 now captures all tables, explicit UTC, six retained timestamp effects, two marked resolutions, two unmarked no-write refusals and FIFO input. Its database SHA-256 is `ad4842496d9ee5f8d51210ef9a99e255d76e6c42505cc3f6e996c919b2caa106`. Canonical-43 retains queue, peer policy and reserved/prepared/allocating memory states through unchanged archived APIs using one explicitly public synthetic project-path input, not a machine-derived scratch path; its database SHA-256 is `046f5ede0c377a0db943206e09b6dfbee5e8aa0a55d90e06f98e0faf6f9ffeb5`. Both preserve every captured row and schema object across archived writable/read-only reopen, with read-only byte identity, complete source provenance and no quota observation from unused sequence reservations. Original captures remain untouched. Repository inclusion and later-schema migration proof are still pending, and neither fixture proves a provider or physical memory effect.

- 2026-09-06, historical recognition preparation: the adoption-49 merge was committed as `0ae317793d5ff694b4d333effe25f85f7e7f1491`. Independent review found that historical scheduled-task exports aliased a current-DDL assertion and combined-49 Work preflight followed current authority guards. The replacement uses frozen object names and fingerprints, exact foreign keys and STRICT tables; combined-49 Work retains preset-contract 2 without importing a future live contract. Authentic canonical-40, private-48 and combined-49 component suites passed 16 Work cases with 53 assertions and 21 scheduled-task cases with 63 assertions. The migration bridge suite passed seven cases with 95 assertions. Three new archived-49 fixtures preserve all rows across archived writable/read-only reopen: retained owner, attachment pins, sealed queue, independent Claude generation and exact usage; a prepared exact switch; and retired-provider owner, login and unconsumed joined-close history. Each decoded database is 2,576,384 bytes, with complete generator source and captured hashes. Public import checks found no host-path prefixes in metadata or decoded bytes. Unused profile usage sequence reservations are not quota observations. The switch pins a warning-only event range and header-only seed. The retired joined-close witness is synthetic and does not prove native custody. The later checkpoint entry records the completed current-StateStore integration, typecheck and lint gates. Independent review approved the current-49 component integration but identified shared v38/v39 preset predicates that still need freezing before future preset changes; this is not a complete historical recognizer freeze. The original canonical-41/43 scratch captures needed fresh public-provenance generation before repository inclusion; the later regeneration entry records that proof without altering the old captures.

- 2026-09-06, commit-ready adoption-49 verification passed: staging exposed trailing blank lines in five fixture modules; only those lines were removed, with embedded database bytes and generator strings unchanged. The fresh exact-file source gate, `oompa-adoption49-source-staged-final`, passed all 3,648 tests with 135,698 assertions across 149 files. Final typecheck, changed-fixture lint and staged whitespace checks passed. All 127 reviewed paths are staged with no unresolved index entries, unstaged changes or extra files. The retirement composition amendment independently passed review, including refusal of new joined-close recording as well as capture and consumption. This is the local checkpoint gate, not completion of the later canonical join, managed producer or repository delivery gate.

- 2026-09-06, adoption-49 source checkpoint accepted: `bun test ./src --isolate --max-concurrency=1 --only-failures`, under `oompa-adoption49-source-cleanup-final`, passed all 3,648 tests with 135,651 assertions across 149 files. Final typecheck, full and changed-file lint, security inventory, installer pins and independent ownership and behavior reviews passed. The explicit 127-path working-file inventory has no conflict markers or unrelated artifacts; the old merge index must be replaced by these reviewed files before committing. New impact review also approved the next join's full-tuple host-tool authority and sealed peer-queue requirements. Authentic canonical-41/43 fixtures remain in separate scratch work and are not part of this checkpoint. Phase 6, the full `bun run check` delivery gate, later UI/contracts and delivery remain incomplete; no automatic producer or native fallback is enabled by this checkpoint.

- 2026-09-06, final cleanup regression gate passed: six genuine failures exposed unjoined exit-watcher callbacks, unbounded staged/close-owned callbacks, and lost terminal facts after callback rejection. Cleanup now separately requires successful process exit, bounds the independent watcher and retained fact-drain tasks, and retries the same task without losing or duplicating facts. The drain preserves the first rejection while attempting all remaining terminal facts once. Independent review approved the repair. The complete affected client, cleanup, adapter and service suite passed 118 tests with 680 assertions. The readonly migration helper separately passed its 65-assertion bridge and lint. Final typecheck and owned lint passed; the full source integration gate is running on the frozen product/test tree. The repository delivery gate and later phases remain pending.

- 2026-09-06, additional Claude cleanup review: two deterministic exit-before-EOF regressions proved that close could report joined custody while the independent process-exit watcher still awaited a terminal observer. Both failed before repair with two assertions. The client now includes that watcher in its bounded parallel shutdown join, while retaining the separate successful process-exit requirement and exact retry. Independent review approved the change; full client validation is queued. The not-yet-admitted full source run was cancelled by its owner because this finding reopened convergence. The deeply readonly migration expectations now use an exact-equality helper without parsing or normalizing captured data; independent review approved it and focused bridge/lint checks are pending. No source integration success is claimed.

- 2026-09-06, adoption-49 convergence: full StateStore testing completed with 425 passing tests and two stale fixture assertions across 427 tests, with 4,538 assertions. Both corrected identity cases passed focused checks. They now distinguish historical account visibility from full-tuple dispatch authority and retain exact no-write refusal evidence. The authentic private-48 usage bridge passed 65 assertions and independent provenance review: all four authority scopes, payload bytes, digests and original ledger times survive migration and reopen, while canonical-40 usage remains display-only. Full lint passed. Security inventory passed for all 46 files after review of the two added authority checks; installer pins passed. Final typecheck exposed only deeply readonly captured-fixture comparisons; their runtime equality assertions are unchanged, and typecheck is being repeated. A fresh full source integration run is queued on the frozen product and test tree. Canonical timestamp 41 and memory 42/43 remain unjoined. The coordinated forward release is 0.7; the immutable 0.6 publication is not being retried. No checkpoint commit, PR or deployment is claimed.

- 2026-09-06, recovery and callback regressions repaired: logout now commits the captured buffered delta, disconnect and restart-gap events inside the account-effect transaction. The new late-insert rollback test passed with 24 assertions, and the unchanged ambiguous-logout restart case passed with 24. Restart attention preserves a retired account binding without inventing a current event authority; its two-provider cases and the separate projection-boundary case passed three tests with 32 assertions. Exact provider-switch rebind now reads the returned row instead of counting trigger-side writes; both affected cases passed with 35 assertions. Malformed switch containment recognizes every independent action anchor before deciding an attempt is cancellable; the expanded leaf suite passed 36 tests with 342 assertions. These fixes preserve immutable evidence and do not enable automatic dispatch.
- 2026-09-06, Claude callback ordering evidence: bounded accounting admission now publishes behind the durable timeline without awaiting a provider-owned lock from the reader. Cleanup can identify an exact retained failed child without admitting new work. Bounded first-write staging preserves actual immediate results and does not report a synthetic start after write rejection. Independent review reproduced four callback-local cleanup self-joins. Those calls now fail explicitly without changing custody; a separate cleanup owner still joins the exact child and every retained fact. The latch precedes observer entry, and inherited callback context stops blocking cleanup once that callback returns. The complete affected client, adapter and service suite passed 112 tests with 618 assertions, including failed-result history, no same-key replay and ordinary external cleanup. Independent review, scoped lint and diff checks passed. This is focused acceptance, not the repository integration gate.
- 2026-09-06, exact account recovery accepted: one observation-only reader validates the unique unresolved Codex account owner across all generations before checking its immutable request, effect evidence, authority roles and provenance. Login cancellation additionally proves its original pending-login receipt and original login's successor chain. Settlement revalidates the fresh full provider tuple inside its transaction. Four additional genuine failures proved a second cancellation escaping after restart, two authority changes during the pre-read cloud await, and an uncompleted login being mistaken for unsolicited sign-out. The repaired 16-case account suite passed with 151 assertions; independent review and scoped lint passed. Missing proof, extra binding changes and competing owners remain unresolved without writes. A qualified cancellation read adds no cancellation-success receipt; only subsequent explicit input can request a distinct cancellation. No schema or automatic provider action changes are included.
- 2026-09-06, historical and current-schema verification: authentic canonical-24 signed-in state now migrates through 49 and two real daemon boots without an invented reset baseline; its focused test passed with 12 assertions. The v38 evidence migration and actual current-49 reopen passed with 42 assertions, retaining historical bytes and quarantining unproved execution authority. Four direct SQL revocation states passed, including completed accountless custody after a sibling-provider rollover. Four current usage-corruption cases passed unchanged with 27 assertions. The canonical-40 usage and canonical-30 Work fixtures now come from exact archived API producers, and both focused migration cases pass. The final Work case passed with 19 assertions after replacing a stale cached inspector statement, not changing product data. Independent artifact review and artifact lint passed. Full typecheck passed; full lint found one obsolete synthetic-downgrade helper, now removed. Full StateStore testing is running, and a separate private-48 usage-authority bridge test is being added. The converged source gate and full repository gate remain pending. Canonical timestamp 41 and memory 42/43 have a separately reported checkpoint but are not joined here. No merge commit, push, PR, release or deployment is claimed.

- 2026-09-06, combined source gate exposed remaining integration defects: `bun test ./src --isolate --max-concurrency=1 --only-failures`, under `oompa-adoption49-source-integration`, completed with 3,372 passing tests, 206 failures and two errors across 148 files. This is diagnostic failure evidence, not an accepted checkpoint. Regressions proved missing fresh-database dependencies under newer SQLite, three Claude approval checks comparing the sibling Codex counter, incorrect launch-intent conflict classification, and a scoped Claude revocation bypass when provider counters differ. The startup, launch-conflict and two approval cases passed four tests with 34 assertions after their bounded repairs. The revocation fix also preserves completed accountless fences across a later Codex rollover; its typed and additive SQL mirrors are under focused review. A separate real regression still requires accounting to follow deferred durable turn completion without blocking the provider reader. Independent switch-journal containment review is also in progress. No combined source, final typecheck, repository gate or delivery success is claimed.
- 2026-09-06, authentic fixture repair: archived canonical `6f056dc` produced a checked database containing pending and terminal queues, prepared send/steer requests, a legacy mutation receipt and a Devin session through its real APIs. The database SHA-256 is `975ca1aed2f3dee396ba5848c0088ba8c67f7fd73acd3a943b589a5e9514177b`; its checked generator and bytes replace fabricated intermediate-version fixtures. The hash identifies this captured output; regenerating through the historical random-ID APIs produces the same cohort and scenarios, not identical database bytes. The queue and reservation join passed 60 of 61 cases, and the corrected historical FIFO case passed with 14 assertions. That case now proves retained pending input, no dispatch from missing immutable authority, and explicit abandonment before scrubbing. Attachment-integrity and pointer tests passed all 59 cases with 296 assertions; scoped lint passed. Six Work lifecycle cases now run separately within their original per-case timeout. Current-schema corruption fixtures preserve installed guards when testing row corruption and assert unchanged schema, migration ledger and rows when admission must refuse. A further root fixture slice passed 16 of 19 cases; the remaining historical-state and audit-order expectations are being checked individually. Phase 6 and the adoption integration remain incomplete.

- 2026-09-06, fact-drain and schema-admission hardening: a real deferred persistence failure showed that ordered facts could queue behind the switch's own held locks and report success before persistence. The private drain path now applies facts under the original held authority, snapshots routing before awaits, rechecks interaction-lock contention and limits translated account-wide Claude facts to the captured session. Independent review approved the repair; all seven adversarial cases passed in the full switch integration run, including sibling sessions sharing a connection and caller mutation during a real cloud await. That run passed 95 of 96 cases with 833 assertions. Its sole failure came from an optional memory port injected into a historical abandonment fixture that originally omitted it; repair must preserve the no-memory positive and separately prove refusal when actual memory ownership is ambiguous. Legacy switch recovery and idle Claude release now use the full independent provider tuple; scoped interaction expiry retains sibling rows. Intermediate typecheck passed under `oompa-adoption-types-schema-hardening`.
- 2026-09-06, exact SQL audit in progress: real altered GLOB constraints reproduced a collision in regex-based schema normalization. The shared lexical comparator preserves quoted values, identifiers and comments, normalizes only exterior layout and rejects malformed spans. StateStore now uses it without prior regex stripping. A separate read-only gap required checking the frozen provider-account object set and migration ledger before admission. All three admission cases passed with 15 assertions and unchanged retained evidence; independent review approved the bounded repair. The authentic historical Work table hashes did not change; only the two whole-object hashes changed because the reviewed route guard contains line comments whose newlines must be retained. Work/Task focused checks passed seven tests with 31 assertions; parser examples and seeded properties passed 19 with 402. Four leaf auditors passed ten cases with 58 assertions after a real quoted-column decoy required the queue's exact owned-column tail. Claude marker and two host-column checks, authentic bridge revalidation and the combined source gate remain pending. No migration definition, historical evidence or schema version is rewritten by this hardening, and no delivery result is claimed.

- 2026-09-06, adoption boundary repairs: a new regression proved that an exact personal Claude source was incorrectly rejected when its separate managed home remained unverified. Source-only admission now retains the exact active binding, process identity, full provider tuple and fresh service identity proofs without authenticating the managed home. Managed sources, signed-out sources and every target remain fenced. The complete capsule suite passed 14 tests with 109 assertions, including substituted process identity, missing custody, stale personal bindings and Claude revocation across a sibling Codex generation change. Independent review approved shutdown joins, fact authority and one-shot switch handling. The populated private-48 attachment bridge and Claude process suite passed 12 tests with 58 assertions; rebind passed two with 18. Work/Task scoped revocation passed two with 16, and historical Work table-cohort checks passed four with 18 after a constraint-stripped table reproduced the old recognizer gap. Cloud adapters passed 91 tests with 748 assertions. Storage and root-owned lint passed; generated security inventory and installer checks passed. The earlier fact-delivery investigation was a buffered text fixture, not proof of a dropped event; the terminal-flushed case passed with 17 assertions. A later typecheck caught only unfinished CLI fixture edits. Full switch and service integration, timestamp-unit recovery and the source gate remain pending. No merge commit, push, PR or delivery result is claimed.

- 2026-09-06, adoption integration checks: the combined `bun x tsc --noEmit` passed under `oompa-adoption-join-types-5`; scoped daemon and switch-adoption lint passed under `oompa-adoption-root-lint-2`. Independent review approved the switch-adoption leaf after ten tests with 72 assertions, including raw personal-binding deletion refusal and independent Claude generation checks. The explicit Codex-login and observed-signout slice passed two tests with 21 assertions, preserving the exact sibling Claude process and session tuple; a subsequent fact-delivery regression is still under investigation. The released generation-zero Claude restart case now passes, while wrong-scope proof, authentic cohort migration/recovery and dedicated rebind checks remain in progress. Historical database fixtures are moving into the repository-only scripts area so they are not shipped. These are focused integration results, not the source or repository delivery gate; the adoption merge and later feature phases remain incomplete.

- 2026-09-06, adoption join remains in progress: canonical adoption 40 and the exact private 48 checkpoint are being composed into 49 without reinterpreting either frozen cohort. Other unpublished intermediate cohorts remain unsupported and must fail before mutation. Exact provider tuples now accompany personal-home callbacks, process claims, scoped account reads and switch preparation; the canonical shared profile counter remains separate metadata. Review found and is repairing sibling Codex revocation of Claude custody, personal commands selecting a managed runtime, and shutdown treating unrelated historical processes as joined children. Switch capsules preserve source home, account identity, personal-binding revision and exact Claude process proof, plus the target account identity. New raw-SQL shape and inverse rebind guards passed eight focused cases with 63 assertions under `oompa-switch-adoption-inverse`. The second type check still reported fixture repairs and one subsequently repaired production import field; no passing integration type check is claimed. Authentic canonical-40/private-48 migration fixtures, released-Claude restart successors, independent review and the converged source gate remain pending. Timestamp-unit recovery, the managed producer and later CLI/cloud/browser phases remain separate unfinished work. No merge, push, PR or delivery gate is claimed.
- 2026-09-06, custody checkpoint accepted: final typecheck passed after scheduler admission, completing the frozen source gate, focused regression and owned-lint evidence above. Independent review approved storage, runtime, replay races, historical fixtures and the exact two security-inventory count changes. Schema 48 now protects send, steer and queue input before blob reads, transfers custody atomically, retains unresolved input across boot and performs fully rechecked synchronous cleanup. The next integration preserves canonical adoption 40 and shifts this unpublished sequence as specified above. Phase 6 remains incomplete; no managed producer, push, PR, release, deployment or full `bun run check` delivery result is claimed.
- 2026-09-06, repaired custody source gate passed: `bun test ./src --isolate --max-concurrency=1 --only-failures`, under `oompa-custody48-source-repaired-final`, passed all 3,120 tests with 130,713 assertions across 137 files. The output filter changes reporting only. Final typecheck is still queued behind other admitted host work; no source edits followed this gate. The checkpoint commit, canonical adoption/removal join, managed journal and full repository delivery gate remain pending.
- 2026-09-06, custody fixture convergence: independent review approved storage and runtime custody, including completed and raced replay with no duplicate post-send work. The first source integration run finished with 3,110 passing cases and ten failures, all in historical or intentional-corruption fixtures. Exact guard teardown/restoration repaired those fixtures without changing production admission or weakening assertions. The final historical slice passed six cases with 58 assertions, pointer boundaries passed ten with 76, and Work corruption passed one with 35; their scoped lint and the reviewed security inventory check passed. A fresh full source gate and final typecheck are running. Read-only adoption impact review added the prerequisite above; no upstream join or managed producer is claimed.
- 2026-09-06, custody integration remains in progress: the expanded input and filesystem suite passed 49 tests with 316 assertions; historical CLI and service upgrade fixtures now target schema 48. Real service regressions reproduce deletion before the first attachment read for send, steer and queue, stale-snapshot deletion, and a non-atomic manifest/effect begin. Independent review requires closing raw SQL begin, queue-transfer and terminal-release paths before the consumer join. Exact query plans also exposed three historical scans in parent-custody and namespace lookup; their indexed repairs are part of this gate. Runtime reservations, the final source gate and automatic actions are not yet accepted. The managed plan now explicitly requires joint original-owner cancellation, separately current reset proof and a versioned claim-admission migration preserving direct-v1 semantics.

- 2026-09-06, attachment custody implementation in progress: the canonical-main join is committed as `319b7b7`. Real service regressions now reproduce both stale accounted/unaccounted cleanup snapshots deleting a second writer's referenced bytes (two failures, eight assertions) and non-atomic send/steer begin leaving `effect_started` after manifest failure without provider dispatch (two failures, four assertions). These are genuine pre-fix failures, not missing-API failures. Service fixtures now use explicit persisted daemon boots: 274 existing cases passed, and the sole stale hard-coded generation assertion was repaired with its focused 24-assertion gate. Four new attachment cases remain intentionally red pending production wiring. Migration 48's leaf schema and 14 independent filesystem/storage tests are being implemented; no storage or runtime completion is claimed.
- 2026-09-06, canonical autorespond integration gate passed: merged `5f27351` without a schema change. Independent review approved fail-closed workspace approval and file-change policy, exact provider authority on interaction tracking, and restart attention repair after provider-specific disposition. Genuine migration regressions exposed missing authority in quarantined sessions and callbacks; restart now preserves those rows and their recovery evidence without fabricated events. Focused storage passed 11 tests with 92 assertions, service/autorespond/Devin passed 19 with 290, protocol passed 36 with 543, switch restart boundaries passed four with 45, and the pure/domain/client/site join passed 135 with 1,385. Final `bun test ./src --isolate --max-concurrency=1`, under `oompa-autorespond117-source-final`, passed 3,029 tests with 130,260 assertions across 134 files. Final typecheck, scoped lint and diff checks passed. The reviewed reservation/pin contract now includes bounded historical cleanup projections and explicit refusal to upgrade unproved prepared retries. Migration 48 and production attachment reservations remain unimplemented at this checkpoint; Phase 6 and full delivery remain incomplete.
- 2026-09-06, queue identity integration gate passed: migration 47 and all queue producers have independent review. Scheduled-task materialization now uses the same sealed writer; a genuine service regression failed before the fix and passed afterward with ten assertions. The leaf task suite passed 27 tests with 185 assertions; the final core/boundary queue join passed 38 with 619. Source integration first found two stale fixtures: an incomplete v45 downgrade and queue setup that bypassed an already-unsettled mutation. Both were corrected without changing production guards, with focused gates and review. The repaired `bun test ./src --isolate --max-concurrency=1`, under `oompa-queue47-source-final`, passed 3,004 tests with 130,017 assertions across 134 files. Final typecheck, scoped lint and diff checks passed. The separately reviewed reservation/pin contract is recorded above but not implemented. Canonical main advanced to `5f27351` (autorespond authority hardening); it adds no migration and is the next integration prerequisite. Phase 6 and the full repository delivery gate remain incomplete.
- 2026-09-06, attachment queue focused proof: independent boundary tests passed 18 cases with 536 assertions, and the unchanged Work integration suites passed 77 tests with 1,097 assertions. Service replay, conflict and rollback tests plus the old migration fixture passed eight tests with 40 assertions; explicit legacy-queue quarantine and whole-session abandonment passed with 13 assertions. Independent review approved the queue core. Source integration remains pending while scheduled-task materialization is moved onto the same atomic sealed writer. Filesystem reservations and cleanup exclusion are still a subsequent custody gate.
- 2026-09-06, attachment queue repair started: pointer-ledger checkpoint is committed as `4fb1055`. Canonical main's hosted-evidence hardening was joined in `db03060`; its two affected script suites passed 45 tests with 819 assertions. Independent queue review found missing attachment identity, separate admission transactions and pruning of unresolved queue manifests. Root service regressions reproduced six failures, and independent storage regressions reproduced three, before production repair.
- 2026-09-06, pointer-ledger integration gate passed: migration 46 settles only a DB-derived reset-not-eligible pointer move, with exact source/quota/daemon/configuration/order/reset fences and independently anchored immutable history. Source and selected-target authentication or unresolved resets block admission. Historical replay survives usage pruning and mutable authority changes; manual pointer gaps remain explicit. Pure capsule tests passed 15 cases with 274 assertions, core storage passed 32 with 163, independent boundaries passed 10 with 69, and affected existing migration fixtures passed 61 with 432. The source integration gate `bun test ./src --isolate --max-concurrency=1` under `oompa-pointer46-source-integration` passed 2,950 tests with 129,413 assertions across 132 files. Final typecheck, owned lint and diff checks passed. Review also corrected the SQL NULL receipt comparison and clarified mode-specific cursor catch-up. Attachment queue identity, retention and atomic admission are the next repairs; the managed journal, runtime producer and repository final delivery gate remain pending.
- 2026-09-06, adversarial integration review: exact foreground login grants now block provider-process retirement atomically in storage, including daemon restart, while historical terminal grants and sibling providers remain independent. The complete storage suite passed 278 tests with 2,957 assertions; the service corruption/restart slice passed 15 tests with 91 assertions. Queued Work signals now carry independent immutable provider authority without changing released v1 instruction bytes; 56 tests with 837 assertions and independent review passed. Current-version reopen audits run before schema repair and reject missing or altered custody rather than inventing it. Full typecheck passed. Four stale migration/callback fixtures were repaired and passed; the complete integration source gate remains pending.
- 2026-09-06, remaining integration boundary: migrated Devin generation-zero sessions retain their historical identity, but continuing them after process retirement still requires a proved durable successor/adoption path. Do not admit generation zero to new provider effects, rewrite captured session authority, or claim released load/recovery compatibility complete until that path is integrated and tested. Automatic runtime wiring remains behind this convergence gate.
- 2026-09-06, startup and CLI review: Devin permission callbacks remain buffered until the exact native session has a durable Oompa binding and an explicit activation, with bounded ordered draining. A reproduced final-await race required a second permission check immediately before native prompt dispatch. Claude's legitimate unverified authentication status now produces actionable unavailability rather than an internal CLI error, without preparing or launching login; its six-case focused gate passed with 38 assertions. These repairs do not enable native fallback, automatic movement or reset consumption.
- 2026-09-06, integration repair in progress: the full source suite exposed three merge regressions (2,753 passing tests, three failures). Work switch preflight is restored before and after runtime review, with its exact SQLite race guard mapped to a bounded conflict; focused validation passed three tests with 22 assertions. Foreground login admission now precedes initial process-generation advancement; its repaired focused slice passed 16 tests with 87 assertions. New Devin restart tests reproduced both lost joined-close continuation and misleading unavailable state after an unproved restart. Migration 44, a private native-writer witness port and explicit daemon boot identity are being integrated; neither that repair nor the aggregate gate is complete yet.
- 2026-09-06, joined-close focused proof: seven service regressions passed with 194 assertions, including genuine loaded-writer renewal, refusal to renew from an empty manager, failed joins and cleanup despite capture failure. The full native adapter suite passed 66 tests with 306 assertions and independent review. CLI schema-44 upgrade/newer-version refusal passed five tests with 26 assertions; the older service migration fixture passed with nine assertions. Typecheck, owned lint and regenerated installer pins passed. Storage integrity review is still closing hot-read and alternate-transition proof bypasses; final storage and source integration gates remain pending.
- 2026-09-06, upstream integration convergence: independent review approved migration 44 after closing alternate-label proof bypasses, hot proof/head corruption, stale pending queues, and the unchanged-generation foreground-login edge. Focused storage passed 29 tests with 173 assertions; full storage passed 308 tests with 3,142 assertions. Historical upgrade fixtures were corrected without weakening production admission. The final source integration command `bun test ./src --isolate --max-concurrency=1`, through the heavy compute scheduler, passed 2,810 tests with 127,761 assertions across 125 files. Final typecheck, owned lint and diff checks passed. The only preceding source-run failure was a stale Darwin fixture; it now proves rejected probes leave the generation unchanged before arranging distinct provider generations explicitly. Main remains at the exact reviewed merge parent. This is an upstream integration checkpoint, not completion of Phase 6 or the repository's final `bun run check` delivery gate.
- 2026-09-06, original-send foundation in progress: the upstream checkpoint is committed as `f5db708`. Three bounded owners are implementing request fingerprints, migration-45 ownership and one-shot dispatch guards, and Work nested-key protections. Independent review tightened settlement to an anchored bounded outcome chain and separated historical acceptance from current-session projection. New storage APIs have no production caller yet; their focused and integration gates remain pending.
- 2026-09-06, original-send focused evidence: the pure fingerprint suite passed 15 tests with 729 assertions and independent review. Work's full suite passed 62 tests with 965 assertions after reproducing and repairing both cached-receipt acceptance and a redirected nested-key check; root independently approved the final Work diff. Eight cross-boundary storage tests passed with 59 assertions after repairing identical ambiguous-settlement replay. They cover both cross-connection claim/cancellation orderings, original-selector rename, unclaimed restart and late acceptance after process retirement without mutable projection changes. CLI schema-45 upgrade and newer-version refusal plus the legacy service fixture passed six tests with 35 assertions. Owned lint passed. Storage admission, generic-path and corruption matrices are still converging; aggregate validation and production wiring remain pending.
- 2026-09-06, original-send foundation gate passed: independent storage review approved the immutable owner, one-shot claim, anchored outcomes, historical replay, generic-path fences and restart behavior after three regressions closed detached same-session ownership, missing or replaced foreground-login authority, and missing pending-permission authority. All 22 ownership cases passed; the independent generic guard suite passed nine tests with 79 assertions. Fourteen stale historical migration fixtures were repaired without changing production admission. Service diagnostics preserve an owned ambiguous send as a blocker and refuse generic recovery before provider IO. The converged source integration command `bun test ./src --isolate --max-concurrency=1`, through `oompa-owner45-source-integration`, passed 2,871 tests with 128,832 assertions across 128 files. Final typecheck, owned lint and diff checks passed. This completes only the original-request storage slice; no production producer or claimed no-effect API exists, and the full repository delivery gate remains pending.
- 2026-09-06, next-slice review: selected a separate physical managed-action journal under the original send owner to preserve manual switch receipt semantics. Durable pointer evidence must precede journal admission; observation-triggered evaluation remains later. The attachment review requires one closed per-file transaction for reference checks and synchronous deletion, explicit conservative recovery after an irreversible unlink, and pin-then-reprove admission. Canonical main was checked at `d5af421`: its new hosted candidate-evidence hardening does not change schema 39 and remains to be joined before final delivery. Task migration 45 is still unpublished.
- 2026-09-06, attachment primitive checkpoint: original-send foundation is committed as `5dacbae`. Bounded candidate enumeration and synchronous no-follow cleanup primitives now have independent review and 29 passing tests with 88 assertions; scoped lint and diff checks passed. Real filesystem tests cover age changes after enumeration, permissions, symlinks, hard links, exact filenames and missing custody. Review reproduced a macOS case-alias deletion through both the new primitive and the existing unaccounted sweep; both now refuse noncanonical case aliases, with retained-byte regression evidence. The only existing production behavior changed here is that conservative legacy sweep safeguard. The new transaction port remains unwired; reference/pin exclusion, post-unlink accounting recovery and full attachment custody remain incomplete.
- 2026-09-06, pointer ledger in progress: the pure decision capsule passed 15 tests with 274 assertions and independent review. Migration 46 and its database-only admission, global key reservation, atomic pointer receipt and manual-gap lineage reader are being implemented. Independent review is checking current-head inverse evidence and exact canonical digest joins; root review additionally requires source/selected-target foreground-auth and unresolved-reset exclusion. No observation callback or provider operation invokes this ledger yet.

- 2026-09-05, Devin integration review in progress: canonical main `27d4722` is joined without rewriting released migrations. General authority now has distinct Devin bindings while usage policy remains closed to Codex and Claude. Adapter regressions reproduced stale authority and cancellation crossing initialization or prompt dispatch; repaired adapter suites passed 73 tests with 284 assertions. Cloud adapter, journal and bridge suites passed 266 tests with 2,512 assertions; pure payload and projection suites passed 60 tests with 391 assertions. Review also reproduced foreground completion reading replaced or malformed login authority; the service and transactional repair is under validation. Full source integration and final delivery gates remain pending.
- 2026-09-05, Phase 5 gate passed: the repaired pure policy and usage-metrics suite passed 57 tests with 1,083 assertions. Independent domain review approved expired-Claude evidence, provider-owned reset inputs, cross-provider rejection and chronological process fences. Storage passed all 264 tests with 2,812 assertions, including 33 configuration cases, through `phase5-storage-complete`. Independent review found and reproduced receipt-key relocation; the immutable original key repaired it. Final typecheck, storage/domain and changed-fixture lint, six CLI/service migration fixtures (35 assertions), the narrowed configuration-schema fixture (126 assertions), and diff checks passed. No reset, pointer or provider runtime effect is wired by this phase.
- 2026-09-05, Phase 6 pure renderer gate passed: the renderer, transcript and attachment suite passed 42 tests with 703 assertions; type-aware lint passed. Independent integration review tightened the complete provider-text bound to 512 KiB after tracing the outgoing JSON frame limit. Maximum multibyte human input, attachment-only input, ordered manifests, BOM decoding, dynamic fences, minimum overflow, exact expanded digests and unchanged manual-v1 bytes are covered. This slice has no provider or storage effects; Phase 6 remains incomplete.
- 2026-09-05, next upstream convergence identified: main `27d4722` adds Devin and canonical schema-39 `provider_v39`, while adoption has reported ownership of the next migration. Current task-only migration numbers 39–42 are unpublished and must move after the canonical upstream migrations before delivery. General execution authority must admit independent Devin bindings without treating the legacy Codex shadow as identity. Usage configuration, account-quota policy and automatic following remain explicitly limited to Codex and Claude; Devin's supplied context and cost remain informational. Revalidate session, login, interaction, Work, switch and cloud authority after the join before automatic runtime implementation.
- 2026-09-05, upstream integration gate passed: all 2,525 source tests passed with 124,928 assertions through `oompa-upstream-reviewed-src-final` and unchanged child command `bun test ./src --isolate --max-concurrency=1`. Full typecheck passed; full lint and the final changed-file lint passed. Independent review approved exact Claude login authority, provider/thread interaction guards, Codex login successor custody, and dedicated preset/auth contracts. A late regression proved and repaired skipped generic switch evidence and removed-target authority lookup; its focused gate passed 7 tests with 82 assertions. Installer convergence regenerated only the three prescribed checksum lines and its 50-test gate passed. This closes upstream integration for Phase 4; Phase 5 still needs configuration and the reviewed Claude-expiry, reset-input and monotonic-lineage corrections.
- 2026-09-05, Phase 6 planning review approved: independent review rejected composing a manual switch and ordinary send, and required a single versioned action owner, preserved managed cursor lineage, caller-restored exact input, retained attachment custody, byte-budgeted framing, trusted local-human entry and unchanged original-key reset reconciliation. The amended storage/runtime join contract closes those design gaps. No automatic runtime action is implemented yet.
- 2026-09-05, integration repairs in progress: preserved released migrations 35–38 and added provider migrations 39–41. Dedicated switch plans now freeze source and target preset contracts in their immutable digest and transactional rebind. Unified Claude readiness with the released strict status parser; new starts and targets require signed-in proof, while native fallback remains unavailable. Pending Codex login keeps an immutable origin and append-only exact-binding process-successor chain. Claude login and interaction retirement no longer inherit a sibling Codex counter. Graceful shutdown and daemon restart preserve legacy switch ownership for explicit recovery instead of abandoning an independently recoverable target. The legacy recovery slice passed 10 tests with 96 assertions; broader integration, independent review, and final gates remain pending.
- 2026-09-05, Phase 4 gate passed: the repaired aggregate under scheduler label `oompa-phase4-provider-switch-final` passed 542 tests with 5,684 assertions and no failures. Independent recovery review approved the repaired boundary. Final typecheck, targeted lint, and diff checks passed. This closes Phase 4 on its original task base; upstream schema/login/preset integration remains a separate mandatory revalidation before Phase 6.
- 2026-09-05, integration prerequisite: upstream now includes released schema versions 35–38, secure foreground Claude login, and durable legacy/current preset contracts. Preserve those released migrations and historical switch recovery; renumber this unpublished work to provider accounts 39, observations 40, and dedicated switching 41 before further storage implementation. Automatic configuration follows as 42. Integration must preserve independent provider generations, foreground login custody, legacy Sol continuation, current Astra selection, and notification opt-in state. These are required integration regressions, not completed evidence.
- 2026-09-05, Phase 4 recovery review: four red regressions proved source/target generation fence bypass, unrelated-session fencing from corrupt journal identity, and later recovery blocked by safely cancelled history. The shared admission projection and immutable source-thread anchor repaired these; the expanded recovery slice passed 9 tests with 128 assertions. Task materialization passed 11 tests with 72 assertions and the post-rebind failure-injection case passed 1 test with 12 assertions. The prior aggregate was 526 passing and 11 failing; its repaired aggregate remains pending. Typecheck and storage/domain lint passed.
- 2026-09-05, Phase 5 pure domain: configuration resolution, quota classification, reset-gated pointer proposals, and branded settled-lineage following are implemented without provider effects or storage configuration. Independent review caught an informational Claude readiness mismatch; exact unverified Claude turn observations now remain observe-only while Codex candidates still require signed-in authority. The repaired domain slice passed 49 tests with 608 assertions. A settled reset gate requires a later quota revision received after settlement. Phase 5 is not complete until its durable configuration and integration gates pass.
- 2026-09-05, dependency correction: the Phase 5 pure selector has no dependency on switch implementation or provider IO, so domain-only work may proceed alongside Phase 4. Its storage configuration remains serialized behind Phase 4, and Phase 6 now explicitly joins both phases before any automatic action is implemented.
- 2026-09-05, Phase 4 reassessment: independent rejection review found an accepted-seed event admission failure, missing independent anchors for source-release/no-effect/reconciliation evidence, and terminal corruption omitted from reopen validation. These remain Phase 4 blockers until the repaired full suite passes. The seed repair uses the existing immutable event digest and atomic settlement, avoiding a second plaintext custody table. Phase 5 and Phase 7 acceptance criteria now explicitly distinguish pointer proposals from durable moves, bind reset eligibility to exact evidence, and resolve omitted-selector replay before mutable defaults.
- 2026-09-04, plan approval and Phase 1 start: the supplied plan was rejected after three independent read-only audits. The corrected plan was iterated through a separate rejection-oriented review and approved with no remaining blocker. No product behavior has changed yet. Phase 1 now owns contract convergence and the exact pinned Claude fallback gate.
- 2026-09-04, Phase 1 done, commit `3b8adca`: governing contracts now admit only future managed Codex movement under fresh crash-safe authority and retain the bans on explicit-route movement, Claude rotation, and speculative replay. Claude runtime data defines the exact Fable-to-Opus max-effort native fallback, but production remains `unavailable: live_acceptance_required` because no signed-in isolated Oompa Claude profile exists. Focused phase validation passed 183 tests with 1,842 assertions; targeted daemon/runtime validation passed 22 tests; typecheck, targeted lint, and diff checks passed. Independent review found and fixed one fail-closed defect so runtime profiles and argv construction now require the exact pinned fallback model and reviewed reason; the invalidated slice passed 14 tests with 43 assertions. Remaining risk is explicit and non-operative: authenticated Opus/fallback acceptance has not been proved.
- 2026-09-04, Phase 2 start: a read-only migration inventory mapped providerless profile, session, interaction, queue, remote, and runtime authorities. The phase will use additive sidecars and schema version 35, preserve immutable legacy records, derive legacy session-scoped provider identity only from historical runtime/effect authority, and quarantine unprovable unsettled rows.
- 2026-09-04, Phase 2 Claude signed-out evidence: an exact `2.1.260` credential-free probe in a fresh mode-0700 isolated configuration exited `1` with sorted keys `[analyticsDisabled, apiProvider, authMethod, loggedIn, projectsDirectory]` and respective types boolean/string/string/boolean/string. Only `loggedIn=false`, `authMethod=none`, `apiProvider=firstParty`, a boolean analytics flag, and a bounded discarded projects-directory string are admitted. Exit `0` remains `unverified`; no raw payload, path, credential, or identity was retained.
- 2026-09-05, Phase 2 done: the initial integration gate exposed two authority-retirement failures. The repair makes logout and quarantine atomically retire the old exact provider-account authority before advancing the binding, without weakening any transition trigger. The repaired focused service slice passed `3 pass/0 fail`, the repaired focused storage slice passed `3 pass/0 fail`, and typecheck and diff checks passed. Root integration ran `oompa-host-run --mode=heavy --lane=compute --label=oompa-phase2-provider-authority -- bun test ./src/storage/state-store.test.ts ./src/daemon/claude-runtime-adapter.test.ts ./src/daemon/claude-session.test.ts ./src/daemon/service.test.ts --isolate --max-concurrency=1` and passed `366 pass/0 fail` with `3368 assertions`.
- 2026-09-05, Phase 3 start: provider-neutral usage observation v2 is in progress under the exact Codex authority, split Claude quota/accounting, and deferred callback-persistence contracts recorded above. No Phase 3 acceptance evidence has been claimed yet.
- 2026-09-05, Phase 3 done and Phase 4 start: two independent reviews covered the runtime/service turn-settlement path and the domain/storage authority, replay, retention, migration, and schema surfaces. Review blockers were repaired, including the pre-bind turn-usage persistence race and exact immutable v36 structure enforcement with converged migration expectations. Root integration under host-scheduler label `oompa-phase3-provider-usage-final` passed `535 pass/0 fail` with `4432 assertions`; the converged typecheck and diff checks were green. Phase 4 is now in progress, but no Phase 4 behavior is claimed yet.
- 2026-09-10: PR181 adds a bounded browser view of legacy daily Codex history only. Independent review found that daily admission cannot supply current usage or throughput, and adding reset credits to v1 breaks older exact-key readers. The repair preserves v1 bytes and cadence, displays unknown for missing/stale/expired reports, and leaves Claude usage, credits and live forecasts unavailable. Phase 8 and Phase 9 remain incomplete; no current-head producer, hosted deployment or full browser acceptance is claimed. See the dependency map in `oompa-app-simplification.md`.
