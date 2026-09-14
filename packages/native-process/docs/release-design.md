# Native process package builder and release design

Status: integration contract. The package contains the staged TypeScript source,
strict artifact model, installed-image resolver and deterministic tests. This
document does not establish a release, platform qualification, or product
activation. The builder, workflow, installer and consumer changes below remain
required before those claims.

## Source and ownership

`@hraness/native-process` starts at version `0.1.0` and protocol version 1. It
publishes Bun TypeScript ESM, matching its declared Bun 1.3.14 runtime. Loading
TypeScript through Bun does not require a separate compiler installation. No
Rust compilation or download occurs during an invocation.

The package owns its exact `zod` 4.4.3 dependency. A consumer's own Zod version
may differ. Cross-package process contracts use structural values and promises;
consumers must not cast schemas between Zod versions or replace this package's
validation with their own domain schemas.

The only Rust source is `native/process-kernel` at the same repository commit.
The builder invokes that crate by explicit manifest path. It must not copy a
second crate under this package or create another JavaScript lockfile. Add the
package to the root Bun workspace and update the root lock in one integration
change. Package versions, CLI versions and protocol versions are independent.

The staging receipt records the exact source imports and hashes. It is excluded
from publication. It is not provenance for an immutable release, and its source
hashes do not admit binaries compiled from a different tree.

## Canonical archive

Publish one npm-compatible tarball, `hraness-native-process-0.1.0.tgz`, containing
the package manifest, source ESM, README, license, and every platform asset
admitted for that package version. The same archive is usable by both consumers.
An optional npm mirror must publish these exact tarball bytes without repacking.

Use an allowlisted `package/` layout:

- `package.json`, `README.md`, `LICENSE` and `src/*.ts` runtime files.
- `native-artifacts/manifest.json` with a strict bounded format version.
- `native-artifacts/<rust-target>/oompa-process-kernel` for each admitted Unix
  target, or the reviewed `.exe` name for a future Windows backend.
- `native-artifacts/licenses/` with required notices for the exact linked Rust
  dependencies and an inventory naming their hashes.

The archive must exclude tests, fixture executables, Cargo target directories,
source checkout paths, local receipts, unpublished provenance and credentials.
Reject path traversal, absolute paths, duplicate names, hard links, symlinks and
unexpected members before extraction. Bound member count, individual expanded
size and total expanded size. Treat executable mode as metadata, not admission.

The implemented manifest schema is exported from `src/artifact-model.ts`. It
requires an exact ordered `NATIVE_CLIENT_FILES` inventory and a
`licensesSha256` binding for the license index. The license index is bounded to
128 unique crates, 256 unique files, 256 KiB per file and 4 MiB total. License
paths are relative to the license directory and have at most four safe components.
Unexpected files or directories under `native-artifacts` refuse admission.

Qualification files live at `native-artifacts/qualifications/<rust-target>.json`,
with a 256 KiB bound and the exact artifact qualification digest.
`native-process-v1-posix-custody`, version 1, is the fixed qualification profile.
Its release evidence must cover the target acceptance cases below against the
exact executable digest and published client protocol. The resolver verifies
the profile identifier and evidence-file hash; only the release gate establishes
that those actual qualification runs passed. A digest of fabricated evidence is
not a qualification. The release pipeline records full compiler, SDK, linker and
runner details in the hashed qualification evidence; the main model holds the
bounded source/toolchain and target identities.

The embedded manifest lists package/version, protocol version, source commit
SHA, relevant source-tree digest, root Bun lock digest, Cargo lock digest,
toolchain file digest, exact `rustc -Vv`, Bun version, and the client file
inventory. Per native target it lists Rust target triple, OS, architecture, ABI
and minimum OS where applicable, filename, byte size, SHA-256, and separately
the supported scope and qualification evidence identity. Bind evidence to the
final executable bytes, including any signing or other transformation.

Hash each runtime file and executable. The manifest does not hash itself or the
tarball containing it: record those outer hashes in `SHA256SUMS` and the release
attestation, avoiding a self-referential digest. Consumers may not trust a
manifest solely because its adjacent checksum agrees. The outer archive digest
must be admitted against the expected repository, package tag, source SHA,
workflow identity and immutable release/asset identity.

