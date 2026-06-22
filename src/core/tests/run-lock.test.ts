import test from "node:test";
import assert from "node:assert/strict";

import { LiveTradingLockError, withLiveTradingLock } from "../run-lock";

test("withLiveTradingLock rejects overlapping live operations with a stable code", async () => {
  let releaseLock!: () => void;
  const first = withLiveTradingLock(
    "first-operation",
    () =>
      new Promise<void>((resolve) => {
        releaseLock = resolve;
      }),
  );

  await assert.rejects(
    () => withLiveTradingLock("second-operation", async () => undefined),
    (error) =>
      error instanceof LiveTradingLockError &&
      error.code === "LIVE_TRADING_LOCKED",
  );

  releaseLock();
  await first;
});
