// Written by `bun run codex:bump <version>`. Do not edit by hand.
//
// This module is the only place in `src/` that spells the pinned Codex
// version. Every other site imports `CODEX_PIN`, and the reviewed digests
// below are regenerated from the installed `@openai/codex` executable.

/** Exact release semver, never a range or prerelease. */
export type CodexPinVersion = `${number}.${number}.${number}`;

export const CODEX_PIN = "0.153.2" satisfies CodexPinVersion;

/**
 * SHA-256 of files produced by the pinned executable's
 * `app-server generate-ts --experimental`, keyed by output path.
 */
export const PINNED_CODEX_SCHEMA_DIGESTS = Object.freeze({
  "ServerNotification.ts": "dfd31c72d1319f069fcdf124bcae6368f15aa0dd0033350bf15519d3e3556d54",
  "ServerRequest.ts": "1c5837adbfbdd005f387478ba87840808d1353b47b82dcf63739a78bb1c8d3be",
  "ClientRequest.ts": "83418e6f3f8100fa59b0324afaaf45c8d258db3dd42a10769d9c337c93b910f2",
  "v2/ConsumeAccountRateLimitResetCreditParams.ts": "f5f79c58b90a126b7620b38bc88d09a3b096543f71cdd949d19bac3c2b03399d",
  "v2/ConsumeAccountRateLimitResetCreditResponse.ts": "3240fe476768362847266693ffdfb4fdd8d8f0d7b628962255b229a182d76682",
  "v2/ConsumeAccountRateLimitResetCreditOutcome.ts": "2fc33514e9745ffeeefada2c51362dc66e6f9c5f6f76d28b0a9a8cf278a2e8fe",
  "v2/ThreadStartParams.ts": "7a3fddbb0cf0585c52edbf19e3a1f6e691681f18ab509f7abfa416da7f0ac824",
  "v2/ThreadResumeParams.ts": "e4f64c88205dbba2bf87635d12b9c5803dd6f19b84b5682a71df7fdcf87862fb",
  "v2/DynamicToolCallParams.ts": "6524a162207514c3a50a1e65f9abed9c59d97f38fb9cf221f740340ef5c5051f",
  "v2/DynamicToolCallResponse.ts": "df53cf5e967d26aa59615db06f4179a7b2330f44df4298a8393eaf9f48f7e115",
  "v2/DynamicToolSpec.ts": "bd4b06afea9395a426f8facc9d800f4b201fea44fab667f854710acff4c8f393",
  "v2/DynamicToolNamespaceSpec.ts": "3c03822c5ea8753aec5bb90b2599832869f92aac6f039bc2ba421c57fb4b6c75",
  "v2/DynamicToolNamespaceTool.ts": "bcaf5742948e4fc08a283b185ef7d5819e054f23bb6ccfbfc42a37593b6bf284",
  "v2/DynamicToolFunctionSpec.ts": "41586221845d8de57d4c6cc91d83f3e004c905648ba62754f5876e331a81d9a8",
  "v2/DynamicToolCallOutputContentItem.ts": "9eebff80cb251a368d772ff75313de20d23dfef0ed6dc7f61630da9040b7e425",
} as const);

/**
 * SHA-256 of `CODEX_PIN`, a newline, then each reviewed matrix entry as
 * `method:disposition` joined by newlines. See `codexMatrixDigest` in
 * `protocol.ts`.
 */
export const PINNED_CODEX_MATRIX_DIGESTS = Object.freeze({
  serverRequest: "74bf24af6ccbddde69cff0c2a6ac8b8aef183b58f42b22c27edd553430ce94a3",
  notification: "767f8d43ca0a192b7303f160b8864583a888d8fe28c32b6880087af81dd62cdb",
} as const);
