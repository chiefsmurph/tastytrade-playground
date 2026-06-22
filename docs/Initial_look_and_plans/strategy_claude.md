# Trading Strategy & Financial Correctness (Claude)

> Beyond John's API question: *is the strategy itself internally consistent and financially correct?* This is where the money is actually made or lost. Read-only review; no source files changed.

## Verdict

**The architecture is reasonable and the dollar-denominated budget math is sound — but two assumptions could each silently break the whole strategy, and one of them I can only resolve with a live payload.** The bugs aren't sloppiness; they're *unverified assumptions* about units, symbols, and the clock. That's the most important framing for John: the scaffolding is good, the inputs are suspect.

### What the strategy is
A long-options intraday accumulation bot. Each cycle it groups open positions by underlying, snapshots a live bid/ask, aggregates quantity-weighted metrics (mean bid, mean ask, mean cost basis), then a **time-of-day decision engine** classifies each group:
- **`CLOSE_POSITION`** — hit the (decaying) take-profit target, tripped the loss stop, or hit the EOD circuit breakers (risk-off ≥12:30, hard liquidation ≥12:55).
- **`MANAGE_ALLOCATION`** — add to the position toward a target exposure (40%→100% across the morning) using a blended bid/mid/ask "route" weighting that shifts passive→aggressive midday.

---

## Findings

