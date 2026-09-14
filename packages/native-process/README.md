# @hraness/native-process

Bounded byte transport between a Bun host and an owned native process helper.
The package provides process and boot identity schemas, framed launch and write
messages, bounded output queues, physical cleanup observations, and a structural
process port for provider adapters. It requires Bun 1.3.14.

This source is an extraction candidate. A canonical archive with admitted native
assets has not been published from this package. The source directory alone is
not an installed or qualified provider runtime. There are no install hooks or
runtime downloads, and no Rust compiler is required during provider operations.

## Host integration

The host owns executable admission, launch arguments and environment, account
authority, durable invocation records and release policy. `NativeProcessTransport`
starts one already-reserved invocation using an admitted absolute helper path.
The path parameter is a trusted composition seam, not an executable override for
provider requests or user input.

The host must retain this order:

1. Admit the exact immutable helper artifact and platform capability. Durably
   reserve the invocation under current product authority before construction.
2. Commit `onPrepared`'s exact scope identity. `beforeActivate` then performs the
   last synchronous authority check immediately before activation.
3. Commit `onReady`'s exact root identity before `ready` resolves. Recheck product
   authority synchronously immediately before each `write`, with no intervening
   await.
4. Consume both output streams and track every write result. A write has at most
   one outstanding acknowledgement. Full acceptance means all bytes entered the
   native child pipe; it does not mean a provider RPC succeeded.
5. Stop through the owned handle, retain physical settlement evidence, and let
   the product commit its own durable release. Reconcile an uncertain database
   result against the exact record instead of repeating the operation.

`rootExited` observes only the launcher. `joined` proves either closure of the
owned scope and native streams or that the provider was never spawned and any
prepared scope was closed. It does not
prove durable product release or successful output delivery. `transportCompleted`
reports operation and consumer-drain success separately; an operation failure
remains a failure after physical cleanup succeeds. Missing or contradictory
evidence rejects settlement and leaves recovery to the host.

`ProviderProcessPort` describes the same trusted boundary without product types.
Its result validator accepts nonempty provider writes. The lower-level wire also
supports a zero-byte write that consumes a sequence ID. Adapters must preserve
their own nonempty message rule rather than interpreting empty writes as RPCs.

## Observation and recovery

`observeNativeHost` and `observeNativeScopes` run bounded, fixed observation
modes with an empty environment. Serialized PIDs, group IDs, boot identities and
nonces carry observation data only. They never grant authority to signal a saved
process or release an account. The product must combine validated observations
with its exact held lock, store identity, durable binding and revision.

The POSIX helper uses a separate group anchor and preserves the official
launcher/native-child topology. Existing Mac fixture evidence does not qualify
Linux, Windows, another architecture, or this package's future release bytes.
Windows scope requests currently refuse before provider execution. A product
must refuse missing or unqualified assets before activation and must not fall
back by replaying a possibly executed operation.

## Source and distribution

`resolveInstalledNativeArtifact` accepts a canonical private image directory from
the product state owner and a manifest digest pinned by authenticated release
metadata. Neither value is an untrusted request or environment override. The
resolver derives installed assets from its own module location, validates the
bounded client, native, qualification and license inventories, and publishes a
verified helper at a content-addressed image name without replacement.

The opaque result exposes a frozen identity through `nativeArtifactIdentity`.
Call `nativeArtifactExecutable` synchronously immediately before constructing
the transport or observer, with no intervening await. It rechecks the image's
name, inode, ownership, permissions, bytes and ancestors. Retain the capability
through actual or unknown custody. The package intentionally provides no image
release, deletion or garbage-collection operation. Supported upgrades keep old
images indefinitely, including when the original package installation is removed.

Publication uses a privately staged file and an atomic no-replace hard link. A
crash between publication and staging cleanup can leave two names for the same
read-only image; later admission accepts that exact two-link image and leaves the
alias intact. Normal publication can reduce the link count from two to one.
The final checker accepts that one transition only with unchanged inode, owner,
mode, size and modification time plus fully verified bytes, then retains the new
metadata. Other link or change-time drift refuses admission. A changed name,
inode, mode or content still refuses admission.
These checks cover cooperative processes under the same user authority. They
do not isolate the helper from an arbitrary hostile process with that authority.

Authenticated package verification must precede loading this client code. Its
runtime checks detect installed drift and cannot establish trust in malicious
already-loaded code. Applications that bundle JavaScript must keep this package
external so its own installed module location continues to identify its assets.
Missing assets refuse before any provider execution.

The single Rust source remains at `native/process-kernel` in the repository.
Release builds must package prebuilt platform assets from that crate together
with the exact client source, a bounded inventory and verified provenance.
The qualification job separately retains `unit-tests`, `native-tests` and
`process-kernel-fixture`, with their sizes and hashes in the prepack evidence.
These internal testing inputs let the installed-archive gate repeat the same
native suites against the admitted helper. They are excluded from the public
archive and cannot be selected as product runtimes.
Helpers must run from admitted immutable version paths so the group anchor
re-executes the same admitted bytes. Upgrades must leave active and unresolved
versions intact.

GitHub Release archives are the planned canonical distribution. An npm mirror
may carry the exact same archive bytes; it is not required for canonical
distribution. Artifact admission, native platform qualification and product
activation are separate gates.
