# Architecture, Runtime & Operational Safety (Claude)

> Everything *around* the trading logic that decides whether this thing runs **reliably and safely** as a long-lived process placing real orders. Read-only review; no source files changed.

## Verdict

**The plumbing is better than average for a personal project — robust IPC framing, defensive history parsing, fail-safe market-session defaults — but it's missing the two safety nets a money-moving daemon most needs: a concurrency lock and error handling around order placement.** Those two (arch-2, arch-3) are the ones I'd fix before letting it run unattended.

### How the process runs
One Node process ([index.ts](../src/index.ts)) starts a unix-socket **IPC server** ([ipc-server.ts](../src/ipc-server.ts)) exposing ~16 commands, plus an optional **market-open scheduler** that, while the US equity-options regular session is open, periodically invokes `runBotCycle`. Operators talk to it by sending newline-delimited JSON over the socket (the [run](../run) wrapper / [ipc-client.js](../ipc-client.js)). Production runs under **pm2** on the esbuild bundle ([ecosystem.config.cjs](../ecosystem.config.cjs)) with `BOT_RUN_ON_SCHEDULE=true`.

### Startup → scheduled run (order of operations)
1. pm2 launches the bundle with `BOT_RUN_ON_SCHEDULE=true`, autorestart, one fork.
2. `index.ts` (at import) starts the IPC server, then conditionally starts the scheduler.
3. Importing the client module runs `dotenv` and builds the client from env vars **cast `as string`, unvalidated**.
4. The server unlinks any stale socket, listens, and registers signal/exit cleanup.
5. Each connection buffers data, splits on newline, parses JSON, routes via `commandHandlers`, writes a JSON response line.
6. The scheduler schedules the first tick immediately; each tick is guarded by `started` + `inFlight`, checks the equities session, and runs a cycle if open and the interval elapsed (60s back-off on error).
7. A cycle cancels all live orders, places close + allocation orders, appends run history, sets in-memory last-run state.
8. **The IPC `runCycle` command calls a cycle directly with no shared lock — so manual and scheduled cycles can overlap.**

---

## Findings

