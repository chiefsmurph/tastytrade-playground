# Trading Bot Configuration

Config is plain JSON on purpose. Comments live here instead of inside the config file.

Default path:

```text
config/trading-bot.config.json
```

Override path:

```bash
TASTYTRADE_BOT_CONFIG=/absolute/path/to/trading-bot.config.json
```

Secrets stay in `.env`:

```text
API_CLIENT_SECRET
API_REFRESH_TOKEN
BOT_ENABLE_LIVE_ORDERS
TASTYTRADE_BOT_SOCKET
```

## Top-Level Fields

`environment`
: `sandbox` or `production`. Default is `sandbox`. This chooses the SDK base URLs.

`profile`
: Selects one profile from `profiles`. Current options in the committed config are `conservative`, `balanced`, and `aggressive`.

`profiles`
: Named partial config blocks. The selected profile is applied first, then the top-level values override it. This lets John switch posture without editing every field.

## Live Orders

`liveOrders.enabled`
: Config-side live-order interlock. Must be `true` before live submits can happen.

`liveOrders.requireEnvFlag`
: When `true`, `BOT_ENABLE_LIVE_ORDERS=true` is also required.

`liveOrders.alwaysDryRunFirst`
: When `true`, every order path calls tastytrade dry-run before any live submit.

Live submit requires both:

```text
liveOrders.enabled=true
BOT_ENABLE_LIVE_ORDERS=true
```

## Strategy

`strategy.timezone`
: Timezone used for trading-day decisions. Default is `America/Los_Angeles`.

`strategy.enabledSides`
: Allowed option sides, usually `["call", "put"]`.

`strategy.allocationPriority`
: `underweightThenBestReturn` allocates to lower-exposure groups first, then better returns. `bestReturn` ranks by return first.

`strategy.allowAddingToLosingPositions`
: Default `false`. Prevents silent averaging down.

`strategy.maxLossForNewAllocationPct`
: If adding to losing positions is not allowed, positions at or below this return are skipped for new allocation. Default `-0.05`.

`strategy.allowDteFallback`
: Default `false`. When false, if no expiration is inside the requested DTE window, the bot skips instead of grabbing the nearest expiration.

`strategy.marketOpenTime`
: Start of the strategy schedule in configured timezone. Default `06:30`.

`strategy.allocationCutoffTime`
: Time after which new allocation target goes risk-off. Default `12:30`.

`strategy.liquidationTime`
: Time at which the strategy emits `LIQUIDATE_POSITION`. Default `12:55`.

`strategy.costBasisUnit`
: `perShare` or `perContract`. Must be verified against a real sandbox position payload before live trading.

## Liquidity

`liquidity.minDayVolume`
: Minimum option day volume required for a candidate. Default `120`.

`liquidity.minOpenInterest`
: Minimum open interest required. Default `0`.

The bot tracks day volume and open interest separately. It no longer mixes bid size, ask size, trade size, volume, and open interest into one number.

## Liquidation

`liquidation.mode`
: `marketableLimit` or `weightedLimit`. Default is `marketableLimit`.

`liquidation.slippageTicks`
: Extra ticks used to cross the spread for end-of-day liquidation. Default `2`.

For end-of-day liquidation:

- Buy-to-close uses ask plus configured ticks.
- Sell-to-close uses bid minus configured ticks.

## Scheduler

`scheduler.openIntervalMs`
: Cycle interval while the regular equity-options session is open. Default `240000`.

`scheduler.closedIntervalMs`
: Check interval while the market is closed. Default `60000`.

Existing env overrides still work:

```text
BOT_RUN_INTERVAL_MS
BOT_RUN_INTERVAL_MINUTES
```

## Logging

`logging.redactAccountNumbers`
: Default `true`. Account-like numeric strings are redacted in logs.

`logging.logRawBrokerPayloads`
: Default `false`. Keep this off unless debugging parser assumptions.

## Runtime Commands

```bash
node run config:show
node run config:reload
node run bot:panic
```

`config:reload` reloads JSON config and updates the SDK client config in the running process. If the strategy changed materially, prefer a restart after confirming `config:show`.

`config:reload` refuses sandbox-to-production or production-to-sandbox switches. Restart the process for environment changes.

`bot:panic` is process-local. It disables live orders for the running process, stops the scheduler, and tries to cancel live orders. It does not edit the JSON file. Re-arming after panic requires a process restart.
