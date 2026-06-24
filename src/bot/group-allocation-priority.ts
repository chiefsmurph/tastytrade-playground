import { PositionGroupEvaluation } from "./evaluate-position";

export const MIN_GROUP_ALLOCATION = 80;

export function sortManageEvaluationsByTargetExposure(
  evaluations: PositionGroupEvaluation[],
): PositionGroupEvaluation[] {
  return [...evaluations].sort((left, right) => {
    const leftTargetExposure = left.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;
    const rightTargetExposure = right.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;

    if (rightTargetExposure !== leftTargetExposure) {
      return rightTargetExposure - leftTargetExposure;
    }

    if (left.currentReturn !== right.currentReturn) {
      return left.currentReturn - right.currentReturn;
    }

    const leftBuyWeight = left.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
    const rightBuyWeight = right.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
    return rightBuyWeight - leftBuyWeight;
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

  return sortManageEvaluationsByTargetExposure(evaluations).slice(0, maxGroups);
}