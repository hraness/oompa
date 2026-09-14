# Deletion backend acceptance

Run this repository-only qualification before replacing the live candidate with
a deletion-lifecycle change. It supplies the fresh-deployment and live-completion
evidence required by [retention](retention.md). It executes an official Convex
backend with empty private storage, production schema and handlers, and unchanged
production cron intervals. It does not substitute a simulated database or invoke
the deletion drain manually.

The fixture creates synthetic identities only inside that owned loopback
deployment. It exercises a dedicated deletion reserve, legacy inline backfill
at the 256-record identity ceiling, mature abandoned-inline cleanup and an
untouched witness. Real quota helpers charge each inserted row; the fixture
does not manufacture quota counters. One auth session with owned token rows
fills the legacy identity, keeping the unchanged bounded drain finite.

## Run the qualification

Use pinned Bun 1.3.14 and the frozen repository dependencies. Obtain the official
[Convex backend release](https://github.com/get-convex/convex-backend/releases/tag/precompiled-2026-09-11-157eb19)
and verify its archive digest before using the extracted executable. The admitted
macOS ARM64 archive has SHA-256
`a61d352b0501ac6e0e56c25efc2a1e6a2a59a28076ef1168e042317946653641`;
the executable has SHA-256
`8ec1d2cfc749400444bffe243cafb13578db898fd81f623e725962b88bbf5679`.

Run through the installed host scheduler. Use its resolved absolute path,
`--mode=shared --lane=mac-native`, and the complete child command:

```sh
/absolute/path/oompa-host-run --mode=shared --lane=mac-native \
  --label=oompa-deletion-backend -- /absolute/path/bun run acceptance:deletion-backend \
  --backend-binary /absolute/path/convex-local-backend \
  --backend-sha256 8ec1d2cfc749400444bffe243cafb13578db898fd81f623e725962b88bbf5679 \
  --evidence-path /protected/release/deletion-backend.json
```

The evidence path must be unused. No argument selects a hosted target, personal
identity, credential source or existing database. The runner binds both listeners
to loopback, generates run-local credentials, and copies the production inputs
and fixture into private scratch storage. The fixture is never part of a
production deployment or the distributed package.

The two deletion jobs share the unchanged one-minute worker quantum. Abandoned
cleanup uses the unchanged 15-minute maintenance interval. Allow approximately
30–45 minutes, within the runner's finite deadline. Do not accelerate the crons
or invoke maintenance manually to obtain a passing receipt.

## Required evidence

The runner binds its result to the production input manifest, fixture and
harness digests, exact cron bytes, backend binary and pinned CLI. Archive
verification is the operator's provisioning step; the runner rechecks executable
bytes and does not claim to have inspected the release archive. It verifies
exact inline byte charging without a new identity record and unchanged replay;
then it invokes the public deletion request under a synthetic test principal.
It proves subject disabling, epoch advance, rejection by a protected public
handler, same-request replay and rejection of an incorrect status capability.

After scheduled draining, capability-only status must report terminal completion
twice. Owned records and quota obligations must be absent, service accounting
must match remaining records, and the witness must remain unchanged. Scheduled
abandoned cleanup must also complete. A passing receipt is published only after
the backend, deployment children and listeners are collected under the ordinary
machine recovery journal. Private scratch remains available after success,
with a completion marker, and after failure with recovery evidence. Retaining
these files does not leave a backend running. Never remove a journal or signal
another run to obtain admission.

## Scope of the claim

This is native backend lifecycle qualification. The synthetic principal does
not qualify email delivery, SaaS login, JWT signature verification, distributed
hosted infrastructure or deletion of a production identity. The broader
[authenticated live scenario](live-acceptance.md) retains those separate claims.
Earlier local web demonstrations and deterministic fixtures do not satisfy this
new bounded native gate.

Before production replacement, independently review the receipt and match its
production input manifest to the checked integration result. After deployment,
the [hosted operator](hosted-sync.md) must separately prove the exact production
target and runtime, repair capacity, complete two zero-debt scans, activate the
runtime and publish its protected activation readback. Native qualification
alone grants no production write or activation authority.
