# Implementation Review — Codex Stabilization Pass (Claude)

> **What this is:** an independent verification of the large stabilization change set Codex implemented, checked against the plan *and* the real `@tastytrade/api` SDK / Tastytrade docs / the committed fixtures. Produced by a 4-agent review (one per change-cluster) plus a direct build/test run.
>
> **Reviewer:** Claude (Opus 4.8) · **Date:** 2026-06-22 · **Change set:** uncommitted working tree, 36 files modified + ~15 new, +1,105/−1,692 lines, src 4,064 → 5,602 LOC.
>
> **Method:** `git diff HEAD` on every modified file, full reads of new modules, cross-checked field names against `src/core/__fixtures__/*.json` and the official API, traced call sites with grep, and ran `typecheck` + `test` + `build`.

---

## Bottom line

**The bot went from "inert and unsafe" to "correct and safe-by-default," and the dangerous parts were done right.** Independently confirmed: typecheck clean, **14/14 tests** pass, build succeeds. Every blocker and every money-critical fix from the plan **landed and verified correct** — including the things that are easy to fake and hard to actually get right (the OCC-vs-streamer split end-to-end, direction-aware short P/L with correct sign, marketable-limit liquidation with correct tick math, and a single live-order chokepoint).

The remaining items are **mostly low-severity polish**, with **one genuine gap against your stated goal** (the config isn't yet the commented, tweakable, "wow" experience you asked for) and **one pre-live correctness check** that no amount of code can settle without a real payload (the cost-basis units). Net: this is a strong, trustworthy pass.

---

## Scorecard — every plan item, verified

| Plan item | Status | Note (verified evidence) |
|-----------|--------|--------------------------|
| **P1.1** Market-session field names | ✅ Correct | Reads `open-at`/`close-at`/`close-at-ext`/`start-at`/`state`; open = `now ∈ [open-at, close-at)`; `state` enum honored; fail-closed; `close-at-ext` deliberately excluded |
| **P1.2** Kebab-case normalization | ✅ Correct | `normalize.ts` maps every field incl. `streamer-symbol`; positions normalized at fetch; **missing fields → typed SKIP**, not silent 0 |
| **P1.3** OCC vs streamer-symbol split | ✅ Correct | Candidates carry `orderSymbol`/`quoteSymbol`/`streamerSymbol`; quotes use streamer, order legs use OCC — end-to-end incl. close orders |
| **SDK env** consolidation | ✅ Correct | Built from `ProdConfig`/`SandboxConfig`; prod-REST + cert-streamer split-brain gone |
| **P2.1** Env validation | ⚠️ Partial | Fail-fast *works* but only as a side effect of client import; the dedicated `validateRuntimeEnvironment()` is **dead code** |
| **P2.2** Global run-lock | ✅ Correct | Real process-wide mutex on `runBotCycle` + `seedSymbol`; released in `finally`; preview unlocked (busy-error isn't machine-typed — minor) |
| **P2.3** Safe order placement | ✅ Correct | **Exactly one** `createOrder` call site, gated by `placeOrderSafely` (dry-run → double interlock → guarded submit) |
| **Cancel-once** | ✅ Correct | Duplicate cancel removed; single owner records result into history |
| **Partial-failure persistence** | ✅ Correct | Per-order errors caught; cycle continues; history/last-run written unconditionally |
| **P2.4** EOD liquidation | ✅ Correct | Marketable-limit: buy-to-close `ask + ticks×0.01`, sell-to-close `bid − ticks×0.01`, one-tick floor; **only** in the 12:55 LIQUIDATE path |
| **P3.1** Pacific time | ✅ Correct | `Intl` America/Los_Angeles in the live path; raw `getHours()` gating gone; timezone-independence test added |
| **P3.2** Side-aware selection | ✅ Correct | Puts → put OCC + put streamer + ITM-for-puts (`strike > underlying`); `enabledSides` enforced; put tests pass |
| **P3.3** Long/short P/L + units | ✅ Correct | Short = `(WAF − ask)/WAF` (positive when ask < open); cost basis normalized by `costBasisUnit` |
| **P3.4** Skip semantics | ✅ Correct | Missing quote / NaN / bad multiplier / unknown direction → SKIP, surfaced in history |
| **P3.5** Real volume + hard gates | ✅ Correct | `dayVolume` & `openInterest` tracked separately via `Math.max` snapshot; both hard-gated; DTE fallback off by default |
| **P3.6** Conservative allocation | ✅ Correct | No adding to losers past `maxLossForNewAllocationPct`; closing groups excluded from exposure; `underweightThenBestReturn` implemented |
| **P4.x** Ops hygiene | ✅ Mostly | Redacted logging, IPC timeout, socket-probe, scheduler config, pm2 portable, README/`.env` updated, `johnsTestRun` unregistered, global rejection handlers — all done |

---

## What's genuinely impressive (tell John)

- **Single safety chokepoint.** Every live order in the entire codebase flows through one `createOrder` call behind a double interlock (`config.liveOrders.enabled` **and** `BOT_ENABLE_LIVE_ORDERS=true`), defaulting to **sandbox + live-off + dry-run-only**. This is the strongest structural guarantee possible for "don't accidentally trade real money."
- **The root-cause fix is real.** The kebab-case normalization boundary fixes the bug that made the old bot silently compute ~0% returns on every position. Missing fields now produce an observable SKIP instead of a bad order.
- **The fiddly math is correct.** Short P/L sign, liquidation tick conversion, and Pacific-time gating are exactly the places this kind of project usually gets wrong — and they're right, with fixture-backed tests proving timezone-independence and put selection.
- **Defense-in-depth logging.** Redaction masks account numbers *and* strips token/secret keys recursively; raw payload dumps are gated off by default.

---

## Punch list — prioritized for the next pass

Ordered by what I'd fix first. Severity is blast radius; all are post-"it works," none are blockers to the fixes already landed.

### 🟠 HIGH
1. **Config UX is the headline ask and it's only ~30% there.** Strict JSON can't hold comments; there's no committed default and no profiles. **→ See [config_proposal_claude.md](config_proposal_claude.md) for the full design** (annotated JSONC + conservative/balanced/aggressive profiles + hot-reload + startup banner). This is the "blow him away" piece.

### 🟡 MEDIUM
2. **Wire `reloadBotConfig()` to an IPC command** (`config:reload`). It exists but nothing calls it, so today every config tweak needs a full restart — which defeats "easy to tweak." Add `config:show` (redacted effective config) too.
3. **Document `core:cancelAllLiveOrders`.** It's registered and reachable over IPC but missing from the README — an order-cancelling command that operators can't discover is a footgun.
4. **Add the missing safety tests.** The plan specified tests for `placeOrderSafely` (live-submit-fails-continues, success path) and run-lock contention; only the "live disabled" case exists. For a live-money system, the partial-failure and concurrency guarantees should be locked in by tests. Also add short-P/L-sign and skip-semantics tests (the load-bearing arithmetic).

### 🟢 LOW (cleanup)
5. **Call `validateRuntimeEnvironment()` explicitly at the top of `index.ts`** so the secret check is an intentional, ordering-independent startup gate with a friendly message — not an opaque module-load throw. (It's currently dead code.)
6. **`last-run-state` is write-only** — it persists to `data/last-run-state.json` but never loads it on boot, so durability is illusory. Either load on startup or drop the write and document it as in-memory.
7. **`runs.ndjson` grows unbounded** — reads are tail-bounded (good) but the file is never rotated/capped. Add a simple size cap or document an external logrotate expectation.
8. **Delete the dead files** `src/bot/johns-test-run.ts` (still contains un-redacted account dumps, just unregistered) and `src/bot/index.ts` (empty IIFE). Both are unreferenced; removal is safe.
9. **Give `LiveTradingLockError` a stable `code`/`name`** in the IPC response so a UI can distinguish "a run is in progress" from a broker error and retry.
10. **Route balances through one `getNormalizedAccountBalance()` helper** (currently normalized inline at 3 sites — a new caller could forget and read raw kebab keys → 0).
11. **`isRegularSession`** should treat `state === 'Open'` as the primary signal, keeping the ≤7.5h duration heuristic as fallback only.
12. **Drop the redundant initial sort** in `run-cycle.ts:248` (both `allocationPriority` branches re-sort, so it's dead) and the long-only bid-based `currentReturn` fallback in `evaluate-trading-strategy.ts:135` (unreachable but a footgun for shorts).

---

## ⚠️ The one pre-live correctness check no code can settle

**`costBasisUnit` defaults to `"perShare"` — that is an *assumption*, not a verified fact.** The fixtures README even notes it. This is the same units question from the very first review: is `average-open-price` returned per-share (`2.50`) or per-contract (`250`)? If it's per-contract and the config stays `perShare`, every return is off by ~100× and the strategy is wrong despite all the correct plumbing.

The good news: Codex's design makes this a **one-line config flip** once known. The required action is unchanged and unavoidable: **pull one real sandbox positions payload and compare `average-open-price` to a known fill before enabling live orders.** Put this as a hard gate in the go-live checklist.

---

## My additional hardening ideas (beyond both reviews)

- **A panic/kill switch.** An IPC command (`bot:panic`) that flips live-orders off, cancels all working orders, and stops the scheduler in one call. Cheap to add, exactly what you want at hand when real money is live.
- **Startup safety banner.** Echo the effective (redacted) posture once at boot: `🟢 SANDBOX · live-orders OFF · dry-run-only · minVol=120`. Makes "which mode am I in?" un-missable. (Detailed in the config proposal.)
- **Decouple the 12:30 / 12:55 cutoffs from the timezone.** They're hardcoded Pacific minutes; if someone changes `config.strategy.timezone`, the cutoffs silently drift from market close. Either surface them in config or assert `timezone === 'America/Los_Angeles'`.
- **Prove it end-to-end in sandbox.** None of this is exercised against a live broker yet. Before re-enabling the scheduler: one full dry-run cycle in `TASTYTRADE_ENV=sandbox`, confirm no exceptions and sane plans, *then* one supervised tiny live order. (This is plan P5.3–P5.4 and remains the real proof.)

---
*Companion: [config_proposal_claude.md](config_proposal_claude.md). Source reviews: [implementation_plan_claude.md](implementation_plan_claude.md), [implementation_plan_codex.md](implementation_plan_codex.md).*
