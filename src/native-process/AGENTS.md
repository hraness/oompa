# Contents

- `protocol.ts` defines the bounded byte-process controller wire contract and strict typed native observations.
- Native transport adapters retain their own helper, pipe and per-invocation state; provider protocol and product journals remain outside this boundary.

# Guidelines

- Parse native output from unknown and reject unknown frames, excess allocation, contradictory events and incomplete terminal evidence.
- Preserve provider byte order without printing bytes, paths, environments or native error text.
- Readiness must precede the product's final write authority check. Never add a queue that independently admits stale work.
- Keep root exit, stream EOF, local write acceptance, operation outcome and custody settlement distinct.
- Never replay uncertain writes or derive signaling authority from serialized PIDs, nonces or receipts.
