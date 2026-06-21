import { CurrentPosition } from "../core/types";
import { getBidAskForSymbol } from "../core/market-data";
import { evaluateTradingStrategy } from "./evaluate-trading-strategy";

export type ProgrammaticAction = 'AVERAGE_DOWN' | 'CLOSE_POSITION' | 'HOLD_POSITION';

export interface PositionMetrics {
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;
  currentTime: Date;
  lastActionTime: Date | null;  // Tracks exactly when the last transaction occurred
}


export async function evaluateCurrentPosition(currentPosition: CurrentPosition) {
  const { symbol } = currentPosition;
  const bidAsk = await getBidAskForSymbol(symbol, 3000);

  const currentBidPrice = bidAsk?.bid ?? (currentPosition.mark_price ?? currentPosition.close_price ?? 0);
  const currentAskPrice = bidAsk?.ask ?? (currentPosition.mark_price ?? currentPosition.close_price ?? currentBidPrice);

  const weightedAverageFill = currentPosition.average_open_price ?? currentPosition.average_daily_market_close_price ?? currentBidPrice;

  const lastActionTime = currentPosition.updated_at ? new Date(currentPosition.updated_at) : null;

  const metrics = {
    currentBidPrice,
    currentAskPrice,
    weightedAverageFill,
    currentTime: new Date(),
    lastActionTime: lastActionTime ?? new Date(),
  };

  return evaluateTradingStrategy(metrics);
}