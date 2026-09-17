# Hosted autorespond and prepaid credits

Prose autorespond answers a completed assistant turn that asks only for consent. Until now it ran only with a Vercel AI Gateway key the person pasted in with `oompa autorespond gateway set`. In current source a second responder exists: Oompa's hosted backend answers the same approvals and meters each reply against prepaid Hraness credits held by this device, so no gateway key is needed. The bring-your-own-key path is unchanged; the two are exclusive, and local custody selects one.

## Choose the hosted responder

```sh
oompa autorespond gateway set --hosted
```

The command stores a selection marker in the same user-only secret custody that holds a gateway key, and drops any stored key. `oompa autorespond gateway set` with a key drops the hosted selection again. `oompa autorespond gateway clear` drops both. `oompa autorespond status` reports `gateway` (whether a key is stored) and `responder` (`gateway-key`, `hosted`, or `not configured`); with the hosted responder it also reports `credits`.

Every other prose gate is unchanged: the approval cue, the human-action and denylist cues, the 4,000-character bound, the pending-interaction check, budgets of 3 consecutive, 10 per hour, and 40 per day, and the verbatim substring check. The daemon still sends only the fixed approval sentence or a literal proven byte-exact inside the assistant's own message.

## What one reply costs

One credit is one cent. Balances are kept as integer micro-dollars that never round; people see dollars and agents read both forms. A reply is priced by the credits service from the cost the gateway reports for that call, or from the published list price of the tokens it used when it reports none. Before the call the backend places a hold no lower than one credit and no higher than fifty cents, sized from the prompt and the responder's output budget with a 1.25 uplift; settlement charges the priced amount and returns the rest. A reply that fails releases the hold. A hold the backend cannot settle expires on its own, uncharged.

`oompa credits estimate assistant_reply` reports that the operation is priced at settlement; there is no fixed unit price to show.

## Add credits

```sh
oompa credits topup --usd 25
```

This prints a payment link for the hosted pay page. The page offers packs of $10, $25, $50, and $100 and shows the credits each pack adds, including any bonus credits that apply to the purchase; payment completes through Stripe Checkout, and Oompa never handles card details. After paying:

```sh
oompa credits wait
```

`wait` polls the link every five seconds for up to fifteen minutes (`--timeout 90s` and similar adjust it) and stores the device token that the first purchase issues. The token lives in `$XDG_STATE_HOME/hraness/credits/oompa.json` (or `~/.local/state/hraness/credits/oompa.json`), a user-only file; the daemon reads it for each hosted request and no command prints it. `oompa credits status` shows the balance, anything held for a reply in progress, and a link to add more. `oompa credits email --to <address>` asks the service to send the pending link (at most two sends per link). `oompa credits signout` forgets the token on this device. `oompa credits protocol --json` describes all of this for agents.

Exit codes for `oompa credits`: `0` success; `1` state unavailable, busy, or service unreachable; `2` usage error, invalid id, or expired link; `3` payment still required after `wait` timed out. `OOMPA_CREDITS_SERVICE_ORIGIN` overrides the service origin for local testing.

## When credits run out

When the backend answers a reply with `402 credits_required`, the daemon records `gate_failed:credits_required` evidence, escalates that turn to the human like any other refused prose approval, and pauses the hosted responder. The pause is held in memory only: it lifts when `oompa autorespond gateway set --hosted` or `gateway set` runs again, when the daemon restarts, or after fifteen minutes, when the next approval tries the service once more. A device with no credits token pauses the same way without calling the backend.

While paused, `oompa autorespond status` reports the shortfall instead of a plain status: with `--json` it writes the ordinary failure envelope with `error.code: "credits_required"` to stdout and exactly one `hraness-credits-required-v1` line to stderr; without `--json` it writes the same handoff as a few plain lines. Its `resume.argv` is `oompa autorespond gateway set --hosted`, which lifts the pause. The handoff and the agent steps are documented in [the agent skill](../skills/oompa/references/credits.md). The command exits `1`.

## The hosted route

The daemon calls `POST /v1/autorespond` on the HTTP host of the Convex deployment that serves hosted sync (`https://<deployment>.convex.site`, derived from the configured deployment URL), with the credits device token in the `x-hraness-credits-subject` header and a bounded JSON body: the last 4,000 characters of the assistant message, the session state and approval cue, whether a verbatim literal is required, that literal, and the deterministic replay identity of the turn. Bodies above 16 KiB are refused. The credits token is the route's only authentication: nothing reaches the gateway before a hold succeeds for a token the service recognises.

The backend holds `assistant_reply` keyed by the turn's replay identity, so a retried request reuses one hold, sends the gateway the same chat-completions request the local responder sends, settles with a `model_tokens` cost row (`reported`, `contractual` from list price and measured tokens, or `estimated`), and answers with the model, the reply, the latency, and what was charged. Responses above 64 KiB, replies above 2,000 characters, and responses outside the contract are refused by the daemon, which then escalates the turn.

Errors: `402 credits_required` carries `reason` (`insufficient_credits` with the service's `required`, `balance`, and `topup` fields; `subject_missing`; `subject_rejected`), `413` and `415` for oversized or non-JSON bodies, `400` for a body outside the contract, `502 responder_failed` after the hold was released, `502` or `503 credits_unavailable` when the credits service failed or could not be reached, and `503 hosted_autorespond_unavailable` when the deployment is not configured.

## Deploy the backend

The route ships with the hosted sync deployment; the ordinary `bun run hosted:deploy` sequence in [hosted sync](hosted-sync.md) installs it. It stays inert (`503`) until the deployment carries three variables, listed with comments in [`.env.example`](../.env.example):

| Variable | Value |
| --- | --- |
| `OOMPA_CREDITS_SERVICE_ORIGIN` | `https://credits.hraness.com`, the credits service origin. |
| `OOMPA_CREDITS_PRODUCT_KEY` | The `cr_prod_` key the credits service issued for product id `oompa`. |
| `AI_GATEWAY_API_KEY` | The operator's Vercel AI Gateway key used for hosted replies. |

Set them with `npx convex env set <NAME> <value>` against the exact deployment; never through a checked-in file. The product `oompa` and its operations `assistant_reply` (priced at settlement) and `model_tokens` are configured on the credits service. Verify after deployment with one hosted reply from a device that holds credits, then read `oompa credits status` to see the charge. The cost registry entries `route:/v1/autorespond` and `provider:vercel-ai-gateway:assistant_reply` in `costs.json` record the route's bounds.

## Limits

- The hosted responder needs the hosted backend to be reachable; a failed or slow call escalates the turn to the human and is never retried on the human's behalf.
- One device token belongs to one wallet. Another machine needs its own purchase, or a link created from a device that already holds the token.
- A `402` pauses hosted autorespond on this machine; protocol approvals and the gateway-key path are unaffected.
- The browser app's `set_gateway_key` command still stores a key; it does not select the hosted responder.
