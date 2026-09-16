# Third-party notices

Oompa depends on the official OpenAI Codex package, which is licensed under Apache License 2.0, and on Hraness Oh, which is licensed under the MIT License. Oompa pins the immutable public npm release `@hraness/oh@0.4.1`; `bun.lock` binds its exact registry artifact integrity. Oompa also interoperates with the separately installed Claude Code 2.1.260 runtime. Oompa does not redistribute Claude Code, copy or redistribute any provider credential, or vendor Oh.

The Codex provider-session runtime uses Effect 3.22.1, licensed under the MIT License. `bun.lock` binds its runtime dependency graph. Effect supplements Oompa's existing authority and process-custody controls; it does not replace them.

The static oompa.app analytics asset incorporates `@hraness/posthog` version 0.1.2 and its `posthog-js` version 1.412.1 dependency. Both are licensed under the MIT License. Oompa pins the immutable `@hraness/posthog` GitHub release tag, and `bun.lock` binds the exact dependency graph used to build the self-hosted browser asset.

The oompa.app site and browser app use the MIT-licensed `@hraness/ui` v0.5.6 and `@hraness/design-kit` v0.6.2 packages for shared semantic themes and appearance controls. The site also uses the MIT-licensed `@hraness/site-footer` v0.9.0 package. `bun.lock` binds their exact immutable release tags.

The isolated product examples on oompa.app incorporate MIT-licensed `@hraness/direct` v0.7.0, copyright 2026 Hraness contributors. Its full license is preserved in the example's JavaScript bundle. Direct is a pinned development dependency, not a runtime dependency of the Oompa CLI or the authenticated app.

Oompa validates trajectory exports during development against Apache-2.0-licensed `@letta-ai/trajectory` 0.3.0 and MIT-licensed Ajv 8.20.0. These development dependencies are not runtime dependencies of the published CLI.

The `v0.8.4` candidate records its build graph in `bun.lock`, while the install tarball declares its direct runtime dependency versions in `package.json`. This candidate is not yet admitted. The admitted `v0.8.3` release records its own build graph in its immutable source. Its exact GitHub and npm artifacts passed the source, byte, and cryptographic provenance checks recorded in `docs/beta-release.md#immutable-v083-successful-release-record`. The admitted `v0.7.1` predecessor records its own build graph in its immutable source; its release workflow bound the immutable source tag, published the exact tarball plus `SHA256SUMS` on GitHub and the same tarball on npm through trusted publishing, and verified the public bytes and cryptographic provenance before final admission. That predecessor evidence remains independent of the v0.8.3 admission. The tarball does not vendor transitive dependencies. Dependency packages retain their own license texts and source metadata.

## Hraness Support Foundation 0.3.0

The CLI bundles the optional local support protocol from reviewed commit
`2d034b357680353574411217d68b02b6755b07ed` of
[Hraness Support Foundation](https://github.com/hraness/support-foundation).
It is generated from the pinned build dependency and adds no runtime dependency.

MIT License

Copyright (c) 2026 Hraness

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
