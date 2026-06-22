# API Connectivity Review - Codex

This answers the primary question: "are there any bugs in how it connects to the API?"

Short version: the repo is using the current `@tastytrade/api` v7 OAuth style correctly at a high level, but there are several real API-shape and streaming issues that can make the bot behave incorrectly.

## Sources Checked

- Local source: `src/core/*`, `src/bot/*`, `package.json`, `package-lock.json`
- Installed SDK after `npm ci`: `@tastytrade/api@7.0.2`
- Official tastytrade docs:
  - https://developer.tastytrade.com/
  - https://developer.tastytrade.com/open-api-spec/market-sessions/
  - https://developer.tastytrade.com/open-api-spec/orders/
  - https://developer.tastytrade.com/open-api-spec/instruments/
  - https://developer.tastytrade.com/streaming-market-data/
  - https://developer.tastytrade.com/order-submission/
- SDK repo/docs:
  - https://github.com/tastytrade/tastytrade-api-js
  - https://github.com/tastytrade/tastytrade-api-js/blob/master/UPGRADING.md

I did not use account credentials or run live authenticated trading calls.

## What Looks Correct

- `@tastytrade/api` v7 is being used with OAuth inputs: `clientSecret`, `refreshToken`, and `oauthScopes`. That matches the SDK v7 guidance, which removed session-login usage.
- The SDK automatically generates and refreshes access tokens.
- The nested option chain call maps to the official `/option-chains/{symbol}/nested` endpoint through `instrumentsService.getNestedOptionChain(symbol)`.
- Account balance parsing is relatively defensive: `src/core/account-balance.ts` checks both snake_case and official kebab-case field names.
- `seedSymbol()` does the right basic safety pattern by calling `postOrderDryRun()` before submitting a live order.

## High Priority API Bugs

### 1. Market-session parser probably never sees the official fields

Official `GET /market-time/equities/sessions/current` returns fields like:

- `open-at`
- `close-at`
- `close-at-ext`
- `start-at`
- `state`

The local parser in `src/core/market-sessions.ts` mostly looks for different names:

- `opens-at`
- `closes-at`
- `session-status`
- `is-open`

Because of that, `getCurrentEquitiesSession()` can return `isOpen: false` and `isRegularSession: false` even during the regular market session. That would keep the scheduler waiting forever or make scheduler status misleading.

File references:

- `src/core/market-sessions.ts:153`
- `src/core/market-sessions.ts:165`
- `src/core/market-sessions.ts:172`
- `src/core/market-sessions.ts:180`

Suggested fix direction:

- Read `state`.
- Read `open-at` and `close-at`.
- Treat regular session as `now >= open-at && now < close-at`.
- Treat extended close separately with `close-at-ext`, but do not count it as equity-options open unless that is intentional.

### 2. Position objects are typed as snake_case, but the API returns kebab-case

The SDK response helper unwraps `data` but does not convert keys. The official position fields include:

- `account-number`
- `instrument-type`
- `underlying-symbol`
- `quantity-direction`
- `mark-price`
- `average-open-price`
- `cost-effect`
- `streamer-symbol`

The project types and much of the code expect:

- `account_number`
- `instrument_type`
- `underlying_symbol`
- `quantity_direction`
- `mark_price`
- `average_open_price`
- `cost_effect`

This can affect:

- grouping by underlying
- detecting long vs short
- deciding close order action
- selecting quotes
- computing cost basis and returns
- normalizing instrument type for orders

File references:

- `src/core/types.ts:55`
- `src/bot/evaluate-position.ts:29`
- `src/bot/evaluate-position.ts:53`
- `src/bot/actions/order-utils.ts:28`
- `src/bot/actions/order-utils.ts:113`

Suggested fix direction:

- Add a normalization layer immediately after API reads, or make every position helper read both kebab-case and snake_case.
- Do not rely on TypeScript interfaces to imply runtime shape.

### 3. Production REST is mixed with sandbox account streamer config

`.env.example` defaults REST to production:

```text
BASE_URL=https://api.tastyworks.com
```

But `src/core/tastytrade-client.ts` hard-codes:

```ts
accountStreamerUrl: "wss://streamer.cert.tastyworks.com/streamer"
```

The SDK's own config uses:

- production: `wss://streamer.tastyworks.com`
- sandbox: `wss://streamer.cert.tastyworks.com`

No `/streamer` suffix is present in the SDK config. The current bot mostly uses quote streaming, whose URL comes from `/api-quote-tokens`, so this may not break current quote calls. It will matter if account streaming is used later.

File reference:

- `src/core/tastytrade-client.ts:6`

Suggested fix direction:

- Use `TastytradeClient.ProdConfig` or `TastytradeClient.SandboxConfig`.
- Make REST base URL and account streamer URL come from the same environment selection.

## Medium Priority API Issues

### 4. Quote streamer connections are opened repeatedly and not disconnected

`withQuoteSubscription()` calls `tastytradeApi.quoteStreamer.connect()` for every quote request, then unsubscribes the symbols but does not disconnect the quote streamer.

File reference:

- `src/core/market-data.ts:75`

The SDK's quote streamer creates a new DXLink feed on connect. Repeated calls from position evaluation and option selection could leak connections or listeners, especially in a loop that runs every few minutes.

Suggested fix direction:

- Either maintain one quote streamer connection for the process, or disconnect in a `finally` block when the helper owns the connection.
- Avoid concurrent helpers fighting over a global quote streamer.

### 5. Option "volume" is not really volume

`fetchOptionVolumes()` aggregates several unlike DXLink fields into one number:

- trade `size`
- cumulative `dayVolume`
- quote `bidSize`
- quote `askSize`
- `openInterest`

That can double-count cumulative values and confuse quoted size/open interest with traded volume.

File references:

- `src/core/option-service.ts:115`
- `src/core/option-service.ts:126`

Suggested fix direction:

- Decide whether the strategy wants current-day traded volume, open interest, or displayed quote size.
- Subscribe only to the event types needed for that metric.
- Do not sum repeated cumulative `dayVolume` events.

### 6. Stream subscriptions are broader than needed

The SDK subscribes to all event types if no types are passed. The bot does that in both quote and volume code.

File references:

- `src/core/market-data.ts:113`
- `src/core/option-service.ts:196`

For bid/ask, use Quote events only. For volume, use Trade and/or Summary intentionally.

### 7. Order price is a string, but API schema says number

The helper returns prices as strings:

```ts
return (Math.round(price * 100) / 100).toFixed(2);
```

The OpenAPI schema says `price` is a number, but the order-submission guide examples show string prices. This is likely accepted, but it should be confirmed with dry-run for all order paths, not just `seedSymbol()`.

File references:

- `src/bot/actions/order-utils.ts:82`
- `src/bot/actions/manage-allocation.ts:199`
- `src/bot/actions/close-position.ts:37`

Suggested fix direction:

- Run `postOrderDryRun()` for allocation and close orders before live submission.
- If dry-run complains about price type, change `roundOrderPrice()` to return a number.

## Bottom Line

The basic OAuth client initialization is on the right track. The bigger API problem is runtime response shape: market sessions and account positions appear to be parsed with names that do not match official kebab-case API responses. Fix those before judging strategy performance.
