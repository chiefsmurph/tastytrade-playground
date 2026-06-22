# John To Verify

These are owner checks. Codex can make the bot safer and easier to inspect, but John needs to verify these against his real tastytrade account, sandbox account, and operating preferences before live trading.

1. Verify `average-open-price` units from a real sandbox positions payload.
   - Pull one real `GET /accounts/{account_number}/positions` payload from sandbox.
   - Find an option position with a known fill price.
   - If `average-open-price` looks like premium per share, for example `1.25`, keep:

     ```json
     "costBasisUnit": "perShare"
     ```

   - If it looks like contract notional, for example `125`, change:

     ```json
     "costBasisUnit": "perContract"
     ```

   - This is the most important owner check. If this is wrong, return percentages can be wrong by about 100x.

2. Run one full sandbox dry-run cycle before any live order.
   - Confirm `.env` points at sandbox-capable credentials.
   - Confirm `config/trading-bot.config.json` has:

     ```json
     "environment": "sandbox",
     "liveOrders": { "enabled": false }
     ```

   - Start the server and run:

     ```bash
     node run config:show
     node run bot:getRunCyclePreview
     node run bot:runCycle
     ```

   - Confirm no live order appears at the broker.

3. Review every `SKIP` reason in preview and last-run state.
   - Run:

     ```bash
     node run bot:getLastRunCycle
     ```

   - Investigate any `SKIP` reason involving missing symbols, missing cost basis, invalid multiplier, missing quote price, or unknown direction.

4. Confirm quote-streamer behavior during sandbox dry-run.
   - The code now reuses the quote-streamer connection, unsubscribes symbols after each lookup, and removes listeners.
   - During a sandbox cycle, watch process logs and system sockets for repeated unmanaged quote-streamer connections.
   - If socket/listener count grows every cycle, stop before live trading.

5. Confirm option quotes use streamer symbols and orders use OCC symbols.
   - Preview output should show `candidateQuoteSymbol` for quotes and `candidateSymbol` for order legs.
   - Order payload legs should use OCC symbols only.
   - Quote failures should not be caused by quoting OCC symbols.

6. Confirm the selected profile is really the intended trading posture.
   - Current default is:

     ```json
     "profile": "conservative"
     ```

   - Conservative means no adding to material losers, no DTE fallback, and day-volume gate `120`.
   - Use `balanced` or `aggressive` only after sandbox behavior is understood.

7. Confirm trading times match the intended market routine.
   - Defaults are Pacific time:

     ```json
     "marketOpenTime": "06:30",
     "allocationCutoffTime": "12:30",
     "liquidationTime": "12:55"
     ```

   - If John changes `strategy.timezone`, he must also confirm these clock values still mean what he intends.

8. Confirm `config:reload` behavior is acceptable.
   - `config:reload` refuses sandbox-to-production or production-to-sandbox switches.
   - Environment switches require a process restart.
   - After `bot:panic`, live trading stays disabled until process restart.

9. Test `bot:panic` while in sandbox.
   - Run:

     ```bash
     node run bot:panic
     node run config:show
     ```

   - Confirm scheduler is stopped and live orders are disabled in runtime safety state.

10. Run one supervised tiny live order only after all sandbox checks pass.
    - Set `liveOrders.enabled: true`.
    - Set `BOT_ENABLE_LIVE_ORDERS=true`.
    - Keep scheduler off.
    - Submit one intentionally tiny supervised order path.
    - Confirm dry-run happened first, the live order matched the preview, and cancel/close behavior is understood.

11. Re-arm the scheduler only after supervised live behavior is confirmed.
    - Do not enable `BOT_RUN_ON_SCHEDULE=true` until manual live behavior is proven.

12. Commit this as one clean branch or commit before review.
    - There are many files touched.
    - The previous docs folder move shows as deletions plus `docs/Initial_look_and_plans/`.
    - John should review a clean branch/commit rather than a loose working tree.
