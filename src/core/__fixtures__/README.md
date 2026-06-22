# Sanitized Broker Fixtures

These fixtures are small offline samples shaped like tastytrade/dxFeed read-only payloads. Account identifiers are synthetic and no token, secret, or full account number is present.

- `market-session-current.json`: shaped like `GET /market-time/equities/sessions/current`, captured for parser truth around `open-at`, `close-at`, `close-at-ext`, `start-at`, and `state`.
- `positions.json`: shaped like `GET /accounts/{account_number}/positions`. The option `average-open-price` is represented as a per-share price, matching the bot default `strategy.costBasisUnit: "perShare"`.
- `balances.json`: shaped like `GET /accounts/{account_number}/balances`.
- `option-chain.json`: shaped like `getNestedOptionChain()` with call/put OCC symbols and dxFeed streamer symbols.
- `quote-events.json`: minimal dxFeed quote events for bid/ask tests.
- `option-liquidity-events.json`: minimal dxFeed summary/profile-style events carrying `dayVolume` and `openInterest` separately.
