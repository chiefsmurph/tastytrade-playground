# Implementation Plan - Codex

This is my implementation roadmap after reading the full `docs/` folder, including Claude's files and the earlier Codex files.

Scope: this is a plan for changing the TypeScript codebase, not another audit. It is ordered by what most affects correctness and live-trading safety first, with low-hanging cleanup called out separately.

## Executive Summary

Do not start by polishing the strategy. First make the bot read the broker payloads correctly, quote the right symbols, and prevent overlapping live order runs.

The core change sequence should be:

1. Add test fixtures and normalization around real tastytrade response shapes.
2. Fix market-session parsing so the scheduler can tell open vs closed.
3. Fix position parsing so grouped positions, P/L, short detection, and close orders use real values.
4. Fix quote symbology so allocation quotes streamer symbols and orders OCC symbols.
5. Add live-trading safety rails: env validation, sandbox/prod config, global run lock, dry-run wrapper, per-order error capture.
6. Fix strategy math: Pacific time, put/call side selection, short P/L, possible cost-basis unit mismatch, and volume/liquidity semantics.
7. Then do operational hygiene: logging, PM2 portability, README drift, state/history durability, IPC timeout.

## Confidence Labels

- **Confirmed**: visible in source or verified against official docs/SDK.
- **Verify first**: plausible and high-impact, but should be settled with a real read-only payload before coding the final behavior.
- **Decision**: not a pure bug; John needs to choose the desired trading behavior.

## Phase 0 - Ground Truth Fixtures

This should be the first implementation step if credentials are available, and it should be read-only.

### P0.1 Capture read-only API fixtures

Capture representative sandbox or read-only production payloads for:

- `GET /market-time/equities/sessions/current`
- `GET /customers/me/accounts`
- `GET /accounts/{account}/balances`
- `GET /accounts/{account}/positions`
- `GET /option-chains/{symbol}/nested`
- one quote streamer event for an equity
- one quote streamer event for an option contract
- one Summary/Trade event for an option contract if using volume

Store sanitized fixtures under a test fixture folder, not in chat or logs.

Why this comes first:

- It settles field names like `open-at`, `close-at`, `state`, `underlying-symbol`, `average-open-price`, and `streamer-symbol`.
- It settles the `average-open-price` unit question.
- It gives tests something real to pin against.

Done when:

- Fixtures are sanitized.
- No access tokens, account secrets, or full account numbers are committed.
- Tests can import fixture JSON without touching the network.

## Phase 1 - Broker Payload Correctness

These are blockers. Without them, the bot can build and still do the wrong thing or nothing at all.

### P1.1 Fix market-session parsing

Status: **Confirmed**

Problem:

- Official docs show `open-at`, `close-at`, `close-at-ext`, `start-at`, and `state`.
- `src/core/market-sessions.ts` mostly reads guessed variants such as `opens-at`, `closes-at`, `session-status`, and `is-open`.
- The scheduler may treat regular market hours as closed.

Files:

- `src/core/market-sessions.ts`
- add `src/core/market-sessions.test.ts` or equivalent test file

Implementation:

- Parse documented keys directly.
- Use `open-at` and `close-at` for the regular equity session.
- Use `state` as the primary open/closed state signal.
- Keep fail-closed behavior for malformed payloads.
- Do not count `close-at-ext` as equity-options-open unless explicitly intended.

Tests:

- open regular session fixture -> `isEquityOptionsMarketOpen()` true
- premarket/closed fixture -> false
- malformed fixture -> false

### P1.2 Normalize positions and balances at the API boundary

Status: **Confirmed**

Problem:

- tastytrade returns kebab-case fields.
- The code mostly reads snake_case position fields.
- This breaks grouping, cost basis, quote fallback, short detection, instrument type, and close-order construction.

Files:

- create `src/core/normalize.ts`
- update `src/core/types.ts`
- update `src/bot/get-position-evaluations.ts`
- update `src/bot/seed-symbol.ts`
- update `src/bot/evaluate-position.ts`
- update `src/bot/actions/order-utils.ts`

Implementation:

- Add `normalizePosition(raw)` that maps broker keys to one internal shape.
- Include all fields currently used plus `streamerSymbol`.
- Add `normalizeAccountBalance(raw)` or at least formalize balance key handling.
- Stop passing raw API position records into strategy and order code.

Recommended internal shape:

