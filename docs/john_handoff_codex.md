# John Handoff - Codex Stabilization Notes

This pass focused on making the bot correct at the API boundary and safe by default before changing trading behavior further.

## Major Changes

### API boundary

- Broker payloads are normalized from tastytrade kebab-case into internal camelCase fields before strategy code sees them.
- Missing required fields now produce a visible `SKIP` reason instead of being treated as zero.
- Market-session parsing now reads the documented `open-at`, `close-at`, `close-at-ext`, `start-at`, and `state` fields.
- Equity options are treated as open only during the regular session, not extended hours.

### Symbol handling

- Order legs use OCC order symbols.
- Quote lookups use dxFeed streamer symbols.
- Existing positions preserve both `orderSymbol` and `quoteSymbol` so close orders and quote subscriptions do not get mixed up.

### Order safety

- All live-capable order paths go through `placeOrderSafely()`.
- Orders dry-run first by default.
- Live submits require both:
  - `config/trading-bot.config.json`: `liveOrders.enabled: true`
  - environment: `BOT_ENABLE_LIVE_ORDERS=true`
- Default behavior is sandbox plus live orders off.
- `bot:panic` disables live orders for the running process, stops the scheduler, and attempts to cancel live orders.

### Strategy safety

- Trading-time logic is based on the configured trading timezone, default `America/Los_Angeles`.
- Calls and puts are selected independently with the correct ITM logic.
- Long and short return math is direction-aware.
- The bot does not average into material losing positions by default.
- DTE fallback is off by default.
- Liquidity gates use separate day volume and open interest fields.
- End-of-day liquidation uses intentionally marketable limit prices.

### Operations

- Startup prints a safety banner with environment, profile, live-order state, liquidity gates, and config path.
- IPC has `config:show` and `config:reload`.
- IPC client requests time out instead of hanging forever.
- Logs redact account-like numbers by default.
- Last-run state persists to `data/last-run-state.json` and loads on boot.
- Run history remains tail-readable and is pruned by default.

## Commands Worth Knowing

```bash
node run config:show
node run config:reload
node run bot:getRunCyclePreview
node run bot:runCycle
node run bot:panic
node run core:cancelAllLiveOrders
```

## Go-Live Checklist

The owner-specific checklist is in `docs/john_to_verify.markdown.md`.

Do not enable live orders until these are done:

1. Run `npm run typecheck`, `npm test`, and `npm run build`.
2. Run `node run config:show` and confirm the startup safety state says sandbox and live orders off.
3. Run a full sandbox dry-run cycle.
4. Pull one real sandbox position payload and verify `average-open-price` units.
5. If `average-open-price` is per contract, set `strategy.costBasisUnit` to `perContract`.
6. Confirm no unexpected `SKIP` reasons in preview or last-run state.
7. Only then set both live-order interlocks for one supervised tiny live order.
8. Re-arm the scheduler only after the supervised live behavior is confirmed.

## Hard Open Question

`strategy.costBasisUnit` defaults to `perShare`. That is intentionally conservative based on the sanitized fixture, but it must be verified against a real tastytrade sandbox positions payload before live trading. If tastytrade returns `average-open-price` per contract instead, returns will be wrong until the config is flipped to `perContract`.
