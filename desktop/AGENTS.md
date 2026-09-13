# Contents

- `oompa-menubar/` contains the Oompa adapter: a thin binary that speaks the local daemon's unix-socket command protocol and renders daemon and session state into a menu.
- `Cargo.toml` defines the desktop workspace shared by all product adapters.
- The product-neutral menu-bar foundation lives in `hraness/desktop-foundation` and is pinned here by immutable tag; do not vendor or path-depend on it.

# Guidelines

- Keep product adapters thin. The daemon remains the sole authority; the menu-bar binary is a disposable client that must hold no privilege of its own.
- Preserve the local transport contract: read the capability file, validate it before connect, send one bounded version-2 request per connection, match the response `requestId`, and distinguish unavailable-before-dispatch from indeterminate-after-dispatch. Never retry an ambiguous outcome.
- The binary must run unbundled. `cargo build` output is the artifact `oompa menubar` spawns; `.app` packaging is an optional later gate, never a prerequisite.
- Keep secrets, raw socket paths, and environment values out of menu labels, tooltips, logs, and argv.
- Build and test with `cargo build` / `cargo test` inside `desktop/`. Keep `desktop/target/` ignored.
