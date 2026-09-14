# Provider accounts and automatic usage settings

In current source, `oompa usage auto` reads or changes this machine's automatic usage policy. A policy change does not call a provider, move an account or session, or enable an unavailable runtime capability.

## List cached provider accounts

Read the stored account order, default marker and readiness for one provider:

```sh
oompa account list --provider codex
oompa account list --provider claude --json
```

The provider-qualified result is versioned separately from the unchanged `oompa account list` profile listing. It includes the order and pointer revisions, provider account IDs, profile IDs and labels, and each account's last stored readiness observation. An unknown observation time stays unknown. Readiness is cached local evidence, not current sign-in proof or quota freshness. The default marker does not authorize dispatch or change an existing session's account.

Listing does not request a provider refresh or change account selection. It verifies at most 10,000 live profiles and returns at most 10,000 accounts, with a separate 3 MiB canonical JSON result limit. It refuses oversized or inconsistent snapshots instead of truncating them. Order/activation commands and provider refresh are not part of this listing.

## Read automatic usage policy

Read the current configuration and its revision:

```sh
oompa usage auto status
oompa usage auto status codex --json
```

The default begins on. Codex and Claude each have an `inherit`, `on`, or `off` override. An inherited setting follows the default; an explicit provider override wins even when the default is off. The default is not a global kill switch. Devin has no automatic usage policy.

## Change a setting

Each change requires the revision from status and a UUID idempotency key. The following example assumes the observed revision is 1 and the example key has not previously been used on this installation:

```sh
oompa usage auto off --revision 1 --idempotency-key 00000000-0000-4000-8000-000000000001
```

Use `on` or `off` without a provider to change the inherited default. Add `codex` or `claude` to change that provider's override. Use `inherit` with a provider to restore inheritance. Obtain the latest revision before each new change and use a new key:

```text
oompa usage auto off codex --revision <n> --idempotency-key <uuid>
oompa usage auto inherit claude --revision <n> --idempotency-key <uuid>
```

If a response is lost, replay the exact original command, including its key and revision. The response reports the configuration accepted by that request, even if later changes have occurred. Run status again to read the latest configuration. A conflicting revision changes nothing; inspect status before submitting a new request. Do not reuse a key for a different setting.

## What disabling does

Effective Codex disable suppresses new automatic reset-credit dispatches, including retries. An uncertain existing attempt retains its original key and remains recovery-pending. Disabling after durable reset admission does not cancel that provider operation or discard its result. Usage observation continues.

These controls do not yet provide automatic account movement or managed-send forwarding. Claude native fallback remains unavailable without its separate pinned live-acceptance proof. Existing explicit account selection is unchanged.

## Browser usage history

The grid's Usage history link opens daily Codex reports in Settings. Each machine archives at most one report per account every 24 hours. Reports for the same Codex account are grouped across machines; this does not establish current subscription capacity. The summary uses only reports no older than two hours with unexpired, complete windows. Missing quota details, a full capped limit list or a full account page leave coverage unknown. The legacy archive's `unlimited` bit can mean missing quota details, so it never proves full capacity. If any included account is unknown, the combined percentage is unknown. Dated expandable reports retain older window values and their absolute scheduled reset instants.

The legacy archive does not carry reset credits or trustworthy source-specific throughput. Claude usage is unavailable in this hosted feed. The app states those limits and does not infer live capacity, idle activity, forecasts or surplus from daily samples. A separate current-usage integration remains planned for both providers, including Claude's last-observed-turn freshness. The browser only reads; it never spends credits or changes an account.
