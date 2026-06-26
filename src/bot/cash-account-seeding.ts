import {
  getGroupSideForPositions,
  type PositionGroupEvaluation,
} from "./evaluate-position";
import {
  isWithinCashAccountSeedFromMarginWindow as isWithinCashAccountSeedFromMarginWindowShared,
} from "./seeding-windows";

export interface CashAccountSeedCandidate {
  askReturnPerc: number;
  side: "call" | "put";
  underlyingSymbol: string;
}

function toAskReturnPct(askReturnPerc: number): number {
  return Number((askReturnPerc * 100).toFixed(4));
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

export function isWithinCashAccountSeedFromMarginWindow(currentTime: Date): boolean {
  return isWithinCashAccountSeedFromMarginWindowShared(currentTime);
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