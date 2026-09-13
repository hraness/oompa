# Contents

- `binding.ts` captures and revalidates the shared exact executable, private roots and environment without spawning a process.
- `detachment.ts` observes an exact retained Darwin child's process identity, session, process group and terminal device, and parses the separate bounded live-state rows.
- `process.ts` exposes fixed qualification-only authentication operations, the existing auth/version factory interfaces and a closed observation over two actual retained status instances.
- `process.test.ts` tests the closed protocol and binding rules without native execution.
- `native.test.ts` explicitly enables credential-free Darwin process fixtures and owns their cleanup.
- `fixture.zig` is the fixed native test program; it never invokes a provider.
- `contract.md` records process evidence, remaining live authority and qualification limits.
- `foreground.ts` supplies the single-attempt foreground login factory with the owner's fixed terminal descriptors and the separate named manual-browser binding.
- `foreground.test.ts` checks its closed request boundary without native execution.
- `foreground-native.test.ts`, `foreground-native-worker.ts` and `foreground-fixture.zig` own credential-free PTY completion and signal fixtures.

# Guidelines

- Keep this qualification boundary disconnected from production, the package and live authentication. No command entrypoint or generic argv execution API is permitted.
- Preserve the exact executable, configuration, temporary-directory and environment binding immediately before every spawn.
- Retain the actual child handle. Observe its Darwin start identity, session and process group, and terminal-device absence before admitting output. Never signal from a stored PID or infer collection from process disappearance alone.
- Bound output, execution, cancellation and join. Missing child or stream collection remains uncertain and prevents binding reuse.
- Overlap accepts only two actual retained status instances. Preserve the ordered native A1/B/A2 observations and separate inspector joins; pending promises, late output or supplied booleans never establish live overlap.
- Reuse the existing authentication and version collectors through their factory interfaces. Never expose raw provider output through public diagnostics or receipts.
- Native fixtures require the explicit native flag and the installed absolute host scheduler's mac-native lane. Ordinary checks start no native process and inspect no profile.
- Foreground login inherits the owner's admitted terminal and process group, captures no provider output and delegates signal policy to the existing auth runner. Its ceremony has no artificial timeout; interrupted native join remains bounded.
- Only the manual-browser qualification binding adds the fixed `BROWSER=/usr/bin/true` at actual spawn. Keep the ordinary request and production environment allowlist unchanged. Never accept an ambient opener, capture an authentication URL, or infer private-browser isolation from the CLI configuration root.
