# Contributing

Oompa is in public beta development. Open an issue before a large change so the authority and compatibility boundary can be agreed first.

## Local setup

1. Install Bun 1.3.14.
2. Run `bun install --frozen-lockfile --ignore-scripts`.
3. Run the focused test beside the code you change.
4. Complete the applicable final validation below before merge.

Browser acceptance also requires Node 24.18.1 and the Chromium revision provided
by the pinned Playwright package. Run `node node_modules/playwright-core/cli.js
install chromium` to provision it. Set `BUN_EXECUTABLE_PATH` and
`CHROMIUM_EXECUTABLE_PATH` to the explicit installed executables, then run
`bun run check:browser`. Bun builds the app, site and isolated fixture; the Node
driver verifies their compiled output with fresh browser profiles. Before
acceptance, `test:browser:custody` exercises real cancellation during preparation
and connected browser ownership, plus failure after partial server setup. These
native cases are skipped by ordinary script tests and run only through the
explicit custody command. The runner retains evidence under `tmp/app-browser-*/`
and `tmp/browser-custody-*/` and requires every owned process and listener to
close before reporting acceptance. Uncertain collection stays failed.

## Continuous integration

CI runs the complete gate in seven isolated jobs on both macOS and Ubuntu.
Six jobs run `bun run test:source --shard=1/6` through `--shard=6/6`. Pinned
Bun partitions the complete source-file discovery across those jobs, retaining
serial tests and isolated file globals. The seventh job,
`bun run check:ci-remainder`, runs every other command from `bun run check`,
in its original order. All jobs retain the same pinned dependencies, complete
governed Git history and Linux native verification. Source jobs have a finite
75-minute job limit. The macOS remainder has 25 minutes; the Ubuntu remainder
and browser jobs retain 20 minutes. The macOS allowance includes setup and
post-job cleanup after an observed successful 19-minute, 36-second gate that
reached the former job limit during cleanup. Every test retains its own
deadline. These finite job allowances cover measured work, without retries
or skipped failures.
The `Required` check succeeds only when all fourteen jobs and the separate
compiled app/site browser job succeed.

The workflow regression tests compare the expanded phase commands with the
full gate and reject omitted or duplicated commands. They also require all
six source shards and prove whole-file coverage and failure propagation with
the pinned runner. Update that contract when changing the gate. Source-file
sharding does not split a large individual test: independent cases still need
separate tests within the unchanged per-test deadline.

## Final validation

Complete `Required` CI owns the final source aggregate, including executable
changes, when its coverage and equivalence to `bun run check` are established.
An independent reviewer inspects the complete diff and its impact on callers,
state, operations, and validation. Run relevant focused contracts locally,
including plugin/adoption validation when applicable, and the existing CI
command-coverage and shard-equivalence tests in `scripts/release-workflow.test.ts`.
Those tests preserve expanded command multiplicity, remainder ordering, pinned
whole-file source coverage, and failure propagation; both operating-system
matrices and the separate browser job must pass.

Changes to workflows, test discovery, commands, deadlines, or platform coverage
need independent comparison against the prior required coverage. Modified
equivalence assertions alone cannot certify a reduction.

Wait for the unchanged complete `Required` gate on the final PR head and
current-base integration candidate. Confirm the checked tree and expected head
at merge; head or base movement requires fresh matching CI evidence. Record the
independent review, head/base/checked-tree identities, CI run and attempt, and
final `Required` job result. This source aggregate does not need a duplicate
local full run.

Retain every explicit local, native, coupled-run, live, and installation
acceptance requirement. Release, deployment, and production readback gates
remain separate. Investigate observed failures and stalls with bounded focused
diagnostics; passing CI alone does not dismiss them or establish an unperformed
local acceptance. Use `bun run check` locally for diagnosis or as the final
source fallback when CI coverage or equivalence is absent or uncertain. Preserve
the host scheduler and process-custody requirements for every local command.

## Change requirements

- Add a deterministic regression for each corrected failure.
- Add property tests for new parsers, reducers, state transitions, ordering rules, and serialization laws.
- Update `kb/plans/` when a change alters a recorded product decision or acceptance gate.
- Keep generated files reproducible and include the generator input.
- Do not commit credentials, account identifiers, local paths, transcripts, or provider payloads.

By contributing, you agree that your contribution is licensed under the MIT License.

## Agent-authored changes

Many changes in this repository are drafted by coding agents (Codex and Claude Code) working from `AGENTS.md` and `kb/plans/`. Independent review, including review by a coding agent, covers the full diff; a separate human sign-off is not required for routine authorized delivery. The applicable final validation above must pass on the exact tree, and no phase of a plan is marked complete without the acceptance evidence the plan names. Artifact admission and operational activation follow the separate [release policy](docs/beta-release.md). Agent-authored commits carry a `Co-Authored-By` trailer naming the agent. Prose in an agent-authored change follows `WRITING.md` and `STYLE.md` like any other prose.
