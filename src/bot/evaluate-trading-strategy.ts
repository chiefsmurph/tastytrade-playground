export type ProgrammaticAction = "MANAGE_ALLOCATION" | "CLOSE_POSITION";

// Unified return structure containing target state goals for the execution loop
export interface ExecutionStrategy {
  action: ProgrammaticAction;
  targetDTE: number;             // Ideal Days to Expiration to target for this specific hour
  targetAccountExposure: number; // Maximum % of capital allowed to be deployed
  bidWeight: number;             // Order routing allocation across the spread
  midWeight: number;
  askWeight: number;
}

export interface PositionMetrics {
  currentBidPrice: number;
  currentAskPrice: number;
  weightedAverageFill: number;   // Our WAF cost basis
  currentTime: Date;             // Current system clock
  lastActionTime: Date;          // When this recommendation first flashed
}

export function calcTimeBlend(
  currentTime: Date,
  startScore: number,
  endScore: number,
  startMinute: number,
  endMinute: number,
): number {
  const currentMinute = currentTime.getHours() * 60 + currentTime.getMinutes();
  const minuteSpan = endMinute - startMinute;

  if (minuteSpan <= 0) {
    return roundToTwoDecimals(endScore);
  }

  const minutesPastStart = currentMinute - startMinute;
  const ratioPast = Math.max(0, Math.min(1, minutesPastStart / minuteSpan));
  const spreadBetweenScores = startScore - endScore;
  const currentScore = startScore - spreadBetweenScores * ratioPast;

  return roundToTwoDecimals(currentScore);
}

export function getDynamicTakeProfitTarget(currentTime: Date): number {
  const sixThirtyAM = 6 * 60 + 30;
  const twelveFiftyFivePM = 12 * 60 + 55;

  return calcTimeBlend(currentTime, 0.4, 0.07, sixThirtyAM, twelveFiftyFivePM);
}

