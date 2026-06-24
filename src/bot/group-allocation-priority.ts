import { PositionGroupEvaluation } from "./evaluate-position";

export const MIN_GROUP_ALLOCATION = 80;

export function sortManageEvaluationsByBuyWeight(
  evaluations: PositionGroupEvaluation[],
): PositionGroupEvaluation[] {
  return [...evaluations].sort((left, right) => {
    const leftBuyWeight = left.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
    const rightBuyWeight = right.secretBuyWeight ?? Number.NEGATIVE_INFINITY;

    if (rightBuyWeight !== leftBuyWeight) {
      return rightBuyWeight - leftBuyWeight;
    }

    return left.currentReturn - right.currentReturn;
  });
}

export function selectManageEvaluationsByBuyingPower(
  evaluations: PositionGroupEvaluation[],
  buyingPower: number,
  minimumGroupAllocation = MIN_GROUP_ALLOCATION,
): PositionGroupEvaluation[] {
  if (!Number.isFinite(buyingPower) || buyingPower <= 0) {
    return [];
  }

  const normalizedMinimumAllocation = Math.max(1, minimumGroupAllocation);
  const maxGroups = Math.floor(buyingPower / normalizedMinimumAllocation);

  if (maxGroups <= 0) {
    return [];
  }

  return sortManageEvaluationsByBuyWeight(evaluations).slice(0, maxGroups);
}