### 🟠 arch-2 — No re-entrancy lock: scheduler + IPC can run overlapping cycles
**Severity: High · Confidence: High · [ipc-server.ts:103](../src/ipc-server.ts#L103), [market-open-scheduler.ts:71](../src/bot/market-open-scheduler.ts#L71)**

The scheduler's `inFlight` flag only guards **its own** ticks. The IPC `bot:runCycle` command calls `runBotCycle()` directly, bypassing it. Run `runCycle` manually while a scheduled cycle is in flight and you execute **two cycles concurrently on the same account** — and since each starts with `cancelAllLiveOrders` then places orders, they can cancel each other's fresh orders or place **duplicate** buy-to-opens.

**Fix:** a single module-level async mutex around `runBotCycle` that both the scheduler and the IPC handler must acquire.

---

### 🟠 arch-3 — No try/catch around `createOrder`: one failure aborts the cycle, leaving partial orders
**Severity: High · Confidence: High · [manage-allocation.ts:215](../src/bot/actions/manage-allocation.ts#L215), [close-position.ts:37](../src/bot/actions/close-position.ts#L37)**

`createOrder` is awaited in sequential loops with **no try/catch** in `manage-allocation`, `close-position`, or `run-cycle`. Any single rejected order (margin, price band, market closed, transient 500) throws the **whole cycle**: earlier orders are already live and not rolled back, later orders never get placed, and `appendRunHistory`/`setLastBotRunState` never run — so the partial execution is **unrecorded**. For a money-mover, "fails halfway and forgets what it did" is the dangerous failure mode.

**Fix:** wrap each `createOrder` in try/catch, record per-leg success/failure, continue rather than abort, and persist run history even on partial failure.

---

### 🟡 arch-1 — Prod REST + cert/sandbox streamer URL
**Severity: High (per arch agent) / Medium (inert today) · Confidence: High · [tastytrade-client.ts:6](../src/core/tastytrade-client.ts#L6)**

Same issue as **api-3** in [api_claude.md](api_claude.md), viewed operationally: `baseUrl` defaults to **prod** while `accountStreamerUrl` is hardcoded to the **cert** streamer. It does nothing today (the account streamer is never connected), but conceptually "REST hits live money, streaming points at sandbox" is exactly the inconsistency you don't want latent in a trading daemon. **Fix:** drive both URLs from one env/config so they cannot diverge.

---

### 🟡 arch-4 — Full account/order payloads logged to stdout (pm2 persists them)
**Severity: Medium · Confidence: Medium · [ipc-server.ts:235](../src/ipc-server.ts#L235), [run-cycle.ts:353](../src/bot/run-cycle.ts#L353), [johns-test-run.ts:15](../src/bot/johns-test-run.ts#L15)**

The IPC server logs each request and the **full** response object; `run-cycle` logs full execution results; `johns-test-run` dumps entire accounts/positions/chains. Account numbers, balances, positions, and order responses all hit stdout, and with pm2 `time: true` they **persist to log files**. No tokens are logged *today*, but logging whole payloads is precisely how tokens/PII leak the moment a response shape changes.

**Fix:** log identifiers/summaries, not whole payloads; redact account numbers; never log raw SDK responses; add `pm2-logrotate`.

---

### 🟡 arch-5 — No env-var validation
**Severity: Medium · Confidence: High · [tastytrade-client.ts:7](../src/core/tastytrade-client.ts#L7)**

(Same root as api-11, ops view.) `BASE_URL`/`API_REFRESH_TOKEN`/`API_CLIENT_SECRET` are read `as string` with no presence check. If `.env` isn't in pm2's cwd at boot, or a var is typo'd, the client is built with `undefined` and fails later as a confusing 401/network error mid-cycle — no clear startup failure. Note the pm2 env injects only `BOT_RUN_ON_SCHEDULE` and the socket path, so it **relies on a `.env` file in cwd at boot**. **Fix:** validate required vars at startup and exit clearly; confirm dotenv loads from pm2's cwd (or use pm2 `env_file`).

---

### 🟡 arch-6 — Market-open detection is heuristic string-matching, no explicit US/Eastern logic
**Severity: Medium · Confidence: Medium · [market-sessions.ts:83](../src/core/market-sessions.ts#L83)**

`isEquityOptionsMarketOpen` trusts the sessions endpoint when it can, but falls back to fuzzy substring matching of labels and a heuristic that "a regular session is any window under 7.5h." No explicit US/Eastern or DST handling. If the real field names differ from the guessed variants, it could misjudge the open/close boundary. (Good news: it **defaults to CLOSED** on anything unparseable — the safe direction.) **Fix:** confirm the sessions endpoint schema and key off documented fields explicitly.

---

### 🟢 Lower-severity (worth a pass, not urgent)

| # | Finding | Where |
|---|---------|-------|
| arch-7 | Scheduler spacing is **start-to-start**: a cycle longer than the interval clamps the next delay to 0 and fires back-to-back, collapsing the cadence | [market-open-scheduler.ts:101](../src/bot/market-open-scheduler.ts#L101) |
| arch-8 | `last-run-state` is **in-memory only** (pm2 autorestart wipes it) and the getter returns arrays **by reference** (callers can mutate internal state) | [last-run-state.ts:11](../src/bot/last-run-state.ts#L11) |
| arch-9 | `runs.ndjson` grows **unbounded**; `appendFile` isn't crash-atomic; `getRecentRunHistory` reads the **whole file** to return the last N | [run-history.ts:71](../src/bot/run-history.ts#L71) |
| arch-10 | IPC client reads only the **first line** and has **no timeout** — a hung handler leaves the promise unsettled forever | [ipc-client.js:45](../ipc-client.js#L45) |
| arch-11 | Stale-socket cleanup **throws** on unlink failure (aborts startup) and **unconditionally steals** the socket — a second instance silently takes it from a running one | [ipc-server.ts:267](../src/ipc-server.ts#L267) |
| arch-12 | `johns-test-run.ts` is a hardcoded scratch script wired in as the live `bot:johnsTestRun` command (any caller can dump account data); `src/bot/index.ts` is an empty IIFE with unused imports (dead code) | [johns-test-run.ts](../src/bot/johns-test-run.ts), [index.ts](../src/bot/index.ts) |
| arch-13 | esbuild `--packages=external` means the bundle needs an aligned `node_modules` beside it to start; shipping `build/` without `npm ci` fails to boot. Two run modes (tsx vs bundle) must stay in sync | [package.json:8](../package.json#L8) |
| arch-14 | **No global** `unhandledRejection`/`uncaughtException` handler — a stray rejection crashes the process and pm2 autorestart **hides** it (and resets in-memory state) | [index.ts](../src/index.ts) |
| arch-15 | README documents commands that don't match the registry (`fetchOptionChainsWithVolume` vs `...ChainWithVolume`; lists `cancelAllLiveOrders` in usage but not the supported list) | [README.md](../README.md) |

---

## ✅ What's genuinely good (ops things John got right)

- **Robust IPC handling:** per-request try/catch returns a structured error instead of crashing the server; axios error bodies are unwrapped.
- **Correct message framing:** a persistent buffer with newline-delimited parsing handles partial chunks and multiple messages per chunk (this is a common thing to get wrong — he didn't).
- **Defensive history reader:** per-line `JSON.parse` in try/catch skips malformed lines; `ENOENT` treated as empty.
- **Scheduler resilience:** a real (if local) `inFlight` guard, and a 60s back-off on error instead of dying.
- **Fail-safe defaults:** market-session detection defaults to **CLOSED** on unparseable responses — the correct direction to fail.
- **Clean dry-run/live separation** and "cancel before placing" within a cycle.

---

## Open questions for John (Architecture)

1. **Is `bot:runCycle` ever invoked manually while the scheduler is active?** Without a shared lock, cycles can overlap and cancel/duplicate orders (arch-2).
2. **When one order in a cycle is rejected, should the rest abort** (current behavior — partial fills, no rollback, no history) **or continue with per-leg reporting?** (arch-3)
3. **Which environment are you actually trading in?** Prod REST + cert streamer is contradictory; pick one and make the config single-sourced (arch-1).
4. **Are pm2 logs treated as sensitive?** They capture full account/position/order payloads with no redaction or rotation (arch-4).
5. **Should `last-run-state` survive restarts?** It's in-memory only; any crash wipes it (arch-8).
6. **Is `johns-test-run` meant to be reachable in production?** It's a live command that dumps account data (arch-12).

### Sources
- [tastytrade/tastytrade-api-js (SDK source)](https://github.com/tastytrade/tastytrade-api-js)
- [Tastytrade developer docs](https://developer.tastytrade.com/)
