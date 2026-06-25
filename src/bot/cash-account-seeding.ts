import {
  getGroupSideForPositions,
  type PositionGroupEvaluation,
} from "./evaluate-position";

const DEFAULT_CASH_ACCOUNT_SEED_FROM_MARGIN_END_MINUTE = 11 * 60 + 30;

export interface CashAccountSeedCandidate {
  askReturnPerc: number;
  side: "call" | "put";
  underlyingSymbol: string;
}

function toAskReturnPct(askReturnPerc: number): number {
  return Number((askReturnPerc * 100).toFixed(4));
}

function parseMinuteOfDay(value: string | undefined): number | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);
  if (!match) {
    return null;
  }

  const [hoursText, minutesText] = trimmed.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

export function getCashAccountSeedFromMarginMaxAskReturnPct(): number | null {
  const raw = process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_MAX_ASK_RETURN_PCT?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function getCashAccountSeedFromMarginEndMinute(): number {
  return (
    parseMinuteOfDay(process.env.BOT_CASH_ACCOUNT_SEED_FROM_MARGIN_END_TIME)
    ?? DEFAULT_CASH_ACCOUNT_SEED_FROM_MARGIN_END_MINUTE
  );
}

export function isWithinCashAccountSeedFromMarginWindow(currentTime: Date): boolean {
  const minuteOfDay = currentTime.getHours() * 60 + currentTime.getMinutes();
  return minuteOfDay < getCashAccountSeedFromMarginEndMinute();
}

export function getAskReturnPercForEvaluation(
  evaluation: PositionGroupEvaluation,
): number | null {
  const weightedAverageFill = evaluation.metrics.weightedAverageFill;
  if (!(weightedAverageFill > 0)) {
    return null;
  }

  return (
    (evaluation.metrics.currentAskPrice - weightedAverageFill) /
    weightedAverageFill
  );
}

export function getCashAccountSeedCandidatesFromMarginEvaluations(
  evaluations: PositionGroupEvaluation[],
): CashAccountSeedCandidate[] {
  const maxAskReturnPct = getCashAccountSeedFromMarginMaxAskReturnPct();
  if (maxAskReturnPct === null) {
    return [];
  }

  return evaluations.flatMap((evaluation) => {
    if (evaluation.strategy.action !== "MANAGE_ALLOCATION") {
      return [];
    }

    const side = getGroupSideForPositions(evaluation.positions);
    if (side !== "call" && side !== "put") {
      return [];
    }

    const askReturnPerc = getAskReturnPercForEvaluation(evaluation);
    if (askReturnPerc === null || toAskReturnPct(askReturnPerc) >= maxAskReturnPct) {
      return [];
    }

    return [{
      askReturnPerc,
      side,
      underlyingSymbol: evaluation.underlyingSymbol,
    }];
  });
}