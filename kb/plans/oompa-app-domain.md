---
title: Oompa app domain cutover
tags:
  - delivery
  - compatibility
---

# Oompa app domain cutover

## Decision

The owner selected `oompa.app` on 2026-09-10, replacing the earlier `oompa.dev` choice before the first Oompa CLI release. The website uses `https://oompa.app` and the separate browser app uses `https://app.oompa.app`. Remove the earlier domain bindings without redirects or a compatibility origin. This decision supersedes earlier domain choices in the rename and web plans.

Keep repository and provider numeric identities, the existing backend, account identities, keys, data, state roots, and immutable releases. Existing versioned email bodies and completed historical receipts remain exact; they do not grant the earlier host current authority. Origin-bound browser keys are not exported or copied. The new origin uses normal enrollment and approval.

## Work and acceptance

1. Update current package and website links, canonical metadata, social card, analytics host, app proof, hosted setup input and alias operator. Reject the retired domain at current authority boundaries. Preserve retired operators and completed records as non-operational historical evidence.
2. Add attention body version 3 for the new app host while retaining v1 and v2 replay bytes. Run focused version, retry and malformed-input tests.
3. Publish a new immutable Suite Accounts registry release for the exact `oompa.app` callback. Keep stable `hra` product and client identifiers. Integrate it into Accounts only after artifact admission, with signed-flow, retired-origin refusal and historical email compatibility tests.
4. Validate the converged source with independent review, relevant local tests, compiled browser acceptance and fresh Required CI. Hold v0.8.0 tagging until this replacement candidate reaches reviewed main and passes its exact-main gate.
5. Inspect exact existing Vercel projects, domain ownership, DNS, deployed source and backend configuration. Record mutation intent and recovery evidence. Bind the new hosts to checked deployments, then remove old project-domain and alias bindings without adding redirects. Update only the existing canonical site configuration; do not rerun one-time hosted bootstrap or regenerate secrets.
6. Verify website canonical and app source markers, exact authentication callback/origin, relevant headers and health. Prove the retired hosts no longer serve or redirect the product. Refresh organization consumers against the new domain and record exact final heads.

## Status

Both new hosts are attached to their existing Vercel projects. Website and app promotions of reviewed main `011155e1f9d3092816abcad83cdc6d7b4559f980` completed with project, domain and unrelated alias preservation verified. Automatic custom-domain assignment remains disabled on both projects. The website's complete public source check passed; the app check exposed the deployment-settings mismatch described below. Old domain bindings remain until both complete canonical proofs pass. The immutable [v0.8.0 CLI artifact](https://github.com/hraness/oompa/releases/tag/v0.8.0) is published separately; it does not establish runtime or domain readiness.

The hosted `authority_reduction_hard_quota` hold remains. Domain and artifact delivery do not authorize daemon upgrades, new provider writers, or activation of the unfinished live usage meter.

The schema-3 API-shape repair merged with complete Required and main CI. It retains the bounded bulk-redirect page and versions reads, explicit empty firewall configuration, and before/after provider fences. Fresh app verification then refused the deployment list's sparse settings. A separate exact deployment read reported six build-setting fields but no historical root-directory or outside-root setting. Current project settings cannot fill those missing historical facts.

Schema 4 retains those source, project, deployment, routing and provider guards, records the six observed deployment settings, and leaves unavailable historical root settings unattested. Its hardened prove launcher first builds the exact clean source without provider credentials. The verifier joins the sealed complete app publication and compares every named public artifact and the canonical entry against those bytes. This equality does not establish that the server has no unlisted files. Failed builds or failed source revalidation retain their exact scratch scope for recovery. Existing schema-3 receipts do not become schema-4 evidence.

The schema-4 focused artifact, verifier, launcher and CI-equivalence suite passed 100 tests with 2,493 assertions; strict TypeScript checks, scoped lint and independent source review passed. Fresh Required CI, the real sealed build and default artifact reader, and complete canonical proof of the repaired merged source remain pending. No old domain binding has been removed, and no redirect has been added.
