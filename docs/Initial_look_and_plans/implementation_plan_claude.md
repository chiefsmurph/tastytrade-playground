# Implementation Plan — Tastytrade Bot (Claude)

> **Purpose:** one prioritized roadmap that merges *both* AI reviews of this repo — the `*_claude.md` set and the `*_codex.md` set — plus three things I re-verified directly in the source. It's written so you (Stephen) can work top-to-bottom editing John's `.ts` files, and so John can read the diff and understand *why* each change was made.
>
> **Reviewer:** Claude (Opus 4.8) · **Date:** 2026-06-21 · **Source legend:** **[C]** = found by Claude, **[X]** = found by Codex, **[C+X]** = both, **[C✓]** = re-verified in source while writing this plan.
>
> **Scope of this file:** *planning only.* No code is changed here. Each item lists the concrete change, new files needed, tests, and a "Done when" check.

---

## TL;DR — the one thing to internalize

**This bot does not currently trade, for several independent reasons stacked on top of each other.** Typecheck passes and 7/7 tests pass (Codex ran them), but "compiles" ≠ "works": the parts that touch *live API response shapes* and *the streamer* are where it breaks, and tests don't cover any of them. Fixing one blocker won't help — they all gate the same path. So the plan front-loads the **"why nothing happens"** chain (Phase 1), then **safety** (Phase 2), then **strategy correctness** (Phase 3), then **hygiene** (Phase 4), then **tests/verification** (Phase 5).

### The "why nothing trades" chain (all confirmed in source)
1. **Scheduler may never fire** — market-session parser reads field names the API doesn't return (`close-at`/`state` missed) → market looks "closed" forever. *(P1.1)*
2. **If it does run, every position is mis-read** — positions come back **kebab-case**, code reads **snake_case** → `underlying-symbol`, `average-open-price`, `mark-price`, `quantity-direction`, `instrument-type` are all `undefined`. Grouping collapses, **cost basis falls back to the live bid so every return ≈ 0%**, short-detection always says "long," and `normalizeInstrumentType(undefined)` throws when building a close order. *(P1.2)*
3. **Even with good data, quotes fail** — the streamer is subscribed with the **OCC** symbol instead of the dxfeed **streamer-symbol**, so bid/ask always time out → price 0 → routes filtered out → "candidate quote unavailable." *(P1.3)*
4. **Junk then defaults to "buy"** — a `NaN`/0 return doesn't trip any risk gate, so the group silently defaults to `MANAGE_ALLOCATION`. *(P1.4)*

---

## Master priority table

