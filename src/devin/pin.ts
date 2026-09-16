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

/** Exact externally installed Devin CLI release, never a range or prerelease. */
export type DevinPinVersion = `${number}.${number}.${number}`;

export const DEVIN_PIN = "3000.10.27" satisfies DevinPinVersion;

/** Exact model family Oompa asks the pinned Devin ACP server to use. */
export const DEVIN_MODEL = "gpt-6-astra";

/** Naming-compatible alias for other pinned provider modules. */
export const DEVIN_PIN_MODEL = DEVIN_MODEL;

/** Stable ACP protocol version implemented by the installed SDK entry point. */
export const DEVIN_ACP_PROTOCOL_VERSION = 1;

/**
 * The first line of `devin --version` on the pinned build:
 * `devin 3000.10.27 (bcbe88c7)`. The build hash is observed evidence recorded
 * beside the observation; only the version participates in admission.
 */
export const DEVIN_VERSION_OUTPUT_PATTERN = /^devin (\d{1,5}\.\d{1,5}\.\d{1,5}) \(([0-9a-f]{7,40})\)\s*$/u;