- `accountNumber`
- `symbol`
- `streamerSymbol`
- `instrumentType`
- `underlyingSymbol`
- `quantity`
- `quantityDirection`
- `averageOpenPrice`
- `markPrice`
- `closePrice`
- `multiplier`
- `costEffect`
- `updatedAt`

Tests:

- kebab-case position fixture normalizes into populated internal fields
- old snake_case shape still works if needed
- missing required trading fields produce a skip reason, not an exception

### P1.3 Quote streamer symbols, order OCC symbols

Status: **Confirmed**

Problem:

- Allocation currently quotes `candidate.symbol`, which is the OCC order symbol.
- dxfeed quote streaming expects the `streamer-symbol`.
- `seedSymbol()` already has the right pattern: quote streamer symbol, order OCC symbol.

Files:

- `src/core/market-data.ts`
- `src/bot/actions/manage-allocation.ts`
- `src/bot/evaluate-position.ts`
- `src/bot/option-contracts.ts`
- `src/bot/get-option-candidates-for-symbol.ts`

Implementation:

- Change quote lookup inputs to use `streamerSymbol`.
- Keep order legs using OCC symbols.
- Require candidate objects to carry both fields explicitly:
  - `orderSymbol`
  - `quoteSymbol`
- Prefer renaming over reusing `symbol`, because this is exactly where the bug came from.

Tests:

- allocation candidate quotes with streamer symbol
- order payload uses OCC symbol
- position quote lookup uses `position.streamerSymbol`

### P1.4 Missing price means skip, never allocate

Status: **Confirmed**

Problem:

- Missing quotes or zero cost basis can produce `NaN`.
- `NaN` comparisons fail closed in the wrong direction and can fall through to `MANAGE_ALLOCATION`.

Files:

- `src/bot/evaluate-position.ts`
- `src/bot/evaluate-trading-strategy.ts`
- possibly `src/bot/types.ts` or a new result type

Implementation:

- Introduce a `SKIP` action or an explicit `skippedReason`.
- If quote, cost basis, multiplier, or direction is invalid, skip the group.
- Do not place allocation or close orders from invalid metrics.

Tests:

- zero cost basis -> skip
- missing bid/ask with no fallback -> skip
- `NaN` never routes to allocation

## Phase 2 - Live Trading Safety Rails

These should be done before enabling scheduler or running live orders.

### P2.1 Single source of environment truth

Status: **Confirmed**

Problem:

- REST base URL can be production while account streamer URL is hardcoded to cert/sandbox.
- Required env vars are cast as strings and not validated.

Files:

- create `src/core/env.ts`
- update `src/core/tastytrade-client.ts`
- update `.env.example`
- update `README.md`

Implementation:

- Add `TASTYTRADE_ENV=sandbox|production`.
- Default examples to sandbox.
- Build URLs from `TastytradeClient.ProdConfig` or `TastytradeClient.SandboxConfig`.
- Validate `API_CLIENT_SECRET` and `API_REFRESH_TOKEN` at startup.
- Consider requiring an explicit `BOT_ENABLE_LIVE_ORDERS=true` for live submit paths.

Tests:

- missing secret throws clear startup error
- sandbox config uses sandbox REST and streamer
- production config uses production REST and streamer

### P2.2 Add a global live-trading lock

Status: **Confirmed**

Problem:

- Scheduler `inFlight` only guards scheduler ticks.
- IPC can trigger overlapping `bot:runCycle` or `bot:seedSymbol`.

Files:

- create `src/core/run-lock.ts`
- update `src/bot/run-cycle.ts`
- update `src/bot/seed-symbol.ts`
- update `src/ipc-server.ts`
- update `src/bot/market-open-scheduler.ts`

Implementation:

- Add a process-wide async mutex.
- Wrap all live order paths.
- Keep read-only preview commands unlocked.
- Return a structured "already running" IPC error if lock is held.

Tests:

- concurrent live calls: first runs, second rejects
- scheduler and IPC share the same lock

### P2.3 Add a safe order placement wrapper

Status: **Confirmed**

Problem:

- `createOrder()` is used directly in allocation and close paths.
- One rejected order can throw the whole cycle after prior orders are already live.
- Only `seedSymbol()` dry-runs first.

Files:

- create `src/bot/actions/place-order.ts`
- update `src/bot/actions/manage-allocation.ts`
- update `src/bot/actions/close-position.ts`
- update `src/bot/seed-symbol.ts`
- update `src/bot/run-history.ts`

