import { getBotConfig } from "../core/bot-config";
import { getBidAskForSymbol } from "../core/market-data";
import { CurrentPosition } from "../core/types";
import {
  buildExecutionStrategy,
  ExecutionTargets,
  ExecutionStrategy,
  PositionMetrics,
} from "./evaluate-trading-strategy";

export interface PositionQuoteSnapshot {
  position: CurrentPosition;
  currentBidPrice: number;
  currentAskPrice: number;
  currentReturn?: number;
  orderSymbol: string;
  positionDirection: "long" | "short" | null;
  quoteSymbol: string;
  skippedReason?: string;
  weightedAverageFill: number;
  quantityWeight: number;
  lastActionTime: Date;
}

export interface PositionGroupEvaluation {
  underlyingSymbol: string;
  positions: CurrentPosition[];
  positionSnapshots: PositionQuoteSnapshot[];
  metrics: PositionMetrics;
  strategy: ExecutionStrategy;
  executionTargets?: ExecutionTargets;
  currentReturn: number;
}

export interface EvaluatePositionGroupOptions {
  getBidAsk?: typeof getBidAskForSymbol;
}

export function getUnderlyingSymbolForPosition(position: CurrentPosition): string {
  return position.underlyingSymbol?.trim() || position.underlying_symbol?.trim() || position.symbol;
}

export function groupPositionsByUnderlying(
  positions: CurrentPosition[],
): Map<string, CurrentPosition[]> {
  const grouped = new Map<string, CurrentPosition[]>();

  for (const position of positions) {
    const underlyingSymbol = getUnderlyingSymbolForPosition(position);
    const existing = grouped.get(underlyingSymbol);

    if (existing) {
      existing.push(position);
      continue;
    }

    grouped.set(underlyingSymbol, [position]);
  }

  return grouped;
}

function getPositionQuantityWeight(position: CurrentPosition): number {
  const quantity = Math.abs(Number(position.quantity) || 0);
  const multiplier = Math.abs(Number(position.multiplier) || 0);
  return quantity * multiplier;
}

function getPositionDirection(position: CurrentPosition): "long" | "short" | null {
  const quantityDirection = String(
    position.quantityDirection ?? position.quantity_direction ?? "",
  ).toLowerCase();

  if (quantityDirection === "long") {
    return "long";
  }
  if (quantityDirection === "short") {
    return "short";
  }

  const costEffect = String(position.costEffect ?? position.cost_effect ?? "").toLowerCase();
  if (costEffect === "debit") {
    return "long";
  }
  if (costEffect === "credit") {
    return "short";
  }

  return null;
}

function normalizeCostBasis(
  rawCostBasis: number | null | undefined,
  multiplier: number,
): number | null {
  if (rawCostBasis == null || !Number.isFinite(rawCostBasis) || rawCostBasis <= 0) {
    return null;
  }

  if (getBotConfig().strategy.costBasisUnit === "perContract") {
    return multiplier > 0 ? rawCostBasis / multiplier : null;
  }

  return rawCostBasis;
}

export function calculatePositionSnapshotReturn(
  snapshot: PositionQuoteSnapshot,
): number | undefined {
  if (!(snapshot.weightedAverageFill > 0)) {
    return undefined;
  }

  if (snapshot.positionDirection === "long" && snapshot.currentBidPrice > 0) {
    return (
      (snapshot.currentBidPrice - snapshot.weightedAverageFill) /
      snapshot.weightedAverageFill
    );
  }

  if (snapshot.positionDirection === "short" && snapshot.currentAskPrice > 0) {
    return (
      (snapshot.weightedAverageFill - snapshot.currentAskPrice) /
      snapshot.weightedAverageFill
    );
  }

  return undefined;
}

