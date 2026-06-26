import test from "node:test";
import assert from "node:assert/strict";

import {
  getAskReturnPercForEvaluation,
  getCashAccountSeedCandidatesFromMarginEvaluations,
  isWithinCashAccountSeedFromMarginWindow,
} from "../cash-account-seeding";
import type { PositionGroupEvaluation } from "../evaluate-position";

function buildEvaluation(overrides: Partial<PositionGroupEvaluation>): PositionGroupEvaluation {
  return {
    currentReturn: 0,
    executionTargets: undefined,
    groupKey: "AAPL::call",
    metrics: {
      currentAskPrice: 1.19,
      currentBidPrice: 1.1,
      currentTime: new Date("2026-06-24T10:00:00"),
      lastActionTime: new Date("2026-06-24T09:00:00"),
      weightedAverageFill: 1,
    },
    positionSnapshots: [],
    positions: [{ symbol: "AAPL   260619C00100000" }] as PositionGroupEvaluation["positions"],
    strategy: {
      action: "MANAGE_ALLOCATION",
      reason: "test",
    },
    underlyingSymbol: "AAPL",
    ...overrides,
  };
}

test("getAskReturnPercForEvaluation matches run-cycle ask return calculation", () => {
  const evaluation = buildEvaluation({});
  const askReturnPerc = getAskReturnPercForEvaluation(evaluation);
  assert.ok(askReturnPerc !== null);
  assert.ok(Math.abs(askReturnPerc - 0.19) < 1e-9);
});

test("getCashAccountSeedCandidatesFromMarginEvaluations filters by threshold and side", () => {
  const previousThreshold = process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_MAX_ASK_RETURN_PCT;
  process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_MAX_ASK_RETURN_PCT = "20";

  try {
    const eligible = buildEvaluation({
      metrics: {
        currentAskPrice: 1.19,
        currentBidPrice: 1.1,
        currentTime: new Date("2026-06-24T10:00:00"),
        lastActionTime: new Date("2026-06-24T09:00:00"),
        weightedAverageFill: 1,
      },
    });
    const tooHigh = buildEvaluation({
      groupKey: "MSFT::call",
      metrics: {
        currentAskPrice: 1.2,
        currentBidPrice: 1.1,
        currentTime: new Date("2026-06-24T10:00:00"),
        lastActionTime: new Date("2026-06-24T09:00:00"),
        weightedAverageFill: 1,
      },
      underlyingSymbol: "MSFT",
    });
    const wrongAction = buildEvaluation({
      groupKey: "NVDA::call",
      strategy: {
        action: "CLOSE_POSITION",
        reason: "test",
      },
      underlyingSymbol: "NVDA",
    });

    const candidates = getCashAccountSeedCandidatesFromMarginEvaluations([
      eligible,
      tooHigh,
      wrongAction,
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.side, "call");
    assert.equal(candidates[0]?.underlyingSymbol, "AAPL");
    assert.ok(Math.abs((candidates[0]?.askReturnPerc ?? 0) - 0.19) < 1e-9);
  } finally {
    if (previousThreshold === undefined) {
      delete process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_MAX_ASK_RETURN_PCT;
    } else {
      process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_MAX_ASK_RETURN_PCT = previousThreshold;
    }
  }
});

test("isWithinCashAccountSeedFromMarginWindow stops seeding at 13:00", () => {
  assert.equal(
    isWithinCashAccountSeedFromMarginWindow(new Date("2026-06-24T12:59:00")),
    true,
  );
  assert.equal(
    isWithinCashAccountSeedFromMarginWindow(new Date("2026-06-24T13:00:00")),
    false,
  );
});