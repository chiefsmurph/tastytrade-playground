# Remaining Work — After Codex's Second Pass (Claude)

> **Date:** 2026-06-22 · **Context:** Codex implemented essentially the entire prior punch list. This is the short list of what's actually left, for the next pass. Verified against the working tree (build green, 20/20 tests).

## ✅ Closed since the last review
Config default + profiles + `configuration_codex.md` + `john_handoff_codex.md`; `config:show`/`config:reload`; startup safety banner; `bot:panic` (sticky kill switch); `LIVE_TRADING_LOCKED` error code; `validateRuntimeEnvironment()` at startup; last-run-state load-on-boot; run-history pruning; config-driven `marketOpenTime`/`allocationCutoffTime`/`liquidationTime`; new safety tests (dry-run failure, live-interlock success, lock contention, short P/L, profiles); dead files removed.

---

## 🔴 Must do before ANY live order (external — can't be closed by code)
1. **Verify `costBasisUnit` against a real sandbox positions payload.** Still defaults to `perShare` on an assumption. Pull one real position, compare `average-open-price` to a known fill; if ~100× the premium, set `perContract`. *This gates whether the strategy is correct at all.* (Already in the handoff go-live checklist — keep it as a hard gate.)
2. **Run one full dry-run cycle in sandbox.** Everything is still verified only against offline fixtures; nothing has touched a live broker. Confirm no exceptions and no unexpected `SKIP` reasons, then one supervised tiny live order, then re-arm the scheduler.

## 🟡 Worth doing (small correctness / robustness)
3. **`config:reload` + environment switching.** Reload calls `tastytradeApi.updateConfig(...)`. Confirm `updateConfig` actually rebuilds the HTTP client base URL — and **consider refusing to switch `environment` (sandbox↔production) at runtime**, requiring a restart instead, so you can never end up with a half-switched client pointing REST and streamer at different environments.
4. **Confirm the quote-streamer connection is reused/disconnected, not leaked.** The original review flagged `market-data.ts` calling `quoteStreamer.connect()` on every lookup without `disconnect()`. Verify this was addressed (connect-once or disconnect-in-finally); a long-running bot otherwise accumulates sockets.
5. **Use normalized `markPrice` as a quote fallback.** `markPrice`/`closePrice` are normalized but unused. When `getBidAskForSymbol` times out, falling back to `markPrice` (instead of SKIP) would keep the bot working through brief streamer gaps.
6. **Add two more strategy tests:** a group below `maxLossForNewAllocationPct` is skipped with the "not adding to losing position" reason; and a group with a missing quote yields `SKIP` (not `MANAGE_ALLOCATION`). These lock in the two behaviors most likely to silently regress.

## 🟢 Nice-to-have cleanup
7. Route balances through a single `getNormalizedAccountBalance()` helper (currently normalized inline at 3 sites — a new caller could forget).
8. Make `isRegularSession` treat `state === 'Open'` as the primary signal, with the ≤7.5h duration check as fallback only.
9. Remove the redundant initial sort in `run-cycle.ts` (both allocation-priority branches re-sort) and the long-only bid-based `currentReturn` fallback in `evaluate-trading-strategy.ts` (unreachable, but wrong-direction for shorts).
10. Document that **re-arming after `bot:panic` requires a process restart** (it's intentionally sticky across `config:reload`).

## 📦 Process
11. **Commit this to a branch.** ~38 files + new modules are uncommitted in the working tree, and the old `docs/` files show as deletions from the `docs/Initial_look_and_plans/` move. For John to cleanly diff "what you did vs. his," land it as a single branch/commit with a clear message (and decide whether to keep the moved docs or restore them at their old paths).
