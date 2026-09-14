# Windows portable contracts

The additional Windows workflow runs the existing OOC1 framing and observation
tests and the Claude authentication-help grammar tests on native Windows x64
with Bun 1.3.14. Both suites use synthetic values and have no provider or native
process effects. Their results can establish portable codec and parser behavior.
They do not establish Windows account isolation, installation, daemon operation,
process custody or recovery.

The workflow uses the documented
[`windows-2025` runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and checks the actual runtime platform, architecture and version before the
frozen, script-disabled dependency installation. Bun documents
[Windows support](https://bun.sh/docs/installation) for this operating-system
family. Actions retain the repository's reviewed immutable pins. Each run reads
one exact source commit without persisted Git credentials, deployment authority,
secrets or an environment approval surface. Its job has a 15-minute limit.

The complete macOS, Ubuntu and browser `Required` gate remains unchanged. This
separate Windows check must pass on the final integration candidate before this
unit merges. Later Windows backend changes need their own focused native tests
and reviewed integration with the required gate.

The first native Windows run passed 33 tests with 3,069 assertions. The focused
workflow contract passed one test with 30 assertions, and independent review
confirmed that the existing required coverage remains unchanged. The initial
complete `Required` run also passed. Final admission still requires applicable
local workflow validation and passing CI on the final head and current base.
Native Windows product support remains unqualified. The next implementation boundaries are Windows private
state ownership, retained process identity, authenticated local IPC, console
cancellation, installation and interrupted-update recovery. Preserve existing
platform guards until their replacements have relevant native evidence.