## Build and qualification

The workflow checks out one exact governed commit with only fully qualified
required refs, verifies the annotated package tag and reviewed source, installs
the root Bun lock without lifecycle scripts, and builds the one native crate
with its pinned Rust 1.97.1 toolchain and locked dependencies. Fetching build
dependencies is a CI preparation step; the subsequent builder must not silently
update a lockfile or use an ambient toolchain. Record all effective native build
flags and linker/SDK identities, including target and deployment minimum.

Use a target matrix, with each entry carrying an explicit admission state:

| Target family | Native mechanism now | Release admission requirement |
| --- | --- | --- |
| macOS ARM64 | POSIX group and anchor | Exact archive installed on the matching real OS, native fault suite, real Bun transport and observation proof |
| macOS x86-64 | Same source, distinct executable | Matching real architecture qualification; ARM64 compilation or emulation is insufficient evidence |
| Linux | POSIX implementation and Linux identity branch | Matching target/ABI native qualification, including PID namespace and anonymous socket rules |
| Windows | Explicit scope refusal | A real Job Object backend and Windows custody evidence before any support claim |

Do not infer a qualified target from a successful build. The manifest may omit
unqualified targets. Both consumers must check this map before reserving an
effectful invocation; a missing target yields a closed unsupported capability
result with no provider launch. Current local Mac fixture evidence must be
repeated against the installed archive before admitting that release's bytes.

After building native assets, create the tarball exactly once with lifecycle
scripts disabled. Preserve its immutable CI artifact ID and digest. Subsequent
jobs download the exact artifact, verify it, install it into a clean isolated
directory and test imports by the package's real name and exports. Do not test
source imports while claiming package installation works.

Required target acceptance includes graceful stop, forced stop, partial or lost
write acknowledgements, blocked input/output, controller loss, supervisor death,
anchor-only failure, stopped-supervisor cancellation, pre-activation loss,
descriptor inheritance, inherited SIGCHLD disposition, native stream EOF,
observation-mode identity and scope checks, and operation failure followed by
proven physical closure. Missing evidence stays a refusal or unresolved custody,
never a replay or fabricated join. Combined anchor and supervisor loss retains
the product's observation-only recovery barrier.

## Immutable helper admission and Mac image lifetime

The implemented resolver accepts the product release owner's pinned manifest
digest and canonical private image root, and selects the current platform from
its own runtime. It does not accept a caller-supplied executable path,
environment override or arbitrary URL. The low-level transport
retains its trusted absolute-path parameter; product entry points must not
expose it as a provider request option.

Installation downloads and verifies the canonical archive against trusted
release provenance before extraction. Create a fresh private staging directory
on the intended filesystem. Open and verify the extracted regular files without
following links, reject unexpected owner or mode, validate the bounded inventory
and executable format/architecture, and check every expected digest. Do not run
an extracted executable to discover whether unverified bytes are safe.

Publish the admitted image to a version and content-addressed filename under the
private image root using an exclusive no-replace hard link from a staged file. A version path must never be a mutable
symlink, alias to a build output or caller-controlled checkout. File and ancestor
identity checks must reject replaced paths, unsafe ownership/modes and links.
Retain the image identity, content digest and artifact binding in the host's
admission capability; use that exact resolved path for transport and observer.

The implemented cache publishes a mode-0500 owner-only regular file after syncing
its bytes and private staging directory. It syncs the image root before returning.
An existing destination must match every expected byte and format; it is never
rewritten. Cleanup removes only this attempt's known staging inode/name. A crash
after publication may retain a staging alias, so admission permits one or two
links to the otherwise exact read-only image. It never removes an old alias.
A concurrent resolver may admit the complete public image before the creator
unlinks its staging alias. The final checker permits exactly that two-to-one
link transition with unchanged device, inode, owner, group, mode, size and
modification time and fully revalidated bytes/header. It then advances the
private capability's metadata so later same-count change-time drift still
refuses. Link increases and other metadata changes refuse.