/**
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 */
export function evaluateTradingStrategy(metrics: PositionMetrics): ExecutionStrategy {
  const { currentBidPrice, currentAskPrice, weightedAverageFill, currentTime, lastActionTime } = metrics;

  // 1. SYSTEM CLOCK CONVERSIONS (Pacific Standard Time - Minutes from midnight)
  const timeInMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

  const SIX_THIRTY_AM      = 6 * 60 + 30;
  const NINE_AM            = 9 * 60 + 0;
  const TEN_AM             = 10 * 60 + 0;
  const ELEVEN_AM          = 11 * 60 + 0;
  const ELEVEN_THIRTY_AM   = 11 * 60 + 30;
  const TWELVE_THIRTY_PM   = 12 * 60 + 30;
  const TWELVE_FIFTY_FIVE_PM = 12 * 60 + 55;

  // Calculate trade age (persistence tracking)
  const tradeAgeMinutes = (currentTime.getTime() - lastActionTime.getTime()) / (1000 * 60);
  const currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill;

  // 2. HARD CIRCUIT BREAKERS (EOD Liquidation & Risk Floors)
  if (timeInMinutes >= TWELVE_FIFTY_FIVE_PM) {
    return createStrategy("CLOSE_POSITION", 7, 0, 0, 0, 1.0); // Liquidate instantly
  }

  // Take Profit Target Gate
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);
  if (currentReturn >= dynamicTakeProfitTarget) {
    return createStrategy("CLOSE_POSITION", 7, 0, 0, 0, 1.0);
  }

  // Absolute Risk Floor Check
  if (timeInMinutes < TWELVE_THIRTY_PM && currentReturn <= -0.30) {
    return createStrategy("CLOSE_POSITION", 7, 0, 0, 0, 1.0);
  }

  // 3. THE DYNAMIC TIME-OF-DAY ROUTING & EXPIRATION MATRIX
  let idealDTE = 30;
  let maxExposure = 0.50;
  let bid = 0.70, mid = 0.20, ask = 0.10; // Default: Patient Early Morning Mix

  if (timeInMinutes >= SIX_THIRTY_AM && timeInMinutes < NINE_AM) {
    idealDTE = Math.round(
      calcTimeBlend(currentTime, 30, 25, SIX_THIRTY_AM, NINE_AM),
    );
    maxExposure = calcTimeBlend(currentTime, 0.50, 0.50, SIX_THIRTY_AM, NINE_AM);
    bid = calcTimeBlend(currentTime, 0.70, 0.50, SIX_THIRTY_AM, NINE_AM);
    mid = calcTimeBlend(currentTime, 0.20, 0.30, SIX_THIRTY_AM, NINE_AM);
    ask = calcTimeBlend(currentTime, 0.10, 0.20, SIX_THIRTY_AM, NINE_AM);
  } 
  else if (timeInMinutes >= NINE_AM && timeInMinutes < TEN_AM) {
    idealDTE = Math.round(
      calcTimeBlend(currentTime, 25, 20, NINE_AM, TEN_AM),
    );
    maxExposure = calcTimeBlend(currentTime, 0.50, 0.65, NINE_AM, TEN_AM);
    bid = calcTimeBlend(currentTime, 0.50, 0.33, NINE_AM, TEN_AM);
    mid = calcTimeBlend(currentTime, 0.30, 0.33, NINE_AM, TEN_AM);
    ask = calcTimeBlend(currentTime, 0.20, 0.33, NINE_AM, TEN_AM);
  } 
  else if (timeInMinutes >= TEN_AM && timeInMinutes < ELEVEN_AM) {
    idealDTE = Math.round(
      calcTimeBlend(currentTime, 20, 14, TEN_AM, ELEVEN_AM),
    );
    maxExposure = calcTimeBlend(currentTime, 0.65, 0.75, TEN_AM, ELEVEN_AM);
    bid = calcTimeBlend(currentTime, 0.33, 0.20, TEN_AM, ELEVEN_AM);
    mid = calcTimeBlend(currentTime, 0.33, 0.30, TEN_AM, ELEVEN_AM);
    ask = calcTimeBlend(currentTime, 0.33, 0.50, TEN_AM, ELEVEN_AM);
  } 
  else if (timeInMinutes >= ELEVEN_AM && timeInMinutes < ELEVEN_THIRTY_AM) {
    idealDTE = Math.round(
      calcTimeBlend(currentTime, 14, 7, ELEVEN_AM, ELEVEN_THIRTY_AM),
    );
    maxExposure = calcTimeBlend(currentTime, 0.75, 1.00, ELEVEN_AM, ELEVEN_THIRTY_AM);
    bid = calcTimeBlend(currentTime, 0.20, 0.00, ELEVEN_AM, ELEVEN_THIRTY_AM);
    mid = calcTimeBlend(currentTime, 0.30, 0.00, ELEVEN_AM, ELEVEN_THIRTY_AM);
    ask = calcTimeBlend(currentTime, 0.50, 1.00, ELEVEN_AM, ELEVEN_THIRTY_AM);
  } 
  else if (timeInMinutes >= ELEVEN_THIRTY_AM && timeInMinutes < TWELVE_THIRTY_PM) {
    idealDTE = Math.round(
      calcTimeBlend(currentTime, 7, 7, ELEVEN_THIRTY_AM, TWELVE_THIRTY_PM),
    );
    maxExposure = calcTimeBlend(currentTime, 1.00, 1.00, ELEVEN_THIRTY_AM, TWELVE_THIRTY_PM);
    bid = calcTimeBlend(currentTime, 0.00, 0.00, ELEVEN_THIRTY_AM, TWELVE_THIRTY_PM);
    mid = calcTimeBlend(currentTime, 0.00, 0.00, ELEVEN_THIRTY_AM, TWELVE_THIRTY_PM);
    ask = calcTimeBlend(currentTime, 1.00, 1.00, ELEVEN_THIRTY_AM, TWELVE_THIRTY_PM);
  }

  // 4. BLOCK ALL NEW ACCUMULATION PAST THE 12:30 PM LINE
  if (timeInMinutes >= TWELVE_THIRTY_PM) {
    if (currentReturn <= -0.10) {
      return createStrategy("CLOSE_POSITION", 7, 0, 0, 0, 1.0); // End-of-day risk compression
    }
    // Forcing target exposure to 0 blocks the downstream pipeline from purchasing anything new
    return createStrategy("MANAGE_ALLOCATION", idealDTE, 0, 0, 0, 0); 
  }

  // 5. EVALUATE CONTINUOUS ACCUMULATION AND PERSISTENCE CONSTRAINTS
  // We only modify the maximum allowed exposure based on specific strict rules
  if (currentAskPrice <= weightedAverageFill) {
    // High-Conviction High-Noon Check: 
    // If it hasn't been live for 20 minutes yet, throttle the allocation window down to morning levels (50%)
    if (timeInMinutes >= ELEVEN_THIRTY_AM && tradeAgeMinutes < 20) {
      return createStrategy("MANAGE_ALLOCATION", idealDTE, 0.50, 0.33, 0.33, 0.33); 
    }
    
    // Otherwise, maintain standard matrix metrics for building the block position
    return createStrategy("MANAGE_ALLOCATION", idealDTE, maxExposure, bid, mid, ask);
  }

  // If current ask price is HIGHER than our average, we don't want to buy right now. 
  // We simply pass back target exposure of 0 to tell the downstream loop to stand down.
  return createStrategy("MANAGE_ALLOCATION", idealDTE, 0, 0, 0, 0);
}

function createStrategy(
  action: ProgrammaticAction,
  targetDTE: number,
  targetAccountExposure: number,
  bidWeight: number,
  midWeight: number,
  askWeight: number
): ExecutionStrategy {
  return { action, targetDTE, targetAccountExposure, bidWeight, midWeight, askWeight };
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}