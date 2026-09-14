# Contents

- `src/` owns the provider byte transport, process and boot identity values, observation codec, and structural host process port.
- `src/artifact-model.ts` defines the exact release inventory. `src/artifact-resolver.ts` admits installed bytes into a create-only private image cache.
- `README.md` states the host integration contract and current distribution limits.
- `docs/release-design.md` specifies the proposed builder, immutable artifact admission, and release gates.
- `docs/extraction-receipt.json` records the temporary extraction's exact source hashes. It is development evidence, excluded from publication.
- `../../native/process-kernel/` remains the only Rust helper source.

# Guidelines

- Keep product account, profile, provider RPC, store, daemon authority and journal policy outside this package.
- Parse foreign values strictly, bound every frame and queue, and preserve the versioned wire. Coordinate wire changes with every native and host consumer.
- Keep root exit, pipe EOF, full write acceptance, operation success, physical settlement and durable product release separate.
- Admit writes synchronously without queueing behind another write; never retry uncertain bytes or derive signal authority from serialized identities.
- Expose structural value types across consumers. The package owns its exact Zod dependency; consumers need not use that version in their own domains.
- Keep one root Bun lockfile and one Rust crate. No native compilation, downloads or lifecycle scripts during provider operations.
- A helper path is usable only after product artifact admission. Immutable version paths must survive through anchor re-execution and all active or unresolved custody.
- The product release owner supplies the trusted manifest digest and canonical private image root. Do not add URL, environment or executable overrides. Supported installers never remove published cache images.
- Run real native tests before platform admission. Pure and mocked tests do not qualify an OS or authorize default activation.
- Keep the staged extraction temporary: both consumers must converge on one exact published version, then remove their mechanism copies.
