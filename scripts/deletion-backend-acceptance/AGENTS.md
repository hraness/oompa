# Contents

- `fixture.ts` seeds synthetic deletion subjects and returns bounded aggregate observations for an official disposable local Convex backend. The runner copies it into an isolated backend source tree; it is never a production module.

# Guidelines

- Preserve the production schema, quota helpers, handlers, and cron schedule. Do not export a fixture drain or change production data.
- Require the explicit disposable-backend environment marker and empty user state before seeding. Keep synthetic identifiers and capabilities inside the private runner; receipts contain only aggregate evidence.
- Bound every census, preserve an unchanged witness, and reconcile actual charged rows with user and service ledgers, including surviving completion receipts.
