import test from "node:test";
import assert from "node:assert/strict";
import type { PositionGroupEvaluation } from "../../evaluate-position";

process.env.API_CLIENT_SECRET = "test-secret";
process.env.API_REFRESH_TOKEN = "test-refresh";

function buildEvaluation(currentReturn: number): PositionGroupEvaluation {
  return {
    underlyingSymbol: "RUM",
    positions: [
      {
        symbol: "RUM   260717C00010000",
        orderSymbol: "RUM   260717C00010000",
        quantity: 1,
        multiplier: 100,
      },
    ],
    positionSnapshots: [],
    metrics: {
      currentAskPrice: 1,
      currentBidPrice: 1,
      currentReturn,
      currentTime: new Date("2026-06-19T17:14:00.000Z"),
      lastActionTime: new Date("2026-06-19T17:14:00.000Z"),
      weightedAverageFill: 1,
    },
    strategy: {
      action: "MANAGE_ALLOCATION",
    },
    executionTargets: {
      askWeight: 1,
      bidWeight: 0,
      midWeight: 0,
      targetAccountExposure: 0.5,
      targetDTE: 28,
    },
    currentReturn,
  };
}

test("conservative allocation gate does not add to material losers", async () => {
  const { reloadBotConfig } = await import("../../../core/bot-config");
  const { manageAllocationForGroup } = await import("../manage-allocation");

  delete process.env.TASTYTRADE_BOT_CONFIG;
  reloadBotConfig();

  const result = await manageAllocationForGroup(
    "ACCT-REDACTED-1234",
    buildEvaluation(-0.06),
    {
      buyingPowerRemaining: 10000,
      portfolioExposure: 0,
      totalCapital: 100000,
    },
  );

  assert.equal(result.placedOrder, false);
  assert.match(result.skippedReason ?? "", /not adding to losing position/);
});
