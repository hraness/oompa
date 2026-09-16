// This module is the only place in `src/` that spells the pinned Devin CLI
// version. The `/usage` panel is a human-facing terminal surface, not a
// published contract, so Oompa pins one exact release and fails closed on drift
// instead of parsing another build hopefully.
//
// Re-pinning procedure (run by hand; the Devin CLI is not an npm dependency):
//   1. `devin --version` on the new build.
//   2. Re-capture `src/devin/usage-panel.fixture.json` with the driver in
//      `src/devin/usage-driver.ts` and inspect the panel for new lines.
//   3. Update `DEVIN_PIN`, adjust the grammar in `usage-panel.ts` when a line
//      changed, then run `bun test src/devin`.

/** Exact release version, never a range or prerelease. */
export type DevinPinVersion = `${number}.${number}.${number}`;

export const DEVIN_PIN = "3000.10.27" satisfies DevinPinVersion;

/**
 * The first line of `devin --version` on the pinned build:
 * `devin 3000.10.27 (bcbe88c7)`. The build hash is observed evidence recorded
 * beside the observation; only the version participates in admission.
 */
export const DEVIN_VERSION_OUTPUT_PATTERN = /^devin (\d+\.\d+\.\d+) \(([0-9a-f]{7,40})\)\s*$/u;
