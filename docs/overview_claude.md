# Tastytrade Bot — Review Overview (Claude)

> **Read this one first.** It is the map; the other three files are the territory.
>
> - **Reviewer:** Claude (Opus 4.8), commissioned by Stephen, for John.
> - **Date:** 2026-06-21
> - **Scope:** Static review of the whole repo (~4,000 LOC) + verification of every Tastytrade API call against the official SDK source, the Tastytrade developer docs, and the dxfeed event model. **No `.ts` files were modified** — this is read-only feedback.
> - **What I could not do:** run the bot (no credentials, and it trades **real money on production** — see the safety note below), so anything depending on a live payload is flagged as *verify*, not *confirmed*.
> - **Companion files:** [api_claude.md](api_claude.md) · [strategy_claude.md](strategy_claude.md) · [architecture_claude.md](architecture_claude.md)

---

## The headline (John's primary question: "any bugs in how it connects to the API?")

**The connection and authentication are fundamentally sound — but the *market-data* side has a real, trade-stopping bug.** Concretely:

- ✅ **Auth is correct.** OAuth (`clientSecret` + `refreshToken` + `oauthScopes`) is configured the way the SDK intends, and `@tastytrade/api@7.0.2` (which is the **current** JS SDK, published May 2026) auto-refreshes the access token before every request. You do **not** need a manual `login()`/session call, and your REST calls will **not** 401 for lack of one. This was my single biggest suspicion going in, and it is **refuted** — you got this right.
- ✅ **Every REST call is correct.** Service names, endpoints, the order payload schema, and the cancel flow all match the published SDK exactly (full table in [api_claude.md](api_claude.md)).
- 🔴 **But the quote streamer is fed the wrong symbol in the allocation path.** `manage-allocation` prices contracts with the **OCC order symbol** instead of the **dxfeed streamer symbol**, so the quote never arrives, every allocation is sized from a zero/empty quote, and the `MANAGE_ALLOCATION` trade path is **effectively dead**. Your `seed-symbol` path does it correctly — the two paths disagree. This is the most important API bug. (`api-1`)
- 🟠 **The option "volume" number is not volume.** The 5-second streamer sample sums per-event bid/ask/trade *sizes*, which is meaningless, then gates candidates on it (`MIN_VOLUME = 120`). (`api-2`)

> ⚠️ **A note worth sending John verbatim:** you offered to share your `.env` so the code can be run. I'd push back. `BASE_URL` defaults to **`api.tastyworks.com` (production / real money)**, and a run cancels all live orders and places new ones. "Run it to see if it connects" is the same action as "place live trades." If we ever do run it, point it at the **cert/sandbox** environment with read-only scopes first. Static review + doc verification (what this is) is the safe way to answer "does it connect correctly," and it did.

---

## What this program actually is (one paragraph)

A long-running **intraday options-accumulation bot** for Tastytrade. One Node process exposes ~16 commands over a unix-socket IPC server and, when the US equity-options session is open, a scheduler periodically runs a **cycle**: resolve the account → fetch balances & open positions → group positions by underlying → snapshot a live bid/ask per leg → classify each group as `CLOSE_POSITION` or `MANAGE_ALLOCATION` using a **time-of-day decision engine** (take-profit target that decays through the morning, exposure that ramps 40%→100%, route weighting that shifts bid→ask) → cancel all live orders → place close/allocation limit orders. Runs persist to `data/runs.ndjson`. Production runs under pm2 on an esbuild bundle.

### End-to-end order of operations (one cycle)

