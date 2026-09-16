// This module is the only place in `src/` that spells the pinned Claude Code
// version, its Fable/Opus model ladder, and the reviewed stream-json matrix
// digests.
// Claude Code's stream-json surface is not a published contract, so Oompa pins
// one exact release and fails closed on drift instead of tolerating it.
//
// Re-pinning procedure (mirrors `bun run codex:bump`, run by hand because the
// Claude CLI is not an npm dependency of this package):
//   1. `claude --version` and `claude --help` inside an isolated `CLAUDE_CONFIG_DIR`.
//   2. Re-capture `docs/providers/claude-fixtures/*.jsonl.txt` on that build.
//   3. Update `CLAUDE_PIN`, the model ladder, and the digests below, then
//      run `bun test src/claude` and re-read `docs/providers/claude.md`.

/** Exact SHA-256 evidence for the reviewed npm artifacts and native executable. */
export const PINNED_CLAUDE_ARTIFACT_DIGESTS = Object.freeze({
  nativeExecutable: "3c269f66801028823e24a63ced9fdd3988cb86cf85fccd9f03f87e463b9d3e3c",
  nativePackage: "49042e0a4b3b67304a9adfedca242329668f04cf5f37c3d5c30e5d652653a056",
  wrapperPackage: "b429cb300fb9e1add440330019695fb6ec093684e4a83accd5bd23e2eaab67cc",
} as const);

/** SHA-256 of the immutable, reviewed provider-wire evidence fixtures. */
export const PINNED_CLAUDE_EVIDENCE_DIGESTS = Object.freeze({
  hostToolHelp: "1f3bc618d4f1987e2d9cd8f7b51f82a20031571ada13d17c71c43d3d2f45070b",
  mcpHandshake: "bee276eb5f4d9fd27984f1e0854b73337ffbfec490afef358b37b417049fc2d4",
} as const);

/** Exact release semver, never a range or prerelease. */
export type ClaudePinVersion = `${number}.${number}.${number}`;

export const CLAUDE_PIN = "2.1.260" satisfies ClaudePinVersion;

/** Exact MCP revision requested by the pinned CLI during stdio initialization. */
export const CLAUDE_PIN_MCP_PROTOCOL_VERSION = "2025-11-25";

/**
 * The exact Fable model id this pinned build accepts. Measured on the pinned
 * build (`docs/providers/claude.md`, "Fable model id and reasoning efforts");
 * the id drifted from `claude-fable-5` at 2.1.238 to `claude-fable-5-1` here,
 * so it is pinned per release like the version itself.
 */
export const CLAUDE_PIN_MODEL = "claude-fable-5-1";

/**
 * The only native fallback model the pinned build may be asked to use. The
 * spelling is reviewed data, but it is not runtime authority by itself.
 */
export const CLAUDE_PIN_FALLBACK_MODEL = "claude-opus-5";

/** The only reasoning effort the `fable-max` preset may request. */
export const CLAUDE_PIN_EFFORT = "max";

/** Why the reviewed native fallback is not yet admitted for live use. */
export const CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON = "live_acceptance_required";

/**
 * Closed capability projected into every newly reviewed Claude runtime
 * profile. An armed capability must name the digest of a sanitized,
 * authenticated acceptance record for this exact pin and argv shape.
 */
export type ClaudeNativeFallbackCapability =
  | Readonly<{
    status: "armed";
    model: typeof CLAUDE_PIN_FALLBACK_MODEL;
    evidenceDigest: string;
  }>
  | Readonly<{
    status: "unavailable";
    model: typeof CLAUDE_PIN_FALLBACK_MODEL;
    reason: typeof CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON;
  }>;

/**
 * No isolated signed-in Oompa Claude profile was available for the 2.1.260
 * authenticated acceptance. Help output and binary strings are not evidence,
 * so production runtime resolution remains fail-closed.
 */
export const CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY = Object.freeze({
  model: CLAUDE_PIN_FALLBACK_MODEL,
  reason: CLAUDE_NATIVE_FALLBACK_UNAVAILABLE_REASON,
  status: "unavailable",
} as const satisfies ClaudeNativeFallbackCapability);

/**
 * Reasoning efforts the pinned build's model listing reports for Fable. Oompa
 * requests only `max`; the set exists so an unexpected effort is refused
 * rather than silently forwarded. `ultracode` is deliberately never requested
 * (the plan's "max without ultracode").
 */
export const CLAUDE_PIN_SUPPORTED_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
] as const);

export const CLAUDE_PIN_REFUSED_EFFORTS = Object.freeze(["ultracode"] as const);

/**
 * SHA-256 of `CLAUDE_PIN`, a newline, then each reviewed matrix entry as
 * `event:disposition` joined by newlines. See `claudeMatrixDigest` in
 * `protocol.ts`.
 */
export const PINNED_CLAUDE_MATRIX_DIGESTS = Object.freeze({
  controlRequest: "c704bbb67dfa5a7e91d2cf1ac32bfdfb159aa3661b7a78ca18d333b51025965f",
  streamEvent: "d294f601338b3626edab3aa0a623db60b8ff84f4481139f202e09839ed058389",
} as const);
