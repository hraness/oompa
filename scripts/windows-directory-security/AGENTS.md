# Contents

- `directory-security.h` and `directory-security.c` contain the scripts-only Win32 directory-handle observer and bounded relative security-descriptor parser.
- `directory-security.fixture.c` owns one fixed synthetic native suite, its private directories and handle collection.
- `build-fixture.ps1` compiles only those fixed inputs with the Windows runner's actual MSVC and SDK and records bounded provenance.
- `native.test.ts` tests closed result admission portably and drives the fixed native executable only under its explicit Windows CI gate.
- `bunfig.toml` supplies an explicit inert startup file without POSIX device paths.
- `contract.md` records the exact policy, native acceptance cases and limits.

# Guidelines

- Keep this experiment disconnected from product installation, state, authentication, IPC and platform guards.
- The core takes an already-open handle, never a pathname, and reads current TokenUser internally. Never add ACL repair, privilege adjustment, provider access or arbitrary process execution to it.
- Native fixtures may mutate only their fresh, named synthetic directory objects. Never traverse or recursively remove a junction. Retain uncertain objects and fail.
- Bound relative offsets before reading SID/ACE bytes. Reject every unknown permission shape; do not interpret an incomplete security read as owner-only access.
- Logs contain closed case counts, status and source/toolchain hashes. Do not emit user SIDs, raw descriptors, filesystem identities or private paths.
- Ordinary Mac/Linux tests must not create Windows fixtures. Native Windows evidence remains required for this unit and cannot establish product Windows support.
