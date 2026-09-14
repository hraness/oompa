# Privacy

This policy describes the Oompa beta data boundary. The hosted sync service is live as an open beta. Besides completed turns, the daemon streams the current turn's assistant text to the hosted service in encrypted, redacted batches that expire within six hours; reasoning summaries are included only when you enable show-thinking for a session, and raw reasoning is never uploaded.

Cloud sync is optional. Local provider profiles, Codex credentials, Claude Code configuration and credentials, and local execution continue to work without it. Oompa identity is separate from every provider account.

## Encrypted before upload

- User messages and final assistant display text. This includes peer-session messages and their supplied reasons when Oompa records them as transcript messages.
- Session names, notes, queued messages, and steering input.
- Codex account labels and observed provider email and plan metadata when cloud sync is enabled. Claude Code account identity and usage are not projected. For managed profiles, Oompa validates one bounded Claude Code authentication-status response transiently, reduces it to signedIn, and never retains, returns, projects, or uploads the identity or usage fields. Personal-home Claude adoption transiently reads bounded account, email, and organization identity metadata and retains only a one-way local authority key. Raw Claude identity fields and that private authority key are never publicly returned, projected, or uploaded; Oompa never opens or parses a Claude credential file.
- Codex and Claude Code personal-session adoption status: whether discovery is enabled and bounded pending, adopted, and fenced counts. Candidate identities and records are never included.
- Turn timing, observed model and tier, and provider usage summaries.
- Bounded observed file and Git metadata, without unbounded filesystem paths.
- Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.
- Remote-command input and results that fit the closed command protocol.
- Canonical Oh operations, including their page records and provenance, terminal-head proofs, portable adoption proofs, and hosted-space descriptors for projects the owner explicitly enrolls in hosted memory.
- A bounded read-only memory summary containing portable space and project labels, exact head and sync metadata, record counts and recent record keys, effective peer policies, and content-free recent peer-action state. Authenticated coverage markers distinguish complete from bounded selections. This summary excludes page bodies, peer message text, action reasons, raw local project or session IDs, paths, and Oh operation bytes.
- For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code. Oompa encrypts both to the account key before upload, lets only the requesting browser read them once, and deletes the hosted handoff on that read or after five minutes.

## Never uploaded

- Codex or Claude Code credentials; provider profile or configuration files; plugin credentials; OAuth access or refresh tokens; authorization codes; PKCE verifiers; provider cookies; or the private device code.
- Raw Codex app-server or Claude Code stream requests or responses.
- Personal-home adoption candidate identities or records, personal-runtime bindings, process identities, schedule-source metadata, provider-home provenance, provider-account authority hashes, or the automation id, firing time, and instructions from an exact Codex Desktop heartbeat envelope. Such an envelope is replaced with generic protected text before session content is projected.
- Raw reasoning, hidden chain of thought, or approval secrets.
- Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.
- Environment variables, arbitrary command output, or unbounded filesystem paths.
- Working-memory Oh records and database bytes; canonical operations or page bodies outside their encrypted operation envelopes; and local Oh database paths.

The sync service necessarily sees the verified Oompa email address, device identifiers, opaque hosted-space identifiers, record types, revisions and key versions, ciphertext sizes, timestamps, execution-lease or command lifecycle metadata, and canonical-memory sequences plus keyed head tokens. It cannot decrypt session or memory content without a paired device key. Email access alone does not recover that key.

A browser device holds the account key and decrypted projection only in that tab's memory by default. Oompa does not programmatically write decrypted provider or session text to the clipboard, but browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text.

The website and app save your theme and appearance choices in this browser. This record contains only those two choices and is not sent to Oompa.

Oompa uses Convex to authenticate the Oompa identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content.

Oompa uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no provider credentials or encrypted session projection.

Oompa uses anonymous, cookieless PostHog analytics on the public oompa.app pages to count page views and page leaves and measure selected Web Vitals. Collection runs only on the canonical production host, honors Do Not Track, keeps its visitor identifier in memory, and disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording. PostHog receives the canonical route, bounded referral classification, browser performance measurements, a cookieless visitor identifier, and ordinary request metadata such as IP address, user agent, and time. Oompa sends no form values, account identity, provider or session data, URL query, or fragment. Vercel serves oompa.app, and GitHub hosts the source repository, releases, and release downloads; those providers receive ordinary request metadata when visited.

Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked.

Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion.

Codex activity remains subject to OpenAI's service and privacy terms. Claude Code activity remains subject to Anthropic's service and privacy terms.

> **Hosted sync status.** The hosted sync endpoint is live as an open beta. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Anyone can create an identity with an email address and a one-time code; an invitation is optional.

Report a suspected boundary violation through [private vulnerability reporting](https://github.com/hraness/oompa/security/advisories/new).