| ID | Pri | Item | Source | Files |
|----|-----|------|--------|-------|
| **P1.1** | 🔴 Blocker | Market-session parsing uses wrong field names → scheduler thinks market is closed | **[X]** | [market-sessions.ts](../src/core/market-sessions.ts) |
| **P1.2** | 🔴 Blocker | Positions parsed snake_case but API is kebab-case → returns≈0, grouping/short-detect broken, close-build throws | **[C+X][C✓]** | [evaluate-position.ts](../src/bot/evaluate-position.ts), [order-utils.ts](../src/bot/actions/order-utils.ts), [types.ts](../src/core/types.ts) |
| **P1.3** | 🔴 Blocker | Quote streamer fed OCC symbol, not streamer-symbol → all quotes fail | **[C]** | [market-data.ts](../src/core/market-data.ts), [manage-allocation.ts](../src/bot/actions/manage-allocation.ts), [evaluate-position.ts](../src/bot/evaluate-position.ts) |
| **P1.4** | 🟠 High | Zero/`NaN` return silently defaults to `MANAGE_ALLOCATION` | **[C+X]** | [evaluate-trading-strategy.ts](../src/bot/evaluate-trading-strategy.ts), [evaluate-position.ts](../src/bot/evaluate-position.ts) |
| **P2.1** | 🔴 Safety | Prod REST + cert streamer; env vars unvalidated; no single env source | **[C+X]** | [tastytrade-client.ts](../src/core/tastytrade-client.ts), [.env.example](../.env.example) |
| **P2.2** | 🔴 Safety | No global live-trading lock → manual + scheduled cycles overlap, duplicate orders | **[C+X]** | [market-open-scheduler.ts](../src/bot/market-open-scheduler.ts), [ipc-server.ts](../src/ipc-server.ts) |
| **P2.3** | 🔴 Safety | No try/catch + no dry-run around order placement → partial fills, unrecorded | **[C]** + dry-run **[X]** | [manage-allocation.ts](../src/bot/actions/manage-allocation.ts), [close-position.ts](../src/bot/actions/close-position.ts) |
| **P2.4** | 🟠 High | "Liquidate at 12:55" sends Day limit orders that may not fill | **[X]** | [evaluate-trading-strategy.ts](../src/bot/evaluate-trading-strategy.ts), [order-utils.ts](../src/bot/actions/order-utils.ts) |
| **P3.1** | 🟠 High | Strategy clock assumes Pacific but reads host-local time (host = Central → fires ~2h early) | **[C+X]** | [evaluate-trading-strategy.ts](../src/bot/evaluate-trading-strategy.ts), [run-cycle.ts](../src/bot/run-cycle.ts) |
| **P3.2** | 🔴 Critical | Candidate selector hardcoded to calls → put groups buy calls | **[C+X]** | [option-contracts.ts](../src/bot/option-contracts.ts), [manage-allocation.ts](../src/bot/actions/manage-allocation.ts) |
| **P3.3** | 🔴 Critical | Return math: long-only formula (shorts inverted) + verify cost-basis units | short **[X]**, units **[C]** | [evaluate-trading-strategy.ts](../src/bot/evaluate-trading-strategy.ts), [evaluate-position.ts](../src/bot/evaluate-position.ts) |
| **P3.4** | 🟠 High | "Volume" sums unlike fields (size/bidSize/dayVolume/OI) → meaningless | **[C+X]** | [option-service.ts](../src/core/option-service.ts) |
| **P3.5** | 🟡 Med | Liquidity/DTE filters are advisory, not enforced | **[X]** | [get-option-candidates-for-symbol.ts](../src/bot/get-option-candidates-for-symbol.ts), [option-contracts.ts](../src/bot/option-contracts.ts) |
| **P3.6** | 🟡 Med | Allocation design decisions (worst-first, closing-in-exposure, cap semantics, plan/exec parity, stale positions, grouping) | **[C+X]** | [run-cycle.ts](../src/bot/run-cycle.ts), [execute-position-evaluations.ts](../src/bot/execute-position-evaluations.ts), [manage-allocation.ts](../src/bot/actions/manage-allocation.ts) |
| **P4.x** | 🟢 Low | Robustness & hygiene (streamer lifecycle, double-cancel, logging/PII, persistence, IPC timeout, stale socket, global rejection handler, dead code, pm2, README, price-as-string) | mixed | various |
| **P5.x** | 🟢 Process | Tests + sandbox dry-run + staged live verification | **[C+X]** | `src/**/tests/*` |

> **Current baseline (Codex verified):** `npm ci` (55 pkgs, 0 vulns), `npm run typecheck` ✅, `npm test` ✅ 7/7, `npm run build` ✅. Local Node v22. So the project is healthy to *build*; every item below is runtime/semantics, not compile errors.

---

# Phase 1 — Unblock (make it able to run and act at all)

