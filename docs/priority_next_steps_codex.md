# Priority Next Steps - Codex

This is the concise handoff list I would send back to John.

## Fix Before Running Live

1. Fix market-session parsing.

The official response uses `open-at`, `close-at`, `close-at-ext`, and `state`. The code is looking for mostly different names. This can make the scheduler think the market is closed.

2. Normalize API response shapes.

The tastytrade API uses kebab-case fields. Do not treat positions as snake_case unless there is a real conversion layer.

3. Fix put allocation.

The allocator can infer `put` but still quote/order `candidate.symbol`, which is currently populated from the call side.

4. Fix strategy timezones.

The strategy says Pacific time, but runtime uses the host timezone. Convert to `America/Los_Angeles` explicitly.

5. Fix short-position P/L.

Long and short positions need different return math. Otherwise take-profit and stop-loss can invert.

6. Add a global live-trading lock.

Manual IPC and scheduler runs can overlap. One live execution at a time.

## Fix Before Trusting Results

1. Stop canceling live orders twice.

Cancel once and record the exact result.

2. Decide whether close orders should be aggressive.

The code says "liquidate instantly" but sends limit orders that may not fill.

3. Add dry-run before every live order path.

`seedSymbol()` dry-runs first. Allocation and close should do the same.

4. Make liquidity filters real.

If minimum volume matters, enforce it. Do not just annotate `meetsVolumeRequirement`.

5. Separate close and allocation cycles.

Submitting close orders and then allocating from stale positions/balances can create unwanted exposure.

## Nice-To-Have Cleanup

1. Replace the hard-coded account streamer URL with SDK prod/sandbox config.

2. Validate `.env` at startup.

3. Fix README command spelling:

```text
core:fetchOptionChainWithVolume
```

4. Make PM2 config portable or clearly deploy-host-specific.

5. Add tests for the bugs above before changing trading behavior.

## Good Work Worth Keeping

- Current SDK/OAuth direction is right.
- IPC command surface is useful.
- The preview command is useful.
- Market-session scheduling is the right idea, once parsing is fixed.
- Buying-power and exposure caps are a good start.
- `seedSymbol()` using order dry-run before submit is the right safety pattern.

## One-Sentence Summary

The repo is structurally promising, but it should not be trusted for live trading until response-shape parsing, timezone handling, put/call side selection, short P/L math, and run concurrency are fixed.
