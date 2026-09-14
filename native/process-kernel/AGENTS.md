# Contents

- `protocol.md` defines version 1 of the bounded controller and provider-byte transport.
- Rust source implements the native process owner; native tests use credential-free executable fixtures.

# Guidelines

- Follow the exact protocol and report changes to the integration owner before changing the wire contract.
- A successful write acknowledgement means complete child-pipe acceptance. Never replay duplicate or uncertain writes.
- Keep the launcher and its native child in the requested qualified scope. Preserve live identity while signaling; a reused PID or process-group number is not authority.
- Hold physical ownership through stop, pipe closure and native collection. Expose uncertainty and retain recovery evidence when any observation is missing.
- Tests must prove actual OS behavior for native claims. Pure codec tests and compilation cannot admit a platform.
