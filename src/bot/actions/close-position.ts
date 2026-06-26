import tastytradeApi from "~/core/tastytrade-client";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { PositionGroupEvaluation } from "../evaluate-position";
import { ExecutionTargets, getDynamicTakeProfitTarget } from "../evaluate-trading-strategy";
import { buildClosingOrderPayload } from "./order-utils";

export interface ClosePositionResult {
  accountNumber: string;
  action: "CLOSE_POSITION";
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  skippedReason?: string;
  symbol: string;
  underlyingSymbol: string;
}

export interface ClosePositionDependencies {
  createOrder?: typeof tastytradeApi.orderService.createOrder;
}

const MORNING_CLOSE_SPREAD_THRESHOLDS = [
  { minute: 6 * 60 + 30, maxSpreadPct: 0.05 },
  { minute: 6 * 60 + 45, maxSpreadPct: 0.10 },
  { minute: 7 * 60 + 0, maxSpreadPct: 0.15 },
  { minute: 7 * 60 + 15, maxSpreadPct: 0.20 },
  { minute: 7 * 60 + 30, maxSpreadPct: 0.25 },
  { minute: 8 * 60 + 0, maxSpreadPct: 0.30 },
];

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

function getMorningCloseSpreadThresholdPct(currentTime: Date): number {
  const currentMinute = getTimeInMinutes(currentTime);
  let threshold = MORNING_CLOSE_SPREAD_THRESHOLDS[0]?.maxSpreadPct ?? 0;

  for (const spreadThreshold of MORNING_CLOSE_SPREAD_THRESHOLDS) {
    if (currentMinute < spreadThreshold.minute) {
      break;
    }

    threshold = spreadThreshold.maxSpreadPct;
  }

  return threshold;
}

function getSpreadPct(bidPrice: number, askPrice: number): number {
  const midpoint = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : 0;

  if (!(midpoint > 0)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, askPrice - bidPrice) / midpoint;
}

export function shouldSkipClosePositionForMorningSpread(
  evaluation: PositionGroupEvaluation,
): { skippedReason?: string; shouldSkip: boolean } {
  const currentTime = evaluation.metrics.currentTime;
  const bidReturnPct =
    evaluation.metrics.weightedAverageFill > 0
      ? (evaluation.metrics.currentBidPrice - evaluation.metrics.weightedAverageFill) /
        evaluation.metrics.weightedAverageFill
      : 0;
  const highBidReturnPct = getDynamicTakeProfitTarget(currentTime);

  if (bidReturnPct >= highBidReturnPct) {
    return { shouldSkip: false };
  }

  const spreadPct = getSpreadPct(
    evaluation.metrics.currentBidPrice,
    evaluation.metrics.currentAskPrice,
  );
  const maxAllowedSpreadPct = getMorningCloseSpreadThresholdPct(currentTime);

  if (spreadPct > maxAllowedSpreadPct) {
    return {
      shouldSkip: true,
      skippedReason: `Morning spread gate active (${(spreadPct * 100).toFixed(2)}% spread > ${(maxAllowedSpreadPct * 100).toFixed(2)}% max at ${currentTime.getHours().toString().padStart(2, "0")}:${currentTime.getMinutes().toString().padStart(2, "0")})`,
    };
  }

  return { shouldSkip: false };
}

export async function closePosition(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  targets: ExecutionTargets,
  dependencies: ClosePositionDependencies = {},
) {
  const results: ClosePositionResult[] = [];
  const createOrder =
    dependencies.createOrder ??
    tastytradeApi.orderService.createOrder.bind(tastytradeApi.orderService);

  const morningSpreadGate = shouldSkipClosePositionForMorningSpread(evaluation);
  if (morningSpreadGate.shouldSkip) {
    return evaluation.positionSnapshots.map((snapshot) => ({
      accountNumber,
      action: "CLOSE_POSITION" as const,
      placedOrder: false,
      skippedReason: morningSpreadGate.skippedReason,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    }));
  }

  for (const snapshot of evaluation.positionSnapshots) {
    const order = buildClosingOrderPayload(snapshot, targets);
    if (!order) {
      results.push({
        accountNumber,
        action: "CLOSE_POSITION",
        placedOrder: false,
        skippedReason: "missing price or quantity",
        symbol: snapshot.position.symbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
      continue;
    }

    const orderResponse = await createOrder(accountNumber, order);

    results.push({
      accountNumber,
      action: "CLOSE_POSITION",
      orderResponse,
      placedOrder: true,
      symbol: snapshot.position.symbol,
      underlyingSymbol: evaluation.underlyingSymbol,
    });
  }

  return results;
}

export default closePosition;