### P1.1 — Fix market-session parsing **[X] [C✓]**
**Problem.** [market-sessions.ts:172-187](../src/core/market-sessions.ts#L172) reads `opens-at`/`closes-at`/`session-status`/`is-open` (+ camelCase). Per the [market-sessions spec](https://developer.tastytrade.com/open-api-spec/market-sessions/), `GET /market-time/equities/sessions/current` returns **`open-at`**, **`close-at`**, **`close-at-ext`**, **`start-at`**, **`state`**. The code never reads `close-at` or `state`, so `closesAt` is empty → `inferIsRegularSession` (duration ≤ 7.5h) fails → `isRegularSession=false` → `isEquityOptionsMarketOpen` returns false during regular hours → the scheduler waits forever.

**Change.** Add the real keys to the lookup arrays and key the open/regular decision on documented fields:
- `state` (e.g. `Open`/`Closed`/`Pre-market`) for status.
- `open-at` / `close-at` for the regular window; treat regular session as `now >= open-at && now < close-at`.
- `close-at-ext` for extended hours, *not* counted as equity-options-open unless intentional.
- Keep the "default to CLOSED on unparseable" fail-safe — that part is good.

**Verify first.** Capture one real `/market-time/equities/sessions/current` response (read-only) and confirm the exact field names before hardcoding. (See P5.0.)

**Tests.** `market-sessions.test.ts`: feed a recorded open-session payload → `isEquityOptionsMarketOpen === true`; a closed/pre-market payload → false; a malformed payload → false.
**Done when.** With a recorded regular-session payload, the scheduler reports the market open.

---

### P1.2 — Normalize position response shape (kebab-case) **[C+X] [C✓]**
**Problem (root cause).** Positions come back **kebab-case** and the SDK does not transform keys, but [evaluate-position.ts:29-79](../src/bot/evaluate-position.ts#L29) and [order-utils.ts:29-122](../src/bot/actions/order-utils.ts#L29) read **snake_case**. Confirmed live consequences:
- `position.underlying_symbol` → `undefined` → grouping falls back to the leg's OCC `symbol` → **every leg becomes its own group** ([evaluate-position.ts:30](../src/bot/evaluate-position.ts#L30)).
- `position.average_open_price` → `undefined` → `weightedAverageFill` falls back to the **current bid** → `currentReturn ≈ 0` for everything ([evaluate-position.ts:68](../src/bot/evaluate-position.ts#L68)).
- `position.mark_price`/`close_price` → `undefined` → quote fallback is 0.
- `position.quantity_direction`/`cost_effect` → `undefined` → `isShortPosition` always false → wrong close action ([order-utils.ts:28](../src/bot/actions/order-utils.ts#L28)).
- `position.instrument_type` → `undefined` → `normalizeInstrumentType(undefined).trim()` **throws** when building a close order ([order-utils.ts:121](../src/bot/actions/order-utils.ts#L121)).
- (`quantity` and `multiplier` are single words, so those happen to work — which is why it *looks* half-alive.)

Note John already solved this for **balances** with a dual-key reader ([account-balance.ts](../src/core/account-balance.ts)) — positions just never got the same treatment.

**Change.** Add a single **normalization boundary** so the rest of the code sees one stable shape.
- **New file:** `src/core/normalize.ts` — `normalizePosition(raw): CurrentPosition` that maps kebab→camel (or snake, pick one and commit) for every field used, including the currently-missing **`streamer-symbol`** (needed by P1.3). Add `normalizeBalance` too and route balances through it as well, retiring the ad-hoc dual-key reads over time.
- Call it in [get-position-evaluations.ts:12](../src/bot/get-position-evaluations.ts#L12) right after `getPositionsList`, and anywhere else positions enter (seed-symbol).
- Update [types.ts:55](../src/core/types.ts#L55) `CurrentPosition` to the post-normalization shape, and **add `streamerSymbol`**.

**Tests.** `normalize.test.ts`: feed a recorded kebab-case position → assert `underlyingSymbol`, `averageOpenPrice`, `quantityDirection`, `instrumentType`, `streamerSymbol` are populated. Then an `evaluate-position` test asserting a known cost basis ≠ current bid.
**Done when.** Grouping collapses multiple legs of the same underlying into one group, and `weightedAverageFill` reflects the real open price, not the bid.

---

### P1.3 — Quote with the dxfeed streamer-symbol, not the OCC symbol **[C] [C✓]**
**Problem.** The quote streamer only emits events for **streamer-symbols** (e.g. `.AAPL240119C150`), but the code quotes with **OCC** symbols:
- [evaluate-position.ts:62](../src/bot/evaluate-position.ts#L62) `getBidAskForSymbol(position.symbol)` — `position.symbol` is the OCC leg symbol.
- [manage-allocation.ts:315](../src/bot/actions/manage-allocation.ts#L315) `getBidAskForSymbol(candidate.symbol)` — `candidate.symbol = strike.call` (OCC).

Result: `getBidAskForSymbol` times out → `null` → price 0 → routes filtered → "candidate quote unavailable." [seed-symbol.ts:151](../src/bot/seed-symbol.ts#L151) already does it right (quotes the streamer-symbol, orders the OCC) — copy that pattern.

**Change.**
- Quote positions with `position.streamerSymbol` (from P1.2 normalization).
- Quote candidates with `candidate.streamerSymbol`; keep `candidate.symbol` (OCC) only for the order leg.
- (Combined with P3.2, ensure the candidate's `symbol`/`streamerSymbol` are the correct *side*.)

**Tests.** Unit-test the selectors to assert `streamerSymbol` is a dotted dxfeed symbol and `symbol` is OCC; an integration smoke test (sandbox) that a known liquid contract returns a non-null bid/ask.
**Done when.** Position and candidate quotes return real bid/ask in sandbox.

---

### P1.4 — Treat missing/zero/`NaN` pricing as "do not trade" **[C+X]**
**Problem.** When cost basis or quote is 0/missing, `evaluateTradingStrategy` divides by `weightedAverageFill` ([evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106)) → `NaN`; `NaN >= tp` and `NaN <= -0.30` are both false → group silently defaults to `MANAGE_ALLOCATION` and may get allocated capital with no valid price.

**Change.** Guard `evaluateTradingStrategy` (and `buildExecutionStrategy`) for non-finite/≤0 `weightedAverageFill` or missing quotes → return a `SKIP`/no-op action with a recorded reason, never `MANAGE_ALLOCATION`. Mirror the guard already in `evaluatePositionGroup`.
**Tests.** Strategy test: metrics with `weightedAverageFill=0` → action is skip, not manage.
**Done when.** A position with no quote is skipped and logged, not bought.

---

# Phase 2 — Safety rails (before a single live order)

### P2.1 — One environment source + validation **[C+X]**
**Problem.** `baseUrl` from `BASE_URL` (prod) but `accountStreamerUrl` hardcoded to cert ([tastytrade-client.ts:6-12](../src/core/tastytrade-client.ts#L6)); env vars cast `as string` with no check; pm2 injects only the socket + schedule flag, so it relies on a `.env` in cwd.

**Change.**
- **New file:** `src/core/env.ts` — read `TASTYTRADE_ENV=prod|sandbox`, validate `API_CLIENT_SECRET`/`API_REFRESH_TOKEN` are present, and **throw a clear error at startup** if anything's missing.
- Build the client from `TastytradeClient.ProdConfig` / `SandboxConfig` and override only secrets, so REST + streamer URLs can never diverge.
- Update [.env.example](../.env.example) to document `TASTYTRADE_ENV` and **default to sandbox**.

**Done when.** Missing secret → process exits at boot with a named error; prod and streamer URLs always match the selected env.

### P2.2 — Global live-trading lock **[C+X]**
**Problem.** The scheduler's `inFlight` flag is local; IPC `bot:runCycle`/`bot:seedSymbol` call straight through ([ipc-server.ts:103](../src/ipc-server.ts#L103)). Two cycles can run on the same account, each cancelling then placing → duplicate buy-to-opens.
**Change.** **New file:** `src/core/run-lock.ts` exporting `withLiveTradingLock(fn)` (a process-wide async mutex). Wrap `runBotCycle` and `seedSymbol`; let read-only `getRunCyclePreview` run without it. If the lock is held, reject the IPC command with "cycle already running."
**Done when.** Triggering `runCycle` during a scheduled cycle is rejected, not run concurrently.

### P2.3 — Guard + dry-run every order path **[C] + [X]**
**Problem.** `createOrder` is awaited in bare loops with no try/catch ([manage-allocation.ts:215](../src/bot/actions/manage-allocation.ts#L215), [close-position.ts:37](../src/bot/actions/close-position.ts#L37)); one rejection aborts the cycle, leaves earlier orders live, skips `appendRunHistory`. Only `seedSymbol` dry-runs first.
**Change.** **New file:** `src/bot/actions/place-order.ts` — `placeOrderSafely(account, payload)` that (1) calls `postOrderDryRun` first, (2) wraps `createOrder` in try/catch, (3) returns a per-leg `{placed, error, dryRunCost}` result. Route all three paths (seed/allocation/close) through it. Persist run history **even on partial failure**, and `continue` instead of throwing.
**Done when.** A single rejected leg is recorded and the cycle finishes; history is written.

### P2.4 — Make EOD liquidation actually liquidate **[X]**
**Problem.** Strategy intends "liquidate instantly" at 12:55, but close orders are **Day limit** at weighted prices, and after 12:30 route weights are zero so pricing falls back to midpoint ([order-utils.ts:68](../src/bot/actions/order-utils.ts#L68)) — which may not fill, leaving positions open exactly when you want out.
**Change.** Define an explicit **liquidation mode**: marketable limit (e.g. cross the spread by N ticks) or `Market` if acceptable for the instrument; bypass the route-weight blend in liquidation. Verify with dry-run + a small sandbox test.
**Done when.** A 12:55 close produces a marketable price that fills in sandbox.

---

# Phase 3 — Strategy correctness

### P3.1 — Pacific time, computed explicitly **[C+X]**
**Problem.** Gates use `new Date().getHours()` and call it "PST," but read **host-local** time; Codex observed the host is **America/Chicago**, so the 12:30 risk-off fires ~2h early. ([evaluate-trading-strategy.ts:88](../src/bot/evaluate-trading-strategy.ts#L88), [run-cycle.ts:203](../src/bot/run-cycle.ts#L203))
**Change.** **New file:** `src/core/time.ts` — `getPacificMinutes(date)` via `Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour12:false,...})`. Route all gating through it. Call it **Pacific** (PST/PDT) since DST applies. Already-correct string variant (`...ForPstTime`) can delegate to it.
**Tests.** Run the strategy with `TZ=America/Chicago` and `TZ=UTC` and assert identical gate decisions.
**Done when.** Gate decisions are timezone-independent.

### P3.2 — Side-aware candidate selection **[C+X]**
**Problem.** [option-contracts.ts:112-143](../src/bot/option-contracts.ts#L112) always sets `symbol: strike.call`, `streamerSymbol: strike['call-streamer-symbol']`, and filters `strike < underlyingPrice` (ITM-for-calls), regardless of `side`. So a put group buys calls, and put "ITM" is actually OTM.
**Change.** Make `chooseOptionCandidates` side-aware: for `side==='put'` use `strike.put`/`put-streamer-symbol` and `strike > underlyingPrice`; set `symbol`/`streamerSymbol` to the chosen side. Ensure `getCandidateSide` flows through to selection.
**Tests.** `option-contracts.test.ts`: put group → put OCC + put streamer-symbol + ITM-for-put strike.
**Done when.** A put position selects puts.

### P3.3 — Direction-aware return math + verified cost-basis units **[X] short + [C] units**
**Problem (two layers).**
- **Short inversion [X]:** return is always `(currentBid - WAF)/WAF` ([evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106)) — long math. For shorts, lower price = profit; the formula inverts P/L. The close util already contemplates shorts (`Buy to Close`), so shorts can occur.
- **Units [C]:** once P1.2 makes `average-open-price` readable, confirm whether it's **per-share** (e.g. 2.50) or **per-contract** (e.g. 250). The quote (`bidPrice`) is per-share. If `average-open-price` is per-contract, every return is off by ~100×.
**Change.** Compute return with position direction (`+1` long / `-1` short) and ensure both sides of the ratio share units (divide `average-open-price` by the multiplier, or multiply the quote by it — whichever the captured payload dictates). Keep long/short metrics separate when a group mixes directions.
**Verify first.** Use the captured payload (P5.0) to settle the units — *do not guess*.
**Tests.** `evaluate-trading-strategy.test.ts`: known long position at +20% and known short at +20% both report +0.20; a per-contract-vs-per-share fixture pins the expected ratio.
**Done when.** Long and short P/L are correct and unit-consistent.

### P3.4 — Make "volume" a real metric **[C+X]**
**Problem.** [option-service.ts:118-194](../src/core/option-service.ts#L118) reads `size ?? volume ?? v ?? tradeVolume` first and **sums** it across all event types over 5s, mixing per-trade size, `bidSize`/`askSize`, cumulative `dayVolume`, and `openInterest` — none of which is "session volume." It gates `MIN_VOLUME=120`.
**Change.** Decide the intended metric (likely **day volume** or **open interest**), subscribe to **Summary** (and/or Trade) only, read `dayVolume`/`openInterest` as a **snapshot** (don't sum), and drop the size/bidSize/askSize branches and the dead array-scraper.
**Done when.** The candidate filter reflects a real, documented liquidity metric.

### P3.5 — Decide which filters are hard requirements **[X]**
**Problem.** `meetsVolumeRequirement` is computed but not enforced before trading, and fallback expirations are allowed when the target DTE band is empty ([get-option-candidates-for-symbol.ts:111](../src/bot/get-option-candidates-for-symbol.ts#L111), [option-contracts.ts:158](../src/bot/option-contracts.ts#L158)).
**Change.** Make min-volume a hard gate (reject below threshold) and make DTE fallback **opt-in** (config flag), logging when a fallback was used.
**Done when.** Sub-threshold/illiquid contracts are not silently traded.

### P3.6 — Allocation design decisions (need John's call) — present, don't silently change
These are judgment calls, not clear bugs. Surface them; change only with John's intent.
- **Worst-return-first allocation — ⚖️ the two reviews disagree.** Codex lists "sorts allocation candidates by worse current return first" as a *good idea*; Claude flags it as **averaging-down into losers**. Decide: add to losers (mean-reversion) or winners (momentum)? ([execute-position-evaluations.ts:117](../src/bot/execute-position-evaluations.ts#L117))
- **Closing groups counted as exposure [C]:** `buildInitialBudget` sums market value over *all* groups, including ones being closed this cycle, understating headroom. Exclude `CLOSE_POSITION` groups when sizing new buys. ([manage-allocation.ts:443](../src/bot/actions/manage-allocation.ts#L443))
- **Weight-cap semantics [C]:** `applyPositionSizeWeightCaps` is fed **whole-portfolio** exposure, so it loosens the ask cap as the account grows — backwards for a per-position guard. Decide per-position vs portfolio and rename accordingly. ([run-cycle.ts:217](../src/bot/run-cycle.ts#L217))
- **Plan/exec parity [C] + stale positions [X]:** the printed plan re-fetches quotes/candidates and sorts differently than live execution, and closes don't wait for fills before allocating from stale balances. Either make the plan binding, or label it an estimate and refresh state after closes. ([run-cycle.ts:230](../src/bot/run-cycle.ts#L230), [execute-position-evaluations.ts:120](../src/bot/execute-position-evaluations.ts#L120))
- **Grouping hides mixed-risk legs [X]:** one blended return drives one action for all legs of an underlying. Track single legs separately unless a known multi-leg structure is recognized. ([evaluate-position.ts:33](../src/bot/evaluate-position.ts#L33))

---

# Phase 4 — Robustness & hygiene (low risk, do after the above)

| ID | Item | Source | File |
|----|------|--------|------|
| P4.1 | Quote streamer: connect once / disconnect in `finally` (currently leaks connections/listeners) | [C+X] | [market-data.ts:80](../src/core/market-data.ts#L80) |
| P4.2 | Cancel live orders **once** (currently twice; only the 2nd is recorded) | [C+X] | [run-cycle.ts:309](../src/bot/run-cycle.ts#L309) |
| P4.3 | Stop logging full account/order payloads to stdout; redact account #, summarize, add `pm2-logrotate` | [C] | [ipc-server.ts:235](../src/ipc-server.ts#L235), [run-cycle.ts:353](../src/bot/run-cycle.ts#L353) |
| P4.4 | Persist `last-run-state` (in-memory only; wiped on pm2 restart) and return a deep copy | [C] | [last-run-state.ts](../src/bot/last-run-state.ts) |
| P4.5 | `runs.ndjson`: add rotation/retention; tail-read instead of whole-file | [C] | [run-history.ts:71](../src/bot/run-history.ts#L71) |
| P4.6 | IPC client: add a timeout; document the one-line-response invariant | [C] | [ipc-client.js:45](../ipc-client.js#L45) |
| P4.7 | Stale-socket cleanup: probe before unlinking; don't steal a live socket; exit cleanly | [C] | [ipc-server.ts:267](../src/ipc-server.ts#L267) |
| P4.8 | Add `process.on('unhandledRejection'/'uncaughtException')` logging | [C] | [index.ts](../src/index.ts) |
| P4.9 | Remove dead/scratch code: `src/bot/index.ts` (empty IIFE) and gate/remove `bot:johnsTestRun` (dumps account data) | [C] | [johns-test-run.ts](../src/bot/johns-test-run.ts) |
| P4.10 | pm2 `interpreter` is a hardcoded `/home/deploy/...node` path that doesn't exist here → use `"node"` or env-driven | [X] | [ecosystem.config.cjs:9](../ecosystem.config.cjs#L9) |
| P4.11 | README command typo `fetchOptionChainsWithVolume` → `fetchOptionChainWithVolume`; sync command list | [C+X] | [README.md](../README.md) |
| P4.12 | Order `price` returned as string; schema says number → confirm via dry-run on all paths (covered by P2.3), switch `roundOrderPrice` to number if dry-run rejects | [X] | [order-utils.ts:82](../src/bot/actions/order-utils.ts#L82) |
| P4.13 | Equity `.AAPL` normalization works by accident; wrong for true indices (SPX/VIX) | [C] | [market-data.ts:11](../src/core/market-data.ts#L11) |

---

# Phase 5 — Tests & verification (do alongside, gate live trading on it)

- **P5.0 — Capture ground-truth payloads first (read-only, sandbox).** Before editing parsers, save one real response each for `/market-time/equities/sessions/current`, `/accounts/{a}/positions`, `/accounts/{a}/balances`, and a nested option chain. These settle every field-name/unit question (P1.1, P1.2, P3.3) and become test fixtures. *This is the highest-leverage 20 minutes in the whole plan.*
- **P5.1 — Unit tests for every Phase 1–3 fix**, using the P5.0 fixtures: session parsing, position normalization, put selection, long/short + unit-correct returns, skip-on-missing-quote, streamer-symbol selection, volume metric. (Codex noted current tests cover *only* schedule blending + ask caps — the risky paths are untested.)
- **P5.2 — Strengthen the existing weak test:** the 50%-cap test passes an ask (0.9) already under the cap, so it never exercises a reduction. Add a `>1.0` input.
- **P5.3 — Sandbox dry-run pass:** run a full cycle against `TASTYTRADE_ENV=sandbox` with `postOrderDryRun` on every path; confirm no exceptions and sane plans.
- **P5.4 — Staged live test:** only after P5.3, a single tiny live order in production, watched, before re-enabling the scheduler.

---

## Suggested execution order (checklist)
```
[ ] P5.0  capture real sandbox payloads (fixtures)        ← do this first
[ ] P1.1  market-session field names
[ ] P1.2  position kebab-case normalization (+ src/core/normalize.ts)
[ ] P1.3  quote with streamer-symbol everywhere
[ ] P1.4  skip on missing/NaN pricing
[ ] P2.1  env single-source + validation (+ src/core/env.ts)
[ ] P2.2  global live-trading lock (+ src/core/run-lock.ts)
[ ] P2.3  dry-run + try/catch order wrapper (+ src/bot/actions/place-order.ts)
[ ] P2.4  real EOD liquidation
[ ] P3.1  Pacific time (+ src/core/time.ts)
[ ] P3.2  side-aware candidate selection
[ ] P3.3  long/short + unit-correct returns
[ ] P3.4  real volume metric
[ ] P3.5  enforce liquidity/DTE filters
[ ] P3.6  allocation design — DECIDE WITH JOHN (worst-first ⚖️, exposure, caps, parity, grouping)
[ ] P4.*  robustness & hygiene
[ ] P5.1+ tests, sandbox dry-run, then staged live
```

## New files this plan introduces
| File | Purpose | Step |
|------|---------|------|
| `src/core/normalize.ts` | kebab→typed normalization boundary for positions/balances/sessions | P1.2 |
| `src/core/env.ts` | `TASTYTRADE_ENV` resolution + secret validation + url selection | P2.1 |
| `src/core/run-lock.ts` | process-wide live-trading mutex | P2.2 |
| `src/bot/actions/place-order.ts` | dry-run + guarded `createOrder` wrapper | P2.3 |
| `src/core/time.ts` | explicit America/Los_Angeles time helpers | P3.1 |
| `src/**/tests/*.test.ts` | coverage for every fixed path, from P5.0 fixtures | P5 |

## Decisions only John can make (put these in the email)
1. **Sandbox or production?** (P2.1) The whole config is contradictory today.
2. **Add to losers or winners?** (P3.6) Codex and Claude read the worst-first sort opposite ways.
3. **What does `MIN_VOLUME=120` mean** — day volume, OI, or quote size? (P3.4)
4. **Should the bot ever trade puts?** (P3.2) If never, that's a much smaller fix.
5. **Is the 12:55 "liquidate" meant to be marketable** (accept slippage) or stay passive? (P2.4)
6. **Is the printed plan meant to be binding** or just an estimate? (P3.6)

---
*Cross-references: see [overview_claude.md](overview_claude.md), [api_claude.md](api_claude.md), [strategy_claude.md](strategy_claude.md), [architecture_claude.md](architecture_claude.md), and Codex's [api_connectivity_codex.md](api_connectivity_codex.md), [execution_flow_and_strategy_codex.md](execution_flow_and_strategy_codex.md), [priority_next_steps_codex.md](priority_next_steps_codex.md), [project_health_and_verification_codex.md](project_health_and_verification_codex.md).*
