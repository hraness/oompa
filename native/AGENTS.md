# Contents

- `process-kernel/` implements the private native byte-process boundary used by production provider adapters.

# Guidelines

- Keep product routing, provider RPC, account authority and durable operation journals in their existing owners.
- Bound every foreign frame and allocation. Keep native unsafe operations isolated from the protocol and value model.
- Distinguish root exit, stream EOF, pipe acceptance, supervisor completion and containment settlement. Missing evidence is never success.
- Keep native artifacts tied to exact source, toolchain and locked dependencies. Runtime compilation and unverified downloads are not production installation paths.
- Preserve the separate Linux authority supervisor and every product-specific confinement contract.
