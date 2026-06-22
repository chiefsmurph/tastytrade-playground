import { getCurrentAllocationBudget } from "./actions/manage-allocation";
import { getTimeOfDayExecutionTargets } from "./evaluate-trading-strategy";

export interface EffectiveBuyingPowerSummary {
  buyingPowerRemaining: number;
  currentExposurePct: number;
  currentExposureValue: number;
  effectiveBuyingPower: number;
  exposureHeadroom: number;
  targetExposurePct: number;
  targetExposureValue: number;
  totalCapital: number;
}

export async function getEffectiveBuyingPowerSummary(
  accountNumber: string,
  currentTime = new Date(),
): Promise<EffectiveBuyingPowerSummary> {
  const budget = await getCurrentAllocationBudget(accountNumber);
  const executionTargets = getTimeOfDayExecutionTargets(currentTime);

  const targetExposureValue =
    budget.totalCapital * executionTargets.targetAccountExposure;
  const exposureHeadroom = Math.max(
    0,
    targetExposureValue - budget.portfolioExposure,
  );
  const effectiveBuyingPower = Math.max(
    0,
    Math.min(budget.buyingPowerRemaining, exposureHeadroom),
  );
  const currentExposurePct =
    budget.totalCapital > 0 ? budget.portfolioExposure / budget.totalCapital : 0;

  return {
    buyingPowerRemaining: budget.buyingPowerRemaining,
    currentExposurePct,
    currentExposureValue: budget.portfolioExposure,
    effectiveBuyingPower,
    exposureHeadroom,
    targetExposurePct: executionTargets.targetAccountExposure,
    targetExposureValue,
    totalCapital: budget.totalCapital,
  };
}