1. `runBotCycle()` → `buildRunCycleContext()`: resolve account (`getCustomerAccounts`), fetch balances (`getAccountBalanceValues`), derive buying power and `totalCapital = net-liquidating-value + signed pending-cash`.
2. `getPositionEvaluations()`: `getPositionsList` → group by underlying → per group fetch bid/ask (quote streamer) → build quantity-weighted metrics → `evaluateTradingStrategy()` returns `CLOSE_POSITION` or `MANAGE_ALLOCATION`.
3. Compute time-of-day targets (DTE, exposure %, bid/mid/ask route weights), the dynamic take-profit target, and apply weight caps.
4. **Dry-run plan**: filter `MANAGE_ALLOCATION` groups, sort worst-return-first, size route orders against a running budget (for the printed preview only).
5. `cancelAllLiveOrders()` — then `executePositionEvaluations()` (which **cancels again**), submits close orders in parallel, then loops allocation orders sizing each against per-group exposure headroom.
6. `appendRunHistory()` + `setLastBotRunState()`.

> The clean dry-run-vs-live separation is a genuinely nice design instinct — but as built the two can diverge (see `strategy` doc), so the printed plan is an *estimate*, not a contract.

---

## Triage — everything, worst first

Severity is my judgment of blast radius; confidence is how sure I am. "Verify" = depends on a live payload or your intent.

