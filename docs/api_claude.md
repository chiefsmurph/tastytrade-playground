# API Connectivity & Correctness (Claude)

> **This is the answer to John's primary question:** *"Are there any bugs in how it connects to the API?"*
>
> Verified against: the published `@tastytrade/api` SDK source (`tastytrade/tastytrade-api-js`), the [Tastytrade developer docs](https://developer.tastytrade.com/), and the [dxfeed QD event model](https://kb.dxfeed.com/en/data-model/qd-model-of-market-events.html). Read-only review; no source files changed.

## Verdict

**Connection and auth: correct. Market-data plumbing: one critical bug + one conceptual bug.**

The bot talks to Tastytrade through a single shared client ([tastytrade-client.ts](../src/core/tastytrade-client.ts)). REST goes through the SDK services (accounts, balances/positions, instruments, orders); live prices come from the dxfeed **quote streamer**. The REST half is clean. The streamer half is where the bugs live.

---

## 🔴 The auth question, settled

I went in expecting an auth bug — "the client is constructed but nothing calls `login()`, so every request will 401." **That suspicion is wrong, and it's worth telling John explicitly that he got this right.**

- `@tastytrade/api@7.0.2` is the **current** JS SDK (npm `latest`, published 2026-05-17). OAuth (`clientSecret` + `refreshToken` + `oauthScopes`) became *required* in 7.0.
- The SDK's HTTP client checks whether the access token is empty/expired and POSTs `/oauth/token` (`grant_type=refresh_token`) **before each request automatically**. No manual session/login is needed and REST calls will not 401 for lack of one.
- `quoteStreamer.connect()` internally calls `GET /api-quote-tokens` (itself an authed REST call that rides the same auto-refresh), reads the `dxlink-url` + token, and opens the WebSocket. So the streamer doesn't need any manual token wiring either.

> ⚠️ **Don't confuse the two SDKs.** The "more API docs" link John told us to ignore — `tastyworks-api.readthedocs.io` (v11/v12) — is the **Python** library, a *different* package. This repo uses the **JavaScript** `@tastytrade/api` at **v7.0.2**. Any worry that "OAuth was only added in v12" is a version-number collision between the two libraries; it does not apply here.

The only auth-adjacent gap is **no startup validation** of the env vars (below, `api-11`).

---

## Findings

### 🔴 api-1 — Quote streamer is fed the OCC order symbol instead of the dxfeed streamer symbol (allocation path)
**Severity: Critical · Confidence: High · [manage-allocation.ts:315](../src/bot/actions/manage-allocation.ts#L315), [option-contracts.ts:118](../src/bot/option-contracts.ts#L118)**

`manage-allocation` prices the chosen contract with `getBidAskForSymbol(candidate.symbol, 3000)`. But `candidate.symbol` is set from `strike.call` — the **OCC** symbol (e.g. `AAPL  240119C00150000`). The dxfeed quote streamer only emits events for **streamer symbols** (e.g. `.AAPL240119C150`), which live in the *separate* `call-streamer-symbol` / `put-streamer-symbol` fields. The streamer never emits an event whose `eventSymbol` matches the OCC string, so:

> `getBidAskForSymbol` always times out → returns `null` → bid/ask treated as 0 → `buildRouteOrders` filters out every route → the function returns "candidate quote unavailable" on essentially every allocation.

**The entire `MANAGE_ALLOCATION` trade path is dead-on-arrival.** Tellingly, [seed-symbol.ts:151](../src/bot/seed-symbol.ts#L151) does this **correctly** — it quotes with the streamer symbol and uses the OCC symbol only for the order leg. The two paths disagree, which is the strongest evidence this is an oversight, not intent.

**Fix:** in `manage-allocation`, quote with `candidate.streamerSymbol` (the `*-streamer-symbol`) and keep `candidate.symbol` (OCC) only for the order leg — exactly as `seed-symbol` already does.

---

### 🟠 api-2 — Option "volume" sample sums per-event sizes; it is not volume
**Severity: High · Confidence: High · [option-service.ts:118](../src/core/option-service.ts#L118)**

`fetchOptionVolumes` subscribes to option streamer symbols for 5 seconds and, for each event, reads `ev.size ?? ev.volume ?? ev.v ?? ev.tradeVolume` **first**, then does `volumes[symbol] += parsed.volume`. Against the dxfeed model:

- A **Quote** event has no `size` field (only `bidSize`/`askSize`).
- A **Trade** event's `size` is a *single trade's* size, not cumulative — summing them over 5s yields an arbitrary number that depends on how many ticks happened to arrive.
- Cumulative **day volume** is `dayVolume` (Trade/Summary); **open interest** is `openInterest` (Summary). The code only falls back to `dayVolume` if `size` is absent, and mislabels `bidSize`/`askSize`/`openInterest` as "volume" in its other branches.

`subscribe()` with no type filter subscribes to *all* event types, so the result is a meaningless blend — and it gates candidate selection via `MIN_VOLUME = 120`. The `Array.isArray(ev)` scraping branch is **dead code** (see api-7: dxlink delivers objects, not arrays).

**Fix:** subscribe specifically to **Summary** (and/or Trade), read `dayVolume` as a *snapshot* (don't sum), and read `openInterest` from Summary if you want OI. Drop the size/bidSize/askSize branches and the array fallback. *(This is half API-correctness, half strategy — it determines which contracts are even eligible.)*

---

### 🟡 api-3 — `accountStreamerUrl` hardcoded to the cert/sandbox endpoint while REST is prod
**Severity: Medium · Confidence: High · [tastytrade-client.ts:8](../src/core/tastytrade-client.ts#L8)**

`baseUrl` comes from `BASE_URL` (prod `api.tastyworks.com`), but `accountStreamerUrl` is hardcoded to `wss://streamer.cert.tastyworks.com/streamer` — the **sandbox** streamer, with an extra `/streamer` path the SDK never uses. The SDK's `ProdConfig` pairs prod REST with `wss://streamer.tastyworks.com`.

**This is inert today** — nothing in the repo calls the *account* streamer (`accountStreamer.connect()`), so it never connects. But it's a live landmine: the moment anyone wires up live order/position updates, it'll try to connect to sandbox with a prod token and fail. (Note: this is the **account** streamer; the **quote** streamer is unaffected because its URL comes from `/api-quote-tokens` at connect time.)

**Fix:** build the client from `...TastytradeClient.ProdConfig` and override only the secrets, so the two URLs can never diverge.

---

### 🟡 api-8 — Quote streamer connects on every lookup and never disconnects (leak)
**Severity: Medium · Confidence: Medium · [market-data.ts:80](../src/core/market-data.ts#L80)**

`withQuoteSubscription` calls `quoteStreamer.connect()` on **every** `getBidAskForSymbol`/`getUnderlyingPrice`, but cleanup only `unsubscribe`s and removes the listener — it never `disconnect()`s. Each `connect()` builds a fresh `DXLinkWebSocketClient` + `DXLinkFeed` and re-attaches all accumulated listeners, so over a long-running bot you accumulate WebSocket connections and duplicated event handling. ([option-service.ts:202](../src/core/option-service.ts#L202) *does* call `disconnect()` — so, again, two paths disagree.)

**Fix:** connect once and reuse (guard `connect()` so it only runs when not already connected), and `disconnect()` when idle — or at minimum mirror `option-service` and disconnect after each sample.

---

### 🟢 api-4 — Equity symbols normalized to `.AAPL` for the streamer
**Severity: Low · Confidence: Medium · [market-data.ts:11](../src/core/market-data.ts#L11)**

`normalizeCandidates` subscribes to `[symbol, '.'+symbol, symbol.replace('/', '.')]` and the matcher strips dots, so equity quotes still match by accident of permissiveness. But the SDK example subscribes equities as **plain** tickers (`AAPL`, no dot); the leading dot is the convention for **indices/options**. For a true index (e.g. `SPX`) the dotted form is the *correct* one and the plain form is wrong — the shotgun approach masks the distinction.

---

### 🟢 api-10 — `AccountBalance` type declares snake_case keys the API never returns
**Severity: Low · Confidence: High · [types.ts:3](../src/core/types.ts#L3), [account-balance.ts:3](../src/core/account-balance.ts#L3)**

`GET /accounts/{a}/balances` returns **kebab-case** (`net-liquidating-value`, `derivative-buying-power`, `pending-cash-effect`) and the SDK does not transform response keys. The `AccountBalance` interface declares snake_case keys that don't exist on the wire. It works today only because `getAccountBalanceNumber(balance, snakeKey, kebabKey)` reads both and falls back to kebab. The trap: future code reading `accountBalance.net_liquidating_value` directly gets `undefined`.

**Fix:** retype `AccountBalance` with the real kebab-case keys (or normalize responses), and keep all reads going through the dual-key helper.

---

### 🟢 api-11 — Env vars cast `as string`, no startup validation
**Severity: Low · Confidence: High · [tastytrade-client.ts:7](../src/core/tastytrade-client.ts#L7)**

`process.env.BASE_URL as string` etc. is a compile-time cast only. If any is unset, the value is `undefined` at runtime and you get an opaque failure at the first request (`Missing required parameters to generate access token`), not a clear boot error. Validate the three vars at module load and throw a descriptive error. *(Also flagged from the ops angle as arch-5.)*

---

## ✅ What's verified correct (tell John these are good)

| API call | Verdict | Note |
|----------|---------|------|
| `new TastytradeClient({ baseUrl, accountStreamerUrl, refreshToken, clientSecret, oauthScopes })` | ✅ correct | Constructor signature & OAuth fields right (streamer URL value is wrong-env but never used — api-3) |
| OAuth access-token auto-refresh (no explicit login) | ✅ correct | `executeRequest` → `generateAccessToken` (`POST /oauth/token`) before each request |
| `accountsAndCustomersService.getCustomerAccounts()` | ✅ correct | `GET /customers/me/accounts`; `accounts[0].account['account-number']` is right |
| `balancesAndPositionsService.getAccountBalanceValues(acct)` | ✅ correct | `GET /accounts/{a}/balances`; kebab-case (read via dual-key helper) |
| `balancesAndPositionsService.getPositionsList(acct)` | ✅ correct | `GET /accounts/{a}/positions` |
| `instrumentsService.getNestedOptionChain(sym)` | ✅ correct | `GET /option-chains/{s}/nested`; returns an **array** — `data.length`/`data[0]` is right |
| `orderService.createOrder(acct, order)` | ✅ correct | `POST /accounts/{a}/orders`; payload matches the documented schema; legs use OCC (correct) |
| `orderService.postOrderDryRun(acct, order)` | ✅ correct | `POST .../orders/dry-run` |
| `orderService.getLiveOrders(acct)` | ✅ correct | `GET .../orders/live` |
| `orderService.cancelOrder(acct, id)` | ✅ correct | `DELETE .../orders/{id}` |
| `quoteStreamer.connect/subscribe/addEventListener/unsubscribe/disconnect` | ✅ correct *calls* | Listener receives event **objects** (`eventType`/`eventSymbol`/`bidPrice`/`askPrice`) — field access matches the SDK example; array fallbacks are harmless dead code |
| Harvesting option volume from quote events | 🔴 incorrect | See api-2 |
| `accountStreamer` (cert URL) | ⚠️ suspect | Wrong-env config, but never connected (api-3) |

Other things done well: the order payload exactly matches the documented Tastytrade order schema (`order-type`, `price`, `price-effect`, `time-in-force`, `legs[action/symbol/instrument-type/quantity]`, `source`, `advanced-instructions`); `cancelAllLiveOrders` correctly drives `getLiveOrders → cancelOrder` and guards on cancellable/terminal status; and `seed-symbol` models the *correct* OCC-vs-streamer-symbol pattern that `manage-allocation` should copy.

---

## Open questions for John (API)

1. **Has the `MANAGE_ALLOCATION` path ever actually placed an allocation order**, or do the logs always say "candidate quote unavailable"? (api-1 predicts it's never traded successfully.)
2. **What is `MIN_VOLUME = 120` supposed to mean** — true session volume, day volume, or open interest? The current sampler measures none of those (api-2).
3. **Do you intend to ever connect the *account* streamer** for live order/position updates? If so, the cert URL needs fixing now (api-3); if not, it's dead config that should be removed to avoid confusion.
4. **Was a single persistent quote-streamer connection the intent?** Today it reconnects per lookup and never disconnects (api-8).
5. **Will the bot ever quote a true index** (SPX/VIX)? The `.AAPL` normalization works for equities by accident but is wrong for indices (api-4).

### Sources
- [tastytrade/tastytrade-api-js (SDK source)](https://github.com/tastytrade/tastytrade-api-js)
- [@tastytrade/api on npm](https://www.npmjs.com/package/@tastytrade/api)
- [Tastytrade developer docs — streaming market data](https://developer.tastytrade.com/streaming-market-data/)
- [dxfeed QD model of market events](https://kb.dxfeed.com/en/data-model/qd-model-of-market-events.html)
