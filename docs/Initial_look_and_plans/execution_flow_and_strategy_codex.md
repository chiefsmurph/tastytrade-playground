# Execution Flow and Strategy Review - Codex

This file summarizes what the bot is doing and where the strategy/runtime logic can misfire.

## What The Bot Is Trying To Do

The repo is a local IPC-controlled tastytrade options bot.

At a high level:

1. `src/index.ts` starts the IPC server.
2. If `BOT_RUN_ON_SCHEDULE=true`, it starts the market-open scheduler.
3. The scheduler checks tastytrade's equity market session endpoint.
4. During regular equity market hours, it runs `runBotCycle()` every configured interval, defaulting to four minutes.
5. A run cycle fetches account balances, positions, quotes, option chains, and candidate contracts.
6. It decides whether each grouped underlying should be closed or allocated into.
7. It cancels live orders, submits close orders, submits allocation orders, records run history, and updates in-memory last-run state.

Manual control happens through IPC commands in `src/ipc-server.ts`, such as:

- `bot:getRunCyclePreview`
- `bot:runCycle`
- `bot:seedSymbol`
- `core:cancelAllLiveOrders`
- `bot:startMarketOpenScheduler`

## Execution Order

Current run-cycle order:

1. Resolve account number.
2. Fetch account balance.
3. Fetch and group positions by underlying.
4. Fetch bid/ask quotes for each position.
5. Compute current return for each underlying group.
6. Build time-of-day execution targets.
7. Build starting budget from derivative buying power and effective capital.
8. Build a dry-run allocation plan for logging/preview.
9. Cancel live orders.
10. Log snapshot, group returns, and plan.
11. Execute position evaluations:
    - cancel live orders again
    - submit close orders
    - submit allocation orders
12. Append run history.
13. Save last-run state in memory.

File references:

- `src/bot/run-cycle.ts:187`
- `src/bot/run-cycle.ts:309`
- `src/bot/execute-position-evaluations.ts:92`
- `src/bot/execute-position-evaluations.ts:120`
- `src/bot/run-history.ts:64`

## Good Ideas Already Present

- Uses a market-session endpoint instead of guessing market hours.
- Has explicit take-profit and loss-floor gates.
- Has an end-of-day liquidation intent.
- Uses buying power and target exposure to cap allocation.
- Sorts allocation candidates by worse current return first.
- Uses `strict-position-effect-validation` for closing orders.
- Has an IPC preview command, which is useful for inspection before running live.

## High Priority Bugs and Risks

### 1. Time-of-day strategy uses host-local time, not Pacific time

The code and README describe Pacific-time behavior, but the main execution path uses `new Date()` and `getHours()`.

On this machine, the timezone is America/Chicago. That means a 12:30 Pacific risk-off rule can fire around 12:30 Central, roughly two hours early.

File references:

- `src/bot/evaluate-trading-strategy.ts:66`
- `src/bot/evaluate-trading-strategy.ts:88`
- `src/bot/run-cycle.ts:203`
- `README.md:101`

Suggested fix direction:

- Convert current time to `America/Los_Angeles` before applying strategy rules.
- Name it Pacific time, not PST, because PDT applies during daylight saving time.
- Add tests that run under a non-Pacific host timezone.

### 2. Put-side allocation can buy calls

Candidate selection always sets the generic `symbol` to the call symbol:

- `symbol: strike.call`
- `streamerSymbol: strike["call-streamer-symbol"]`

`manageAllocationForGroup()` passes the inferred side, but later quotes and orders `candidate.symbol` regardless of whether the side is put or call.

So an existing put position can be "managed" by buying calls.

File references:

- `src/bot/option-contracts.ts:111`
- `src/bot/actions/manage-allocation.ts:277`
- `src/bot/actions/manage-allocation.ts:315`
- `src/bot/actions/manage-allocation.ts:389`

Suggested fix direction:

- Make candidate objects side-aware.
- For puts, select ITM/ATM puts using put symbols and put streamer symbols.
- Add tests for put allocation specifically.

### 3. Short-position returns are likely inverted

The close-order utility recognizes short positions and uses `Buy to Close`, but strategy return is always:

```ts
(currentBidPrice - weightedAverageFill) / weightedAverageFill
```

That is long-position math. For short options, lower current prices are profit, but this formula treats them as losses.

File references:

- `src/bot/evaluate-trading-strategy.ts:106`
- `src/bot/actions/order-utils.ts:28`
- `src/bot/actions/order-utils.ts:40`

Suggested fix direction:

- Compute P/L using position direction.
- Keep long and short metrics separate when positions are grouped.

### 4. Live orders are canceled twice

`runBotCycle()` calls `cancelAllLiveOrders()`, then `executePositionEvaluations()` calls it again.

File references:

- `src/bot/run-cycle.ts:309`
- `src/bot/execute-position-evaluations.ts:92`

This creates avoidable broker traffic and can make run history misleading, because the first cancellation result is not the one recorded in the execution summary.

Suggested fix direction:

- Cancel once, in one layer.
- Record exactly which orders were canceled.

### 5. No global run lock

The scheduler has an `inFlight` flag, but IPC can still trigger manual `bot:runCycle`, `bot:seedSymbol`, or scheduler commands concurrently.

File references:

- `src/bot/market-open-scheduler.ts:70`
- `src/ipc-server.ts:97`

Two overlapping cycles can evaluate the same stale balance and place duplicate orders.

Suggested fix direction:

- Add a single process-wide execution lock for live trading actions.
- Make preview read-only and allow it to run separately.

### 6. End-of-day liquidation may not actually liquidate

The strategy says "liquidate instantly" at 12:55, but close orders are Day limit orders at weighted prices. At and after 12:30, route weights are all zero, and close pricing falls back to midpoint behavior.

File references:

- `src/bot/evaluate-trading-strategy.ts:81`
- `src/bot/evaluate-trading-strategy.ts:191`
- `src/bot/actions/order-utils.ts:71`
- `src/bot/actions/order-utils.ts:107`

This can leave positions open when the bot most wants out.

Suggested fix direction:

- Define an explicit liquidation mode.
- Use more aggressive limit prices or market/marketable orders if that is acceptable.
- Verify with order dry-run and small sandbox/live test before relying on it.

## Medium Priority Issues

### 7. Close then allocation uses stale positions

The bot submits close orders first, then continues allocating based on the original positions and balance. It does not wait for fills.

File references:

- `src/bot/execute-position-evaluations.ts:120`
- `src/bot/execute-position-evaluations.ts:132`

Suggested fix direction:

- Separate closing and allocation into different cycles.
- Or refresh account state after closes are filled/canceled.

### 8. Zero or missing quotes can fall into allocation

If price/cost basis falls to zero, return math can become `NaN` or zero-ish and comparisons do not trigger risk exits. That can result in `MANAGE_ALLOCATION`.

File references:

- `src/bot/evaluate-position.ts:53`
- `src/bot/evaluate-trading-strategy.ts:106`

Suggested fix direction:

- Treat missing quote/cost basis as "do not trade".
- Record a skipped reason.

### 9. Liquidity and DTE filters are advisory

The code computes `meetsVolumeRequirement`, but selection does not enforce it before trading. It also allows fallback expirations if the target DTE range is not found.

File references:

- `src/bot/get-option-candidates-for-symbol.ts:111`
- `src/bot/option-contracts.ts:158`

Suggested fix direction:

- Decide which filters are hard requirements.
- Make fallback trading opt-in.

### 10. Grouping can hide mixed-risk positions

Positions are grouped by underlying, and one blended return drives one action for all legs. That can hide cases where one leg should close and another should not.

File references:

- `src/bot/evaluate-position.ts:33`
- `src/bot/evaluate-position.ts:143`

Suggested fix direction:

- Track single-leg positions separately unless a spread/complex position is explicitly recognized.
- Add strategy logic for known multi-leg structures instead of averaging everything.

## Bottom Line

The bot has a real structure: market-hours scheduler, IPC, preview, grouped evaluations, budget caps, and order placement. The highest-risk bugs are not TypeScript errors. They are trading semantics: wrong timezone, wrong side for puts, wrong return math for shorts, duplicated cancellation, missing live-run lock, and close orders that may not fill.