Implementation:

- `placeOrderSafely(accountNumber, order, options)` should:
  - run `postOrderDryRun()` first
  - skip live submit if dry-run fails
  - submit only when live orders are enabled
  - catch and return per-order errors
  - include dry-run response summary
- Make run history record partial failures.
- Ensure `appendRunHistory()` still happens when a later order fails.

Tests:

- dry-run failure records skipped order
- live submit failure records error and cycle continues
- successful dry-run + submit records both

### P2.4 Cancel live orders once

Status: **Confirmed**

Problem:

- `runBotCycle()` cancels live orders.
- `executePositionEvaluations()` cancels them again.
- First result is discarded.

Files:

- `src/bot/run-cycle.ts`
- `src/bot/execute-position-evaluations.ts`

Implementation:

- Move cancellation to one owner.
- Pass cancellation results into run history.
- Do not hide first cancellation results.

Tests:

- cycle calls cancel once
- cancellation summary is included in run history

### P2.5 Make liquidation behavior explicit

Status: **Decision**

Problem:

- Code says "liquidate instantly."
- It submits Day limit orders that may not fill.

Files:

- `src/bot/evaluate-trading-strategy.ts`
- `src/bot/actions/order-utils.ts`
- `src/bot/actions/close-position.ts`

Implementation choices:

- passive close: use current limit behavior, but stop calling it instant liquidation
- marketable close: cross the spread by configured ticks/percent
- market order: fastest but most slippage

Recommendation:

- Implement a named `LIQUIDATE_POSITION` action separate from ordinary `CLOSE_POSITION`.
- Use marketable limit by default.
- Keep a config knob for max slippage.

Tests:

- take-profit close uses normal limit
- 12:55 liquidation uses liquidation pricing mode

## Phase 3 - Strategy Correctness

These change trading behavior and should be tested with fixtures before live use.

### P3.1 Compute strategy time in America/Los_Angeles

Status: **Confirmed**

Problem:

- Strategy says Pacific time.
- Runtime uses host-local `Date.getHours()`.

Files:

- create `src/core/time.ts`
- update `src/bot/evaluate-trading-strategy.ts`
- update `src/bot/run-cycle.ts`
- update tests

Implementation:

- Add `getPacificMinutes(date)`.
- Use `Intl.DateTimeFormat` with `timeZone: "America/Los_Angeles"`.
- Rename public helpers from `Pst` to `Pacific` where practical.
- Keep a string-based helper for IPC/debugging.

Tests:

- same UTC timestamp produces same strategy target regardless of host `TZ`
- 12:30 and 12:55 gates match Pacific time

### P3.2 Make option candidate selection side-aware

Status: **Confirmed**

Problem:

- Candidate selection always selects calls and call ITM strikes.
- Put path can buy calls or choose wrong moneyness.

Files:

- `src/bot/option-contracts.ts`
- `src/bot/get-option-candidates-for-symbol.ts`
- `src/bot/actions/manage-allocation.ts`
- `src/bot/seed-symbol.ts`

Implementation:

- Pass side into `chooseOptionCandidates()`.
- For calls:
  - use `strike.call`
  - use `call-streamer-symbol`
  - ITM means `strike < underlyingPrice`
- For puts:
  - use `strike.put`
  - use `put-streamer-symbol`
  - ITM means `strike > underlyingPrice`
- Return explicit `side`, `orderSymbol`, `quoteSymbol`, `strike`, `dte`, and liquidity fields.

Tests:

- call selection returns call symbol
- put selection returns put symbol
- put ITM logic uses strikes above underlying

### P3.3 Fix P/L math for direction and units

Status: **Confirmed for direction, verify first for units**

Problem:

- Current formula is long-only.
- Short option profit/loss is inverted.
- Claude raised a possible per-share vs per-contract `average-open-price` mismatch.

Files:

- `src/bot/evaluate-position.ts`
- `src/bot/evaluate-trading-strategy.ts`
- `src/bot/actions/order-utils.ts`

Implementation:

- First verify whether `average-open-price` is per-share or per-contract using fixture payloads.
- Normalize cost basis to the same unit as quote prices.
- Compute signed return based on long/short direction.
- Avoid blending long and short legs into one ambiguous return unless the group is recognized as a strategy/spread.

Tests:

