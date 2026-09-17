# Contents

- `model.ts` owns the Zod schemas and types for signals, source health, the public snapshot, and the bounded history series consumed by the static `/pr/` route.
- `municipalities.ts` owns the 78-municipio gazetteer, Puerto Rico region slugs, NWS public and marine UGC zone mappings, and text-to-region tagging.
- `http.ts` is the collection boundary: HTTPS-only, byte-bounded, timeout-fenced fetches with one retry and optional lossy decoding for non-UTF-8 feeds.
- `parse.ts` owns bounded RSS 2.0 and Atom parsing plus visible-text HTML extraction on top of `linkedom`.
- `classify.ts` owns the deterministic Spanish/English keyword classifier, severity bumping, and stable signal ids.
- `source.ts` defines the adapter contract each upstream collector implements.
- `sources/` holds the registered collectors for official, infrastructure, scientific, regional, and news feeds. `sources/index.ts` is the registry.
- `pipeline.ts` runs sources concurrently under per-source budgets, normalizes, classifies, deduplicates, validates, and derives headline metrics and source health.
- `ai.ts` is the optional, environment-gated AI enrichment layer (Vercel AI Gateway or provider SDKs); it translates headings and summaries into Spanish, marks low-value signals as `noise`, and never replaces deterministic fields.
- `pulse.ts` is the CLI entry that collects and writes `pr/data/snapshot.json` and `history.json`.
- `resources.ts` owns the curated emergency-resource directory rendered by the route.
- `pr.test.ts` covers model validation, geography, classification, feed parsing, adapter fixtures, pipeline isolation, AI gating, and the resource directory.

# Guidelines

- The pulse runs only in the scheduled `pr-pulse` GitHub Actions job or manually. It is the single writer of `pr/data/`; the static site renders the committed JSON at build time with no build-time or runtime network access.
- `hraness.com/pr` is the canonical board: `vercel.json` permanently redirects `/pr`, `/pr/`, and `/pr/index.html` there at the edge. `/pr/data/snapshot.json` must keep serving with its CORS header — the native hraness board polls it as the live feed, so never let the redirect rules cover `pr/data/`.
- Every collector must fetch through `http.ts`, keep responses bounded, and surface failures as source health rather than aborting the pulse.
- Parse every upstream payload from `unknown` with Zod before it becomes a signal. Keep signal ids stable and bounded; dedupe by id.
- Keep all source and resource URLs HTTPS-only. Preserve each signal's source identity and link; media headlines are not authoritative without provenance.
- AI enrichment stays disabled unless `PR_PULSE_AI_PROVIDER` and a provider key are configured, and AI failure must never fail the pulse. Relevance demotion never applies to warning-or-higher signals.
- Severity and region inference are deterministic; prefer the source's own severity and zones and use `classifyText` only to fill gaps. Signals past `expiresAt` are dropped at collection time.
- Regenerate data only through `bun run pulse:pr`; never hand-edit `snapshot.json` or `history.json`.