### 🔴 str-1 — Possible unit mismatch: per-share quote vs per-contract `average-open-price`
**Severity: Critical · Confidence: Verify first · [evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106), [evaluate-position.ts:62](../src/bot/evaluate-position.ts#L62)**

`weightedAverageFill` is sourced from `position.average_open_price`; `currentBidPrice`/`currentAskPrice` come from the dxfeed Quote (`bidPrice`/`askPrice`), which is the **per-share** option premium (e.g. `2.50`). The strategy then computes:

```
currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill
```

**If `average-open-price` is reported per *contract* (premium × 100, e.g. `250`)**, you're computing `(2.50 - 250) / 250 ≈ -0.99` for essentially every position regardless of real P/L. That single number feeds the take-profit gate, the −0.30 stop, the −0.10 EOD compression, the allocation sort order, and the logged returns. The bot would **almost never** hit take-profit and would **constantly** trip the loss stop / EOD close.

**I could not confirm the units remotely** (the Tastytrade docs pages are JS-rendered and the example payloads wouldn't load). So this is flagged as *verify*, not *confirmed* — but it's the **single highest-leverage question in the whole review**.

**How to check in 30 seconds:** pull one real option position via `GET /accounts/{a}/positions` and compare `average-open-price` to the premium you actually paid. If it's ~100× the per-share premium → per-contract → this is a real, critical bug. If it equals the per-share premium → both sides are consistent and this finding evaporates. **Fix (if confirmed):** divide `average-open-price` by the multiplier (or multiply the quote by 100) so both sides of every return calc share units, and add a regression test pinning a known position+quote to an expected return.

---

### 🔴 str-2 — Candidate selector is hardcoded to calls, regardless of side
**Severity: Critical · Confidence: High · [option-contracts.ts:112](../src/bot/option-contracts.ts#L112)**

`chooseOptionCandidates` builds **every** candidate with `symbol: strike.call` and `streamerSymbol: strike['call-streamer-symbol']`, and filters strikes with `s.strike < underlyingPrice` (its own comment says "For a call, ITM means strike < underlying price"). The `side` parameter is used only for volume sorting and the `meetsVolumeRequirement` flag — **never** to pick the put symbol or the put-appropriate strike side. Consequences:

- In `manage-allocation`, `getCandidateSide` may return `'put'` for a put group, but the candidate still carries the **call** OCC symbol, and `placeRouteOrders` submits Buy-to-Open on that **call**. *Adding to a put position buys calls.*
- In `seedSymbol`, `side='put'` reads `candidate.put` (which exists via `...strike`), but the chosen strike is ITM-for-calls = **OTM-for-puts**, so the moneyness is wrong.

**Fix:** make `chooseOptionCandidates` side-aware — select `strike.put`/`put-streamer-symbol` and use `strike > underlyingPrice` (ITM for puts) when `side === 'put'`, and set `symbol`/`streamerSymbol` accordingly. Add put-selection tests.

> If the bot is *only ever* used for calls in practice, this is latent rather than active — which is exactly the kind of thing to confirm with John rather than assume.

---

### 🟠 str-3 — Strategy clock assumes Pacific but reads host-local time
**Severity: High · Confidence: High · [evaluate-trading-strategy.ts:88](../src/bot/evaluate-trading-strategy.ts#L88), [run-cycle.ts:203](../src/bot/run-cycle.ts#L203)**

All gating uses `currentTime.getHours() * 60 + getMinutes()`, and the comments label these as "Pacific Standard Time." But `getHours()` returns the **host machine's** timezone, and `run-cycle` builds `new Date()` with no conversion. If the bot runs on a UTC or ET server (very common), every threshold — the 06:30 ramp, 12:30 risk-off, 12:55 hard liquidation, the whole take-profit decay window — fires at the **wrong wall-clock time**. Note there's an explicit-string variant (`...ForPstTime`), but the live path uses raw `new Date()`. DST compounds it, since the schedule is fixed-minute.

**Fix:** convert to `America/Los_Angeles` explicitly (`Intl.DateTimeFormat` with `timeZone`, or a TZ lib) before extracting hours/minutes.

---

### 🟡 str-4 — Weight cap keyed on whole-portfolio exposure, not per-position size
**Severity: Medium · Confidence: High · [run-cycle.ts:217](../src/bot/run-cycle.ts#L217), [evaluate-trading-strategy.ts:16](../src/bot/evaluate-trading-strategy.ts#L16)**

`applyPositionSizeWeightCaps` reads like a **per-position** concentration guard — its buckets (`positionSizePct <= 0.15 → ask cap 0.50`, `<= 0.30 → 0.75`) suggest "don't pay the ask aggressively for a large single position." But `run-cycle` feeds it `currentExposurePct = portfolioExposure / totalCapital` — the **whole account's** exposure. So the cap *loosens* (allows full ask) as the entire portfolio grows, which is backwards for a concentration guard, and forces a fresh low-exposure account to bid/mid even for a tiny single position. The same cap is then applied uniformly to every group.

**Fix:** decide the intent. If it's a per-position guard, pass each group's own size-as-fraction-of-capital inside the per-group loop. If it's deliberately a portfolio throttle, rename it and document the inverted relationship.

---

### 🟡 str-5 — Dry-run plan and live execution can diverge
**Severity: Medium · Confidence: High · [run-cycle.ts:224](../src/bot/run-cycle.ts#L224), [execute-position-evaluations.ts:106](../src/bot/execute-position-evaluations.ts#L106)**

The printed plan sorts `MANAGE` groups by `currentReturn` only; live execution sorts by `targetAccountExposure` desc **then** `currentReturn` asc. They coincide *today* only because all groups share identical targets (so the primary key is constant) — diverge the targets and the order diverges. Worse, `manageAllocationForGroup` **re-fetches** the candidate and a fresh quote on *both* the dry-run and the live pass, so the displayed quantities/limits aren't guaranteed to match what's actually submitted moments later. The clean plan/execute separation is a good instinct, but as built the plan is an **estimate**, not a contract.

**Fix:** either compute the plan once and submit those exact route orders, or label the plan non-binding. Extract one shared sort comparator.

---

### 🟡 str-6 — Allocates worst-return-first (averages down) and counts closing groups as exposure
**Severity: Medium · Confidence: Medium · [execute-position-evaluations.ts:110](../src/bot/execute-position-evaluations.ts#L110), [manage-allocation.ts:443](../src/bot/actions/manage-allocation.ts#L443)**

Two coupled design choices worth a sanity check:
1. `MANAGE` groups are allocated **worst-`currentReturn`-first** — the bot adds capital to its *most losing* positions first (martingale / averaging-down). For a long-premium intraday strategy, that concentrates budget into decaying losers.
2. `buildInitialBudget` sums `portfolioExposure` over **all** evaluations, including groups being **closed this same cycle**. So headroom for new buys is reduced by positions that are simultaneously being liquidated — understating available headroom.

**Fix:** confirm worst-first is intentional (vs best-first momentum). Exclude `CLOSE_POSITION` groups from `portfolioExposure` when sizing new allocations.

---

### 🟢 str-7 — "Mid" route falls back to full ask on one-sided quotes
**Severity: Low · Confidence: Medium · [manage-allocation.ts:70](../src/bot/actions/manage-allocation.ts#L70)**

`getMidpointPrice` returns `(bid+ask)/2` only when both are positive, else `ask || bid`. So on an illiquid one-sided quote, the "mid" (conservative) route silently pays the **full ask**, and the contract-count math uses that inflated price. No guard rejects crossed/locked (`bid > ask`) or stale one-sided quotes.

**Fix:** when a true two-sided quote is unavailable, skip the route (or only allow the explicit ask route), and reject crossed markets.

---

### 🟢 str-8 — `cancelAllLiveOrders` runs twice per cycle
**Severity: Low · Confidence: High · [run-cycle.ts:309](../src/bot/run-cycle.ts#L309), [execute-position-evaluations.ts:92](../src/bot/execute-position-evaluations.ts#L92)**

`runBotCycle` cancels all live orders, then immediately calls `executePositionEvaluations`, which cancels **again**. The second is redundant (extra round-trips, extra window); the first call's results are discarded. Keep one.

---

### 🟢 str-9 — Unguarded divide-by-`weightedAverageFill` → NaN silently means "allocate"
**Severity: Low · Confidence: Medium · [evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106)**

If `weightedAverageFill` falls back to a `currentBidPrice` of 0 (no quote, no mark/close), `evaluateTradingStrategy` divides by it → `NaN`. Since `NaN >= target` and `NaN <= -0.30` are both false, the group **silently defaults to `MANAGE_ALLOCATION`** and may get capital despite having no valid pricing. `evaluatePositionGroup` guards its own return (returns 0 when WAF ≤ 0) but the strategy call doesn't.

**Fix:** guard `evaluateTradingStrategy` for non-positive/non-finite `weightedAverageFill` (skip, don't allocate).

---

### 🟡 str-test — Tests cover only schedules/caps; the risky math is untested
**Severity: Medium · Confidence: High · [evaluate-trading-strategy.test.ts](../src/bot/tests/evaluate-trading-strategy.test.ts)**

The only test file exercises `getTimeOfDayExecutionTargets*` boundaries and `applyPositionSizeWeightCaps`. **Zero** coverage of: `evaluateTradingStrategy` (the actual CLOSE/MANAGE decision and the str-1 return math), budget conservation across groups, `allocateContractsByWeight` flooring/water-filling, `chooseOptionCandidates` side handling (str-2), or plan/exec parity. And the 50%-cap test asserts `midWeight` stays `0.2` only because its input ask (`0.9`) is already below the `1.0` cap — it never exercises a reduction. Net: the **highest-risk financial paths have no tests.**

**Fix:** add unit tests with known positions/quotes asserting expected returns, budget conservation, contract flooring, and put-side selection; strengthen the cap test with a `>1.0` ask input.

---

## ✅ What's genuinely good (financial correctness John got right)

- **Dollar-consistent math:** `getGroupMarketValue` (bid × quantityWeight, where quantityWeight = qty × multiplier) and `estimatedOrderValue` (qty × limit × 100) are both real dollars, and `targetExposure = totalCapital × pct` compares like-for-like.
- **Water-filling allocator:** `allocateContractsByWeight` floors per-route contracts, then fills leftover capital to the most-underfunded affordable route, with an iteration cap (100) and a clean zero-cost guard.
- **Budget threading:** `perGroupExposureHeadroom` divided by `groupsRemaining`, decremented via `getUpdatedBudgetAfterAllocation`, so allocation can't trivially over-commit the same headroom to every group.
- **Signed pending cash:** `getEffectiveTotalCapital` correctly applies the debit→negative effect rather than blindly adding pending cash.
- **Closing orders:** price-effect set correctly from action (Buy→Debit, Sell→Credit), with strict position-effect validation.
- **Schedule interpolation:** piecewise-linear blends are clamped at both ends and monotonic; the take-profit decay (0.40→0.07) and exposure ramp (0.40→1.00) are sensible for an intraday accumulate-then-derisk profile; the 12:30/12:55 hard gates are clear.

---

## Open questions for John (Strategy) — these matter more than the bug list

1. **What are the real units of `average-open-price`** in your live positions payload — per-share (`2.50`) or per-contract (`250`)? Every return/take-profit/stop decision hinges on it (str-1).
2. **What timezone is the host clock?** The schedule is Pacific but reads local time. Is the server set to PST, and how do you handle DST? (str-3)
3. **Is averaging-down into the worst performers intentional**, or did you mean best-first / momentum? (str-6)
4. **Should the weight cap key off each position's size, or the whole account's exposure?** Today it's the latter, which inverts the apparent intent (str-4).
5. **Do you ever intend to trade puts** through the add/seed flow? Today the selector buys calls regardless (str-2).
6. **Is the printed plan meant to be binding**, or is it OK that live execution re-prices and may submit different quantities? (str-5)

### Sources
- [Tastytrade — Account Positions API guide](https://developer.tastytrade.com/api-guides/account-positions/)
- [Tastytrade developer docs](https://developer.tastytrade.com/)
- [dxfeed QD model of market events](https://kb.dxfeed.com/en/data-model/qd-model-of-market-events.html)
