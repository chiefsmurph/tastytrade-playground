import { getBotConfig } from "../core/bot-config";
import { getConfiguredTradingMinutes } from "../core/time";

export type ProgrammaticAction =
  | "MANAGE_ALLOCATION"
  | "CLOSE_POSITION"
  | "LIQUIDATE_POSITION"
  | "SKIP";

// Unified return structure containing target state goals for the execution loop
export interface ExecutionStrategy {
  action: ProgrammaticAction;
  skippedReason?: string;
}

export interface ExecutionTargets {
  targetDTE: number;
  targetAccountExposure: number;
  bidWeight: number;
  midWeight: number;
  askWeight: number;
}

function getMaxAskWeightForPositionSize(positionSizePct: number): number {
  if (positionSizePct <= 0.15) {
    return 0.50;
  }

  if (positionSizePct <= 0.30) {
    return 0.75;
  }

  return 1.00;
}

export function applyPositionSizeWeightCaps(
  targets: ExecutionTargets,
  positionSizePct: number,
): ExecutionTargets {
  const normalizedPositionSize = Number.isFinite(positionSizePct)
    ? Math.max(0, positionSizePct)
    : 0;
  const maxAskWeight = getMaxAskWeightForPositionSize(normalizedPositionSize);
  const cappedAskWeight = Math.min(targets.askWeight, maxAskWeight);
  const askReduction = Math.max(0, targets.askWeight - cappedAskWeight);

  return {
    ...targets,
    askWeight: roundToTwoDecimals(cappedAskWeight),
    midWeight: roundToTwoDecimals(targets.midWeight + askReduction),
  };
}

export interface PositionMetrics {
  currentBidPrice: number;
  currentAskPrice: number;
  currentReturn?: number;
  hasValidPricing?: boolean;
  skippedReason?: string;
  weightedAverageFill: number;   // Our WAF cost basis
  currentTime: Date;             // Current system clock
  lastActionTime: Date;          // When this recommendation first flashed
}

interface TimeSchedulePoint {
  minute: number;
  value: number;
}

function parseTimeOfDayMinutes(value: string): number {
  const [hoursText, minutesText] = value.split(":");
  return Number(hoursText) * 60 + Number(minutesText);
}

export function calcTimeBlend(
  currentTime: Date,
  startScore: number,
  endScore: number,
  startMinute: number,
  endMinute: number,
): number {
  const currentMinute = getConfiguredTradingMinutes(currentTime);
  return calcMinuteBlend(
    currentMinute,
    startScore,
    endScore,
    startMinute,
    endMinute,
  );
}

function calcMinuteBlend(
  currentMinute: number,
  startScore: number,
  endScore: number,
  startMinute: number,
  endMinute: number,
): number {
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
  const config = getBotConfig();
  const marketOpen = parseTimeOfDayMinutes(config.strategy.marketOpenTime);
  const liquidation = parseTimeOfDayMinutes(config.strategy.liquidationTime);

  return calcTimeBlend(currentTime, 0.4, 0.07, marketOpen, liquidation);
}

function getTimeInMinutes(currentTime: Date): number {
  return getConfiguredTradingMinutes(currentTime);
}

/**
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 */
export function evaluateTradingStrategy(metrics: PositionMetrics): ProgrammaticAction {
  const { currentBidPrice, weightedAverageFill, currentTime } = metrics;

  if (metrics.hasValidPricing === false || metrics.skippedReason) {
    return "SKIP";
  }

  const timeInMinutes = getTimeInMinutes(currentTime);

  const config = getBotConfig();
  const allocationCutoff = parseTimeOfDayMinutes(
    config.strategy.allocationCutoffTime,
  );
  const liquidationTime = parseTimeOfDayMinutes(config.strategy.liquidationTime);

  const currentReturn =
    metrics.currentReturn ??
    (weightedAverageFill > 0
      ? (currentBidPrice - weightedAverageFill) / weightedAverageFill
      : Number.NaN);

  if (!Number.isFinite(currentReturn) || weightedAverageFill <= 0) {
    return "SKIP";
  }

  // 2. HARD CIRCUIT BREAKERS (EOD Liquidation & Risk Floors)
  if (timeInMinutes >= liquidationTime) {
    return "LIQUIDATE_POSITION";
  }

  // Take Profit Target Gate
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);
  if (currentReturn >= dynamicTakeProfitTarget) {
    return "CLOSE_POSITION";
  }

  // Absolute Risk Floor Check
  if (timeInMinutes < allocationCutoff && currentReturn <= -0.30) {
    return "CLOSE_POSITION";
  }

  // 4. BLOCK ALL NEW ACCUMULATION PAST THE 12:30 PM LINE
  if (timeInMinutes >= allocationCutoff) {
    if (currentReturn <= -0.10) {
      return "CLOSE_POSITION"; // End-of-day risk compression
    }
  }

  return "MANAGE_ALLOCATION";
}

export function getTimeOfDayExecutionTargets(currentTime: Date): ExecutionTargets {
  const timeInMinutes = getTimeInMinutes(currentTime);
  return getTimeOfDayExecutionTargetsForMinute(timeInMinutes);
}

