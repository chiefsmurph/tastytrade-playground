import { CurrentPosition } from "../core/types";
import { getBidAskForSymbol } from "../core/market-data";

export type ProgrammaticAction = 'AVERAGE_DOWN' | 'CLOSE_POSITION' | 'HOLD_POSITION';

export interface PositionMetrics {
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;
  currentTime: Date;
  lastActionTime: Date | null;  // Tracks exactly when the last transaction occurred
}


export async function evaluateCurrentPosition(currentPosition: CurrentPosition): Promise<ProgrammaticAction> {
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
    lastActionTime,
  };

  return evaluatePosition(metrics);
}

export function getDynamicTakeProfitTarget(currentTime: Date): number {
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const timeInMinutes = currentHour * 60 + currentMinute;

  // Time boundaries in minutes from midnight (PST)
  const sixThirtyAM = 6 * 60 + 30;
  const nineThirtyAM = 9 * 60 + 30;
  const twelveThirtyPM = 12 * 60 + 30;
  const twelveFiftyFivePM = 12 * 60 + 55;

  if (timeInMinutes >= sixThirtyAM && timeInMinutes < nineThirtyAM) {
    return 0.40; // 40% target during morning volatility
  } else if (timeInMinutes >= nineThirtyAM && timeInMinutes < twelveThirtyPM) {
    return 0.20; // 20% target during midday consolidation
  } else if (timeInMinutes >= twelveThirtyPM && timeInMinutes < twelveFiftyFivePM) {
    return 0.07; // 7% compressed target as market close approaches
  }
  
  return 0.00; // Outside standard trading or inside hard liquidation window
}

export function evaluatePosition(metrics: PositionMetrics): ProgrammaticAction {
  const { currentBidPrice, currentAskPrice, weightedAverageFill, currentTime, lastActionTime } = metrics;
  
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const timeInMinutes = currentHour * 60 + currentMinute;

  const nineThirtyAM = 9 * 60 + 30;
  const twelveFiftyFivePM = 12 * 60 + 55;

  // 1. Calculate current performance based on liquidation value (Bid)
  const currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill;

  // 2. CRITICAL SAFETY GATE: Hard End-of-Day Liquidation (Bypasses all cooldowns)
  if (timeInMinutes >= twelveFiftyFivePM) {
    return 'CLOSE_POSITION'; 
  }

  // 3. CRITICAL SAFETY GATE: Hard Risk Floor (Bypasses all cooldowns)
  // If the trade hits your absolute limit down (-30% morning / -15% midday), 
  // you must close IMMEDIATELY. No waiting for a timer.
  if (timeInMinutes < nineThirtyAM && currentReturn <= -0.30) {
    return 'CLOSE_POSITION';
  }
  if (timeInMinutes >= nineThirtyAM && currentReturn <= -0.15) {
    return 'CLOSE_POSITION';
  }

  // 4. Evaluate Take Profit (Dynamic Upside Target based on Bid)
  const targetProfitPercentage = getDynamicTakeProfitTarget(currentTime);
  if (currentReturn >= targetProfitPercentage) {
    return 'CLOSE_POSITION'; 
  }

  // 5. EVALUATE THE COOLDOWN GATE FOR RE-BUYING
  // If we have an execution history, calculate how many minutes have passed since the last trade
  if (lastActionTime !== null) {
    const msSinceLastAction = currentTime.getTime() - lastActionTime.getTime();
    const minutesSinceLastAction = msSinceLastAction / (1000 * 60);
    
    // Hard 5-minute throttle rule for averaging down
    if (minutesSinceLastAction < 5) {
      return 'HOLD_POSITION'; // Throttle is active; force the bot to stand down
    }
  }

  // 6. Evaluate Average Down (Only if Morning and Cooldown has cleared)
  if (timeInMinutes < nineThirtyAM) {
    if (currentAskPrice < weightedAverageFill) {
      return 'AVERAGE_DOWN'; 
    }
  }

  return 'HOLD_POSITION';
}