| # | Sev | Conf | Finding | Where | Doc |
|---|-----|------|---------|-------|-----|
| api-1 | 🔴 Critical | High | Quote streamer fed OCC symbol, not streamer symbol → allocation path gets no quotes → effectively dead | [manage-allocation.ts:315](../src/bot/actions/manage-allocation.ts#L315) | API |
| str-1 | 🔴 Critical | **Verify** | Possible per-share (quote) vs per-contract (`average-open-price`) unit mismatch → every return ≈ −0.99 | [evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106) | Strategy |
| str-2 | 🔴 Critical | High | Candidate selector hardcoded to **calls** (and call-ITM strikes) — a put group buys calls | [option-contracts.ts:112](../src/bot/option-contracts.ts#L112) | Strategy |
| api-2 | 🟠 High | High | "Volume" sample sums per-event sizes — not real volume; gates `MIN_VOLUME=120` | [option-service.ts:118](../src/core/option-service.ts#L118) | API |
| str-3 | 🟠 High | High | Strategy clock assumes Pacific but reads host-local `new Date()` — every gate fires at the wrong time off-PST | [evaluate-trading-strategy.ts:88](../src/bot/evaluate-trading-strategy.ts#L88) | Strategy |
| arch-2 | 🟠 High | High | No re-entrancy lock — manual `bot:runCycle` + scheduler can run overlapping cycles, cancel/duplicate orders | [ipc-server.ts:103](../src/ipc-server.ts#L103) | Arch |
| arch-3 | 🟠 High | High | No try/catch around `createOrder` — one rejected order aborts the cycle, leaves partial orders, skips history | [manage-allocation.ts:215](../src/bot/actions/manage-allocation.ts#L215) | Arch |
| api-3 | 🟡 Med | High | `accountStreamerUrl` hardcoded to **cert/sandbox** while REST is prod (inert today; latent) | [tastytrade-client.ts:8](../src/core/tastytrade-client.ts#L8) | API/Arch |
| api-8 | 🟡 Med | Med | Quote streamer `connect()`s on every lookup, never `disconnect()`s → WebSocket/listener leak | [market-data.ts:80](../src/core/market-data.ts#L80) | API |
| str-4 | 🟡 Med | High | Weight cap keyed on **whole-portfolio** exposure, not per-position — loosens the ask cap as the account grows (inverted) | [run-cycle.ts:217](../src/bot/run-cycle.ts#L217) | Strategy |
| str-5 | 🟡 Med | High | Dry-run plan and live execution re-fetch quotes/candidates and sort differently → can diverge | [run-cycle.ts:230](../src/bot/run-cycle.ts#L230) | Strategy |
| str-6 | 🟡 Med | Med | Allocates to **worst-return-first** (averages down) and counts being-closed groups as exposure | [execute-position-evaluations.ts:117](../src/bot/execute-position-evaluations.ts#L117) | Strategy |
| arch-4 | 🟡 Med | Med | Full account/order payloads logged to stdout (pm2 persists them) — PII/token leak surface | [ipc-server.ts:235](../src/ipc-server.ts#L235) | Arch |
| arch-5 | 🟡 Med | High | No env-var validation — missing secret surfaces as an opaque mid-cycle error, not a clear boot failure | [tastytrade-client.ts:7](../src/core/tastytrade-client.ts#L7) | Arch/API |
| arch-6 | 🟡 Med | Med | Market-open detection is heuristic substring matching, no explicit US/Eastern or DST logic | [market-sessions.ts:83](../src/core/market-sessions.ts#L83) | Arch |
| str-7 | 🟢 Low | Med | "Mid" route falls back to full **ask** on one-sided quotes; no crossed-market guard | [manage-allocation.ts:70](../src/bot/actions/manage-allocation.ts#L70) | Strategy |
| str-8 | 🟢 Low | High | `cancelAllLiveOrders` runs **twice** per cycle | [run-cycle.ts:309](../src/bot/run-cycle.ts#L309) | Strategy/Arch |
| str-9 | 🟢 Low | Med | Unguarded divide-by-`weightedAverageFill` → `NaN` return silently defaults to `MANAGE_ALLOCATION` | [evaluate-trading-strategy.ts:106](../src/bot/evaluate-trading-strategy.ts#L106) | Strategy |
| api-4 | 🟢 Low | Med | Equity symbols normalized to `.AAPL`; works by permissive matching, wrong for true indices | [market-data.ts:11](../src/core/market-data.ts#L11) | API |
| api-10 | 🟢 Low | High | `AccountBalance` type declares snake_case keys the API never returns (kebab-case); saved by the dual-key helper | [types.ts:3](../src/core/types.ts#L3) | API |
| arch-7..15 | 🟢 Low/Info | mixed | Scheduler interval drift, in-memory last-run-state, unbounded NDJSON, IPC client no-timeout, stale-socket steal, dead code, esbuild externals, no global rejection handler, README drift | various | Arch |
| str-test | 🟡 Med | High | Tests cover only schedules/caps — **zero** coverage of return math, budgeting, candidate selection, plan/exec parity | [evaluate-trading-strategy.test.ts](../src/bot/tests/evaluate-trading-strategy.test.ts) | Strategy |

---

## The 3 things to verify before anything else

1. **`average-open-price` units** (str-1). Pull one real option position and compare `average-open-price` to your known fill premium. If it's ~100× the per-share premium, the bot's return math is comparing per-contract cost to per-share quotes and **every return is ≈ −0.99** — take-profit never fires, the stop always trips. If it's the per-share premium, this finding evaporates. *This one question gates whether the strategy works at all.*
2. **Has the allocation path ever actually placed an order?** (api-1). If the logs always say "candidate quote unavailable," that's this bug — the OCC-vs-streamer-symbol mismatch.
3. **What timezone is the host clock?** (str-3). The schedule is written for Pacific but reads local time. If the server isn't on PST, every gate is off by hours.

---

## Credit where it's due (so this isn't all red ink)

John got the hard, easy-to-get-wrong things **right**: the OAuth model, every REST endpoint and the order schema, the array shape of the nested option chain, the signed pending-cash math, a dollar-consistent exposure/budget model with a water-filling contract allocator (with an iteration cap), robust IPC framing, and a fail-safe "default to CLOSED / default to MANAGE-skip" instinct in several places. The bugs are concentrated in two spots — **streamer symbology** and **price-unit/timezone assumptions** — not spread across the codebase. That's a good sign about the author.

## How I'd frame the pushback to John

He asked a narrow question ("API connection bugs?") and the honest answer is *"connection's fine, but the thing that would actually lose you money isn't the connection — it's two unit/symbol assumptions and the lack of an order-placement safety net."* The interesting questions for him are in each doc's **"Open questions for John"** section — they're design decisions only he can answer (worst-first averaging-down? per-position vs portfolio cap? puts ever? binding plan or estimate?), and they're worth more than the bug list.
