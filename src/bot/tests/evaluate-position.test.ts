import test from "node:test";
import assert from "node:assert/strict";

import type { PositionQuoteSnapshot } from "../evaluate-position";

process.env.API_CLIENT_SECRET = "test-secret";
process.env.API_REFRESH_TOKEN = "test-refresh";

function buildSnapshot(
  overrides: Partial<PositionQuoteSnapshot>,
): PositionQuoteSnapshot {
  return {
    currentAskPrice: 0,
    currentBidPrice: 0,
    lastActionTime: new Date("2026-06-19T16:30:00.000Z"),
    orderSymbol: "RUM   260717P00012000",
    position: {
      symbol: "RUM   260717P00012000",
      quantity: 1,
      multiplier: 100,
    },
    positionDirection: "short",
    quantityWeight: 100,
    quoteSymbol: "./RUM260717P12",
    weightedAverageFill: 2,
    ...overrides,
  };
}

test("short return is positive when buyback ask is below opening credit", async () => {
  const { calculatePositionSnapshotReturn } = await import("../evaluate-position");
  const currentReturn = calculatePositionSnapshotReturn(
    buildSnapshot({
      currentAskPrice: 1.5,
      currentBidPrice: 1.45,
      positionDirection: "short",
      weightedAverageFill: 2,
    }),
  );

  assert.equal(currentReturn, 0.25);
});

test("long return is positive when bid is above opening debit", async () => {
  const { calculatePositionSnapshotReturn } = await import("../evaluate-position");
  const currentReturn = calculatePositionSnapshotReturn(
    buildSnapshot({
      currentAskPrice: 1.55,
      currentBidPrice: 1.5,
      positionDirection: "long",
      weightedAverageFill: 1.25,
    }),
  );

  assert.equal(currentReturn, 0.2);
});

test("missing quote and missing fallback price produces SKIP", async () => {
  const { evaluatePositionGroup } = await import("../evaluate-position");
  const evaluation = await evaluatePositionGroup(
    [
      {
        symbol: "RUM   260717C00010000",
        orderSymbol: "RUM   260717C00010000",
        quoteSymbol: "./RUM260717C10",
        instrumentType: "Equity Option",
        underlyingSymbol: "RUM",
        quantity: 1,
        quantityDirection: "Long",
        averageOpenPrice: 1.25,
        multiplier: 100,
      },
    ],
    new Date("2026-06-19T17:14:00.000Z"),
    {
      getBidAsk: async () => null,
    },
  );

  assert.equal(evaluation?.strategy.action, "SKIP");
  assert.match(evaluation?.strategy.skippedReason ?? "", /missing quote price/);
});

test("mark price is used as quote fallback when streamer times out", async () => {
  const { evaluatePositionGroup } = await import("../evaluate-position");
  const evaluation = await evaluatePositionGroup(
    [
      {
        symbol: "RUM   260717C00010000",
        orderSymbol: "RUM   260717C00010000",
        quoteSymbol: "./RUM260717C10",
        instrumentType: "Equity Option",
        underlyingSymbol: "RUM",
        quantity: 1,
        quantityDirection: "Long",
        averageOpenPrice: 1.25,
        markPrice: 1.5,
        multiplier: 100,
      },
    ],
    new Date("2026-06-19T17:14:00.000Z"),
    {
      getBidAsk: async () => null,
    },
  );

  assert.equal(evaluation?.metrics.currentBidPrice, 1.5);
  assert.equal(evaluation?.metrics.currentAskPrice, 1.5);
  assert.notEqual(evaluation?.strategy.action, "SKIP");
});