The Unix anchor currently re-executes `current_exe()`. On Mac, a running image
mapping or an open read descriptor alone does not establish which bytes a later
pathname execution opens. Therefore admission requires a retained image-lifetime
claim before the initial helper spawn, covering the entire directory and file
through the anchor re-exec and until all invocation custody is settled. This
version retains published images indefinitely and exposes no garbage collector,
reference-count store, delete or release operation. Every supported installer
and upgrade path must preserve that no-replace/no-delete fence. An update may publish a new immutable image and
atomically change the default selection for future launches; it may not rewrite
or unlink the image used by an active or unresolved invocation.

Check identity and digest at admission, then make the final current-image check
synchronously at the spawn boundary under the retained claim. Keep the claim
through failed construction and unknown acknowledgement. Persist enough image
binding for recovery to retain the same version after a controller crash. Once
admitted, a token's final spawn check validates its retained cached image and
ancestors independently of the original package installation. A supported package
upgrade may remove the old installation without invalidating that image.
Do not release the claim merely because the launcher exited or a JavaScript
stream was abandoned. A future, separately reviewed garbage collector must demonstrate that no
live, pending or unresolved product record references the image before deletion.

These cooperative lifecycle fences prevent supported installers from racing
anchor re-execution. They are not a claim of isolation from an arbitrary hostile
process with the same filesystem authority. If the product threat model requires
that stronger guarantee, exact-image execution must move into a reviewed native
file-handle/OS mechanism before activation; a hash-then-path-spawn sequence is
insufficient. Admission tests must cover concurrent upgrade, replaced file or
ancestor, symlink substitution, in-place rewrite attempts, and retention after
unknown cleanup.

## Release namespace and recovery

Use annotated tags `native-process-v<version>`, beginning with
`native-process-v0.1.0`, and a separate `native-process-release.yml` workflow.
Require the tag suffix to equal this package's version, not the root CLI version.
The existing CLI workflow matches `v*`; preserve that filter so a package tag
cannot run the CLI publisher.

Publish a draft, attach the exact verified archive, checksums and authenticated
provenance, then publish with `make_latest=false`. Never reuse the CLI publisher
unchanged: it currently publishes with `make_latest=true` and requires the CLI
release to be Latest. The package publisher must verify its own tag, numeric
release/asset identity and immutable state while checking that it did not claim
Latest. A concurrently published legitimate CLI release may advance Latest.

Require the repository's immutable-release policy and read back immutable state
before admitting distribution. If publication is uncertain, reconcile by exact
tag, source, numeric release ID, asset names, sizes and digests before retrying.
Never overwrite an existing asset or repoint a tag. A mismatched existing draft
or published release is a closed failure, not permission to replace it.

Use the existing reviewed GitHub workload authority and required environment
gates. Attest the exact archive digest with repository/workflow/source identity;
the verifier must reject a foreign workflow or tag even when the bytes are
internally consistent. Preserve the existing CLI release and package checks.
An npm OIDC mirror follows canonical publication and may fail independently;
its absence must not make the GitHub artifact unusable or alter canonical bytes.

## Root integration and completion

The integration owner must add the workspace and exact dependency lock, extend
package inventory and CI to include this source, implement the builder and
publisher, install and admit the exact immutable platform images, and publish
the canonical archive only after the relevant gates. Root policy currently
assumes one CLI package in several checks, so adding workspace files alone is
not a complete package release integration.

After canonical publication, Oompa and Agentrouter must consume the same exact
package version and archive integrity. Exercise each real production factory
through that installed package. Keep each product's account/daemon authority,
Prepared and Ready commits, final synchronous write fence, durable release and
recovery policy in its own owner. Agentrouter's structural process bridge does
not supply a durable authority journal by itself.

Remove both consumers' mechanism copies after cutover; use re-exports only where
an existing public import contract must remain. Remove the temporary extraction
receipt when it no longer explains staged source. Run each repository's required
aggregate on the converged tree, then prove clean install, upgrade with an active
old image, interrupted upgrade and retained-image recovery. Artifact admission
does not enable default provider use until the relevant product's activation
and platform qualifications also pass.