function getTimeOfDayExecutionTargetsForMinute(timeInMinutes: number): ExecutionTargets {

  const config = getBotConfig();
  const marketOpen = parseTimeOfDayMinutes(config.strategy.marketOpenTime);
  const NINE_AM            = 9 * 60 + 0;
  const TEN_AM             = 10 * 60 + 0;
  const ELEVEN_AM          = 11 * 60 + 0;
  const ELEVEN_THIRTY_AM   = 11 * 60 + 30;
  const allocationCutoff = parseTimeOfDayMinutes(config.strategy.allocationCutoffTime);

  const targetDTE = Math.round(
    blendBySchedule(timeInMinutes, [
      { minute: marketOpen, value: 30 },
      { minute: NINE_AM, value: 25 },
      { minute: TEN_AM, value: 20 },
      { minute: ELEVEN_AM, value: 14 },
      { minute: ELEVEN_THIRTY_AM, value: 7 },
      { minute: allocationCutoff, value: 7 },
    ]),
  );
  const targetAccountExposure = blendBySchedule(timeInMinutes, [
    { minute: marketOpen, value: 0.40 },
    { minute: NINE_AM, value: 0.45 },
    { minute: TEN_AM, value: 0.55 },
    { minute: ELEVEN_AM, value: 0.65 },
    { minute: ELEVEN_THIRTY_AM, value: 0.75 },
    { minute: allocationCutoff, value: 1.00 },
  ]);
  const bidWeight = blendBySchedule(timeInMinutes, [
    { minute: marketOpen, value: 0.70 },
    { minute: NINE_AM, value: 0.50 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.20 },
    { minute: ELEVEN_THIRTY_AM, value: 0.00 },
    { minute: allocationCutoff, value: 0.00 },
  ]);
  const midWeight = blendBySchedule(timeInMinutes, [
    { minute: marketOpen, value: 0.20 },
    { minute: NINE_AM, value: 0.30 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.30 },
    { minute: ELEVEN_THIRTY_AM, value: 0.25 },
    { minute: allocationCutoff, value: 0.15 },
  ]);
  const askWeight = blendBySchedule(timeInMinutes, [
    { minute: marketOpen, value: 0.10 },
    { minute: NINE_AM, value: 0.20 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.50 },
    { minute: ELEVEN_THIRTY_AM, value: 0.75 },
    { minute: allocationCutoff, value: 0.85 },
  ]);

  if (timeInMinutes >= allocationCutoff) {
    return {
      askWeight: 0,
      bidWeight: 0,
      midWeight: 0,
      targetAccountExposure: 0,
      targetDTE,
    };
  }

  return {
    askWeight,
    bidWeight,
    midWeight,
    targetAccountExposure,
    targetDTE,
  };
}

export function getTimeOfDayExecutionTargetsForPstTime(
  timeOfDay?: string,
): ExecutionTargets {
  return getTimeOfDayExecutionTargetsForPacificTime(timeOfDay);
}

export function getTimeOfDayExecutionTargetsForPacificTime(
  timeOfDay?: string,
): ExecutionTargets {
  if (!timeOfDay) {
    return getTimeOfDayExecutionTargets(new Date());
  }
  const match = timeOfDay.trim().match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);
  if (!match) {
    throw new Error("Invalid time format. Expected HH:mm in Pacific time, e.g. 10:14");
  }

  const [hoursText, minutesText] = timeOfDay.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const timeInMinutes = hours * 60 + minutes;

  return getTimeOfDayExecutionTargetsForMinute(timeInMinutes);
}

export function buildExecutionStrategy(metrics: PositionMetrics): ExecutionStrategy {
  const action = evaluateTradingStrategy(metrics);
  return {
    action,
    skippedReason:
      action === "SKIP"
        ? metrics.skippedReason ?? "invalid or incomplete position metrics"
        : undefined,
  };
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function blendBySchedule(
  currentMinute: number,
  schedule: TimeSchedulePoint[],
): number {
  if (schedule.length === 0) {
    return 0;
  }

  const sortedSchedule = [...schedule].sort((left, right) => left.minute - right.minute);

  if (currentMinute <= sortedSchedule[0].minute) {
    return roundToTwoDecimals(sortedSchedule[0].value);
  }

  const lastPoint = sortedSchedule[sortedSchedule.length - 1];
  if (currentMinute >= lastPoint.minute) {
    return roundToTwoDecimals(lastPoint.value);
  }

  for (let index = 0; index < sortedSchedule.length - 1; index += 1) {
    const startPoint = sortedSchedule[index];
    const endPoint = sortedSchedule[index + 1];

    if (currentMinute >= startPoint.minute && currentMinute < endPoint.minute) {
      return calcMinuteBlend(
        currentMinute,
        startPoint.value,
        endPoint.value,
        startPoint.minute,
        endPoint.minute,
      );
    }
  }

  return roundToTwoDecimals(lastPoint.value);
}