- long option bought at 2.00, bid 2.40 -> +20%
- short option sold at 2.00, ask/buyback 1.60 -> +20%
- cost basis unit fixture locks expected return
- mixed long/short group does not silently average into nonsense

### P3.4 Replace option volume sampling with an explicit liquidity metric

Status: **Confirmed**

Problem:

- Current "volume" sums trade size, day volume, bid size, ask size, and open interest.
- The result is not a coherent liquidity metric.

Files:

- `src/core/option-service.ts`
- `src/bot/option-contracts.ts`

Implementation:

- Decide the metric:
  - day volume
  - open interest
  - bid/ask size
  - combination with separate thresholds
- Subscribe only to needed event types.
- Treat cumulative `dayVolume` as a snapshot, not a value to sum repeatedly.
- Store fields separately, for example `dayVolume`, `openInterest`, `bidSize`, `askSize`.

Recommendation:

- Use `dayVolume` and `openInterest` separately.
- Do not use five-second summed trade sizes for contract eligibility.

Tests:

- repeated `dayVolume` events do not double count
- open interest is not labeled volume
- candidate fails when hard liquidity requirement is not met

### P3.5 Enforce filters that are meant to be filters

Status: **Decision**

Problem:

- `meetsVolumeRequirement` is advisory.
- DTE fallback can still trade when target range misses.

Files:

- `src/bot/get-option-candidates-for-symbol.ts`
- `src/bot/option-contracts.ts`
- `src/bot/actions/manage-allocation.ts`

Implementation:

- Add explicit config:
  - `MIN_DAY_VOLUME`
  - `MIN_OPEN_INTEREST`
  - `ALLOW_DTE_FALLBACK`
- If filters fail, return a skipped candidate result with reason.
- Make fallback visible in run history and preview.

Tests:

- low liquidity candidate is not traded
- DTE fallback disabled means no trade
- DTE fallback enabled records `usedDteFallback`

### P3.6 Decide allocation philosophy before changing sort order

Status: **Decision**

Problem:

- The bot allocates worst-return-first.
- This can be intentional averaging down or an accidental martingale.

Files:

- `src/bot/execute-position-evaluations.ts`
- `src/bot/run-cycle.ts`

Implementation options:

- worst-first mean reversion
- best-first momentum
- under-target-position-size first
- no adding to losing positions after threshold

Recommendation:

- Do not silently flip the sort order.
- Add a config enum like `ALLOCATION_PRIORITY=worst-return|best-return|underweight`.
- Default to the current behavior until John chooses otherwise, but make it explicit in logs and docs.

## Phase 4 - Operational Hygiene and Low-Hanging Fruit

These are lower risk and can be batched into a cleanup PR after blockers, or done first if John wants quick visible improvements.

### Quick wins

1. Fix README command typo:
   - `core:fetchOptionChainsWithVolume` -> `core:fetchOptionChainWithVolume`
2. Make PM2 interpreter portable:
   - replace hardcoded `/home/deploy/.../node` with `node` or env-driven path
3. Rename `Pst` helpers to `Pacific` after time fix
4. Remove or gate `bot:johnsTestRun`
5. Remove dead `src/bot/index.ts` scratch code if unused
6. Add command documentation for `core:cancelAllLiveOrders` if it remains exposed

### Runtime hygiene

1. Redact account/order payload logging.
2. Add global `unhandledRejection` and `uncaughtException` logging.
3. Add IPC client timeout.
4. Probe stale socket before unlinking so a second process cannot steal a live socket.
5. Rotate or cap `data/runs.ndjson`.
6. Persist last-run state or clearly document that it is in-memory only.
7. Make scheduler interval behavior explicit when a run takes longer than the interval.

### Streamer lifecycle

Status: **Confirmed**

Problem:

- Quote streamer connects repeatedly and cleanup is inconsistent.

Implementation:

- Either maintain a shared quote connection with subscription reference counting, or make each helper own connect/disconnect in `finally`.
- Avoid running many simultaneous quote lookups against one global mutable streamer without coordination.

## Phase 5 - Test Plan

The current tests pass, but they cover only schedule blending and ask-weight caps.

Add tests in this order:

1. `normalize.test.ts`
   - position and balance fixture normalization
2. `market-sessions.test.ts`
   - official field names and fail-closed behavior
3. `market-data-symbols.test.ts`
   - streamer symbol vs OCC symbol routing
