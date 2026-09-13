# Third-party notices

Oompa depends on the official OpenAI Codex package, which is licensed under Apache License 2.0, and on Hraness Oh, which is licensed under the MIT License. Oompa pins the immutable public npm release `@hraness/oh@0.4.1`; `bun.lock` binds its exact registry artifact integrity. Oompa also interoperates with the separately installed Claude Code 2.1.260 runtime. Oompa does not redistribute Claude Code, copy or redistribute any provider credential, or vendor Oh.

The Codex provider-session runtime uses Effect 3.22.1, licensed under the MIT License. `bun.lock` binds its runtime dependency graph. Effect supplements Oompa's existing authority and process-custody controls; it does not replace them.

The static oompa.app analytics asset incorporates `@hraness/posthog` version 0.1.2 and its `posthog-js` version 1.412.1 dependency. Both are licensed under the MIT License. Oompa pins the immutable `@hraness/posthog` GitHub release tag, and `bun.lock` binds the exact dependency graph used to build the self-hosted browser asset.

The oompa.app site and browser app use the MIT-licensed `@hraness/ui` v0.5.6 and `@hraness/design-kit` v0.6.2 packages for shared semantic themes and appearance controls. The site also uses the MIT-licensed `@hraness/site-footer` v0.9.0 package. `bun.lock` binds their exact immutable release tags.

The isolated product examples on oompa.app incorporate MIT-licensed `@hraness/direct` v0.7.0, copyright 2026 Hraness contributors. Its full license is preserved in the example's JavaScript bundle. Direct is a pinned development dependency, not a runtime dependency of the Oompa CLI or the authenticated app.

Oompa validates trajectory exports during development against Apache-2.0-licensed `@letta-ai/trajectory` 0.3.0 and MIT-licensed Ajv 8.20.0. These development dependencies are not runtime dependencies of the published CLI.

The `v0.8.1` candidate records its build graph in `bun.lock`, while the install tarball declares its direct runtime dependency versions in `package.json`. This candidate is not yet admitted. The admitted `v0.7.1` predecessor records its own build graph in its immutable source; its release workflow bound the immutable source tag, published the exact tarball plus `SHA256SUMS` on GitHub and the same tarball on npm through trusted publishing, and verified the public bytes and cryptographic provenance before final admission. That predecessor evidence does not admit the candidate. The tarball does not vendor transitive dependencies. Dependency packages retain their own license texts and source metadata.
