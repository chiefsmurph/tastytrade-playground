import { time } from "node:console";

export type ProgrammaticAction = "MANAGE_ALLOCATION" | "CLOSE_POSITION";

// Unified return structure containing target state goals for the execution loop
export interface ExecutionStrategy {
  action: ProgrammaticAction;
}

export interface ExecutionTargets {
  targetDTE: number;
  targetAccountExposure: number;
  bidWeight: number;
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

interface TimeSchedulePoint {
  minute: number;
  value: number;
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

function getTimeInMinutes(currentTime: Date): number {
  return currentTime.getHours() * 60 + currentTime.getMinutes();
}

/**
 * Main Institutional Decision Engine
 * Tracks the state targets of the portfolio. If the action is MANAGE_ALLOCATION,
 * the broker pipeline should inspect exposure and execute buy orders accordingly.
 */
export function evaluateTradingStrategy(metrics: PositionMetrics): ProgrammaticAction {
  const { currentBidPrice, weightedAverageFill, currentTime } = metrics;

  // 1. SYSTEM CLOCK CONVERSIONS (Pacific Standard Time - Minutes from midnight)
  const timeInMinutes = getTimeInMinutes(currentTime);

  const TWELVE_THIRTY_PM   = 12 * 60 + 30;
  const TWELVE_FIFTY_FIVE_PM = 12 * 60 + 55;

  const currentReturn = (currentBidPrice - weightedAverageFill) / weightedAverageFill;

  // 2. HARD CIRCUIT BREAKERS (EOD Liquidation & Risk Floors)
  if (timeInMinutes >= TWELVE_FIFTY_FIVE_PM) {
    return "CLOSE_POSITION"; // Liquidate instantly
  }

  // Take Profit Target Gate
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);
  if (currentReturn >= dynamicTakeProfitTarget) {
    return "CLOSE_POSITION";
  }

  // Absolute Risk Floor Check
  if (timeInMinutes < TWELVE_THIRTY_PM && currentReturn <= -0.30) {
    return "CLOSE_POSITION";
  }

  // 4. BLOCK ALL NEW ACCUMULATION PAST THE 12:30 PM LINE
  if (timeInMinutes >= TWELVE_THIRTY_PM) {
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

  const SIX_THIRTY_AM      = 6 * 60 + 30;
  const NINE_AM            = 9 * 60 + 0;
  const TEN_AM             = 10 * 60 + 0;
  const ELEVEN_AM          = 11 * 60 + 0;
  const ELEVEN_THIRTY_AM   = 11 * 60 + 30;
  const TWELVE_THIRTY_PM   = 12 * 60 + 30;

  const targetDTE = Math.round(
    blendBySchedule(timeInMinutes, [
      { minute: SIX_THIRTY_AM, value: 30 },
      { minute: NINE_AM, value: 25 },
      { minute: TEN_AM, value: 20 },
      { minute: ELEVEN_AM, value: 14 },
      { minute: ELEVEN_THIRTY_AM, value: 7 },
      { minute: TWELVE_THIRTY_PM, value: 7 },
    ]),
  );
  const targetAccountExposure = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.50 },
    { minute: NINE_AM, value: 0.50 },
    { minute: TEN_AM, value: 0.65 },
    { minute: ELEVEN_AM, value: 0.75 },
    { minute: ELEVEN_THIRTY_AM, value: 1.00 },
    { minute: TWELVE_THIRTY_PM, value: 1.00 },
  ]);
  const bidWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.70 },
    { minute: NINE_AM, value: 0.50 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.20 },
    { minute: ELEVEN_THIRTY_AM, value: 0.00 },
    { minute: TWELVE_THIRTY_PM, value: 0.00 },
  ]);
  const midWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.20 },
    { minute: NINE_AM, value: 0.30 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.30 },
    { minute: ELEVEN_THIRTY_AM, value: 0.00 },
    { minute: TWELVE_THIRTY_PM, value: 0.00 },
  ]);
  const askWeight = blendBySchedule(timeInMinutes, [
    { minute: SIX_THIRTY_AM, value: 0.10 },
    { minute: NINE_AM, value: 0.20 },
    { minute: TEN_AM, value: 0.33 },
    { minute: ELEVEN_AM, value: 0.50 },
    { minute: ELEVEN_THIRTY_AM, value: 1.00 },
    { minute: TWELVE_THIRTY_PM, value: 1.00 },
  ]);

  if (timeInMinutes >= TWELVE_THIRTY_PM) {
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
  return {
    action: evaluateTradingStrategy(metrics),
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
      return calcTimeBlend(
        new Date(0, 0, 0, Math.floor(currentMinute / 60), currentMinute % 60),
        startPoint.value,
        endPoint.value,
        startPoint.minute,
        endPoint.minute,
      );
    }
  }

  return roundToTwoDecimals(lastPoint.value);
}