4. `option-contracts.test.ts`
   - call/put side-aware candidate selection
5. `evaluate-position.test.ts`
   - long/short cost basis and return metrics
6. `evaluate-trading-strategy.test.ts`
   - skip on invalid metrics
   - Pacific time boundaries
   - take-profit/loss gates
7. `manage-allocation.test.ts`
   - no allocation on missing quote
   - hard liquidity gates
   - route order sizing
8. `run-lock.test.ts`
   - overlapping live execution rejected
9. `place-order.test.ts`
   - dry-run failure
   - live submit failure
   - partial success recorded

Verification gates:

- `npm run typecheck`
- `npm test`
- `npm run build`
- sandbox dry-run full cycle
- one tiny supervised live test only after sandbox is clean
- scheduler enabled only after a supervised live cycle succeeds

## Suggested Pull Request Sequence

### PR 1 - Fixtures and normalization

- Add sanitized fixtures.
- Add `src/core/normalize.ts`.
- Normalize positions and balances.
- Add market-session parser fix.
- Add tests for both.

Why first:

- It fixes the broker payload reality layer.
- It gives every later strategy change stable inputs.

### PR 2 - Quote symbol correctness

- Rename candidate fields to `orderSymbol` and `quoteSymbol`.
- Use streamer symbols for quotes.
- Use OCC symbols for orders.
- Add side-aware candidate structure but keep current call behavior until PR 5 if needed.

Why second:

- Without this, allocation quotes can time out and no trade path can be trusted.

### PR 3 - Safety rails

- Add `env.ts`.
- Add `run-lock.ts`.
- Add `place-order.ts`.
- Use dry-run before allocation and close orders.
- Record partial failures.
- Cancel live orders once.

Why third:

- After PR 1 and PR 2 the bot can act; before strategy changes it needs to fail safely.

### PR 4 - Time and invalid-metric behavior

- Add Pacific time helper.
- Add `SKIP`/skipped reason for invalid metrics.
- Update strategy tests.

Why fourth:

- It prevents obvious wrong-time and no-price trades.

### PR 5 - Strategy correctness

- Side-aware put/call selection.
- Direction-aware P/L.
- Cost-basis unit normalization after fixture verification.
- Liquidity metric replacement.
- Hard DTE/liquidity gates.

Why fifth:

- These are behavior changes and should be reviewed carefully.

### PR 6 - Operational cleanup

- Logging redaction.
- PM2 portability.
- README command fixes.
- IPC timeout.
- stale socket probe.
- last-run/history durability decisions.
- remove or gate scratch commands.

## Decisions For John

Ask these before PR 5, but PRs 1-4 can mostly proceed without them:

1. Should allocation add to losers, winners, or underweight positions?
2. Should the bot trade puts at all?
3. What should `MIN_VOLUME=120` mean: day volume, open interest, quote size, or a combination?
4. Should DTE fallback be allowed to trade?
5. At 12:55, is slippage acceptable for true liquidation?
6. Should preview be binding, or is it only an estimate?
7. Should close and allocation happen in the same cycle, or should allocation wait until closes fill?
8. Should live trading require an explicit `BOT_ENABLE_LIVE_ORDERS=true`?

## Low-Hanging Fruit List

If you want quick wins before major rewrites:

1. README command typo.
2. PM2 interpreter path.
3. Env validation.
4. Remove duplicate cancel.
5. Add `BOT_ENABLE_LIVE_ORDERS` guard.
6. Add IPC timeout.
7. Gate `johnsTestRun`.
8. Add logging redaction.
9. Add tests for market-session parser and position normalization.

## Final Priority Order

1. Fixtures and response normalization.
2. Market-session parser.
3. Quote streamer-symbol usage.
4. Missing-price skip.
5. Env validation and sandbox/prod config.
6. Global live-trading lock.
7. Dry-run and guarded order placement.
8. Cancel once and persist partial failures.
9. Pacific time.
10. Side-aware put/call candidate selection.
11. Direction- and unit-correct P/L.
12. Real liquidity metric and hard filters.
13. Explicit liquidation mode.
14. Allocation philosophy decisions.
15. Ops cleanup and docs.

## Bottom Line

The fastest safe path is not "fix strategy first." The fastest safe path is: normalize broker payloads, quote the right streamer symbols, add live-order safety rails, then fix strategy math. After that, the remaining cleanup is straightforward.