async function createPositionQuoteSnapshot(
  position: CurrentPosition,
  options: EvaluatePositionGroupOptions = {},
): Promise<PositionQuoteSnapshot> {
  const getBidAsk = options.getBidAsk ?? getBidAskForSymbol;
  const orderSymbol = position.orderSymbol ?? position.symbol;
  const quoteSymbol =
    position.quoteSymbol ?? position.streamerSymbol ?? position.symbol;
  const bidAsk = await getBidAsk(quoteSymbol, 3000);
  const fallbackPrice =
    position.markPrice ??
    position.mark_price ??
    position.mark ??
    position.closePrice ??
    position.close_price ??
    null;
  const currentBidPrice = bidAsk?.bid ?? fallbackPrice ?? 0;
  const currentAskPrice = bidAsk?.ask ?? bidAsk?.bid ?? fallbackPrice ?? 0;
  const multiplier = Math.abs(Number(position.multiplier) || 0);
  const weightedAverageFill =
    normalizeCostBasis(
      position.averageOpenPrice ??
        position.average_open_price ??
        position.averageDailyMarketClosePrice ??
        position.average_daily_market_close_price,
      multiplier,
    ) ?? 0;
  const positionDirection = getPositionDirection(position);
  const quantityWeight = getPositionQuantityWeight(position);
  const skippedReasons = [
    ...(position.normalizationErrors ?? []),
    !quoteSymbol ? "missing quote symbol" : undefined,
    currentBidPrice <= 0 && currentAskPrice <= 0
      ? "missing quote price"
      : undefined,
    !positionDirection ? "unknown position direction" : undefined,
    !(weightedAverageFill > 0) ? "missing cost basis" : undefined,
    !(multiplier > 0) ? "invalid multiplier" : undefined,
    !(quantityWeight > 0) ? "invalid quantity" : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  const snapshot: PositionQuoteSnapshot = {
    position,
    currentBidPrice,
    currentAskPrice,
    orderSymbol,
    positionDirection,
    quoteSymbol,
    weightedAverageFill,
    quantityWeight,
    lastActionTime:
      position.updatedAt || position.updated_at
        ? new Date(position.updatedAt ?? position.updated_at ?? Date.now())
        : new Date(),
    skippedReason:
      skippedReasons.length > 0 ? Array.from(new Set(skippedReasons)).join("; ") : undefined,
  };

  snapshot.currentReturn = snapshot.skippedReason
    ? undefined
    : calculatePositionSnapshotReturn(snapshot);
  return snapshot;
}

function buildAggregateMetrics(
  positionSnapshots: PositionQuoteSnapshot[],
  currentTime: Date,
): PositionMetrics {
  const skippedSnapshots = positionSnapshots.filter(
    (snapshot) => snapshot.skippedReason || snapshot.currentReturn == null,
  );
  if (skippedSnapshots.length > 0) {
    return {
      currentBidPrice: 0,
      currentAskPrice: 0,
      weightedAverageFill: 0,
      currentTime,
      hasValidPricing: false,
      skippedReason: skippedSnapshots
        .map((snapshot) => `${snapshot.orderSymbol}: ${snapshot.skippedReason ?? "invalid return"}`)
        .join("; "),
      lastActionTime: currentTime,
    };
  }

  const totalQuantityWeight = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.quantityWeight,
    0,
  );

  if (totalQuantityWeight <= 0) {
    return {
      currentBidPrice: 0,
      currentAskPrice: 0,
      weightedAverageFill: 0,
      currentTime,
      hasValidPricing: false,
      skippedReason: "total position quantity is zero",
      lastActionTime: currentTime,
    };
  }

  const totalBidValue = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentBidPrice * snapshot.quantityWeight,
    0,
  );
  const totalAskValue = positionSnapshots.reduce(
    (sum, snapshot) => sum + snapshot.currentAskPrice * snapshot.quantityWeight,
    0,
  );
  const totalCostBasis = positionSnapshots.reduce(
    (sum, snapshot) =>
      sum + snapshot.weightedAverageFill * snapshot.quantityWeight,
    0,
  );
  const totalReturn = positionSnapshots.reduce(
    (sum, snapshot) =>
      sum + (snapshot.currentReturn ?? 0) * snapshot.quantityWeight,
    0,
  );
  const lastActionTime = positionSnapshots.reduce(
    (latest, snapshot) =>
      snapshot.lastActionTime.getTime() > latest.getTime()
        ? snapshot.lastActionTime
        : latest,
    positionSnapshots[0].lastActionTime,
  );

  return {
    currentBidPrice: totalBidValue / totalQuantityWeight,
    currentAskPrice: totalAskValue / totalQuantityWeight,
    currentReturn: totalReturn / totalQuantityWeight,
    hasValidPricing: true,
    weightedAverageFill: totalCostBasis / totalQuantityWeight,
    currentTime,
    lastActionTime,
  };
}

export async function evaluatePositionGroup(
  positions: CurrentPosition[],
  currentTime = new Date(),
  options: EvaluatePositionGroupOptions = {},
): Promise<PositionGroupEvaluation | null> {
  if (positions.length === 0) {
    return null;
  }

  const positionSnapshots = await Promise.all(
    positions.map((position) => createPositionQuoteSnapshot(position, options)),
  );
  const metrics = buildAggregateMetrics(positionSnapshots, currentTime);
  const strategy = buildExecutionStrategy(metrics);
  const currentReturn = Number.isFinite(metrics.currentReturn)
    ? metrics.currentReturn ?? 0
    : 0;

  return {
    underlyingSymbol: getUnderlyingSymbolForPosition(positions[0]),
    positions,
    positionSnapshots,
    metrics,
    strategy,
    currentReturn,
  };
}

export async function evaluateCurrentPosition(currentPosition: CurrentPosition) {
  const evaluation = await evaluatePositionGroup([currentPosition]);
  return evaluation?.strategy ?? null;
}
