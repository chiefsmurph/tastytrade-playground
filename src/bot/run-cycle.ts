import tastytradeApi from "../core/tastytrade-client";
import {
  fetchNormalizedAccountBalance,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "../core/account-balance";
import { getBotConfig } from "../core/bot-config";
import { redactAccountNumber, safeJson } from "../core/logging";
import { withLiveTradingLock } from "../core/run-lock";
import { AccountBalance } from "../core/types";
import executePositionEvaluations, {
  cancelAllLiveOrders,
  PositionEvaluationExecutionResult,
} from "./execute-position-evaluations";
import { getPositionEvaluations } from "./get-position-evaluations";
import {
  applyPositionSizeWeightCaps,
  getDynamicTakeProfitTarget,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import { setLastBotRunState } from "./last-run-state";
import { appendRunHistory, RunGroupReturn, RunHistoryEntry, RunPlanRow } from "./run-history";
import {
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import { PositionGroupEvaluation } from "./evaluate-position";
import { getGroupMarketValue } from "./actions/order-utils";

export interface RunCyclePreview {
  accountNumber: string;
  groups: RunGroupReturn[];
  plan: {
    rows: RunPlanRow[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
    routeWeights: {
      ask: number;
      bid: number;
      mid: number;
    };
    targetDTE: number;
    targetExposurePct: number;
    targetExposureValue: number;
    totalCapital: number;
  };
}

type RunCycleContext = {
  accountBalances: AccountBalance;
  completedEvaluations: PositionGroupEvaluation[];
  preview: RunCyclePreview;
  runExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  };
};

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function logRunSnapshot(preview: RunCyclePreview): void {
  console.log("\n================ RUN SNAPSHOT ================");
  console.log(
    `Current Exposure: ${formatPercent(preview.snapshot.currentExposurePct)} (${formatCurrency(preview.snapshot.currentExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(
    `Target Exposure:  ${formatPercent(preview.snapshot.targetExposurePct)} (${formatCurrency(preview.snapshot.targetExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(`Target DTE:       ${preview.snapshot.targetDTE}`);
  console.log(`Take Profit:      ${formatPercent(preview.snapshot.dynamicTakeProfitTarget)}`);
  console.log(
    `Route Weights:    bid=${preview.snapshot.routeWeights.bid.toFixed(2)} mid=${preview.snapshot.routeWeights.mid.toFixed(2)} ask=${preview.snapshot.routeWeights.ask.toFixed(2)}`,
  );
  console.log("===============================================\n");
}

function logRunPlan(preview: RunCyclePreview): void {
  console.log("\n================= RUN PLAN =================");
  console.log(`Account: ${redactAccountNumber(preview.accountNumber)}`);

  if (preview.plan.rows.length === 0) {
    console.log("No allocation orders planned for this cycle.");
    console.log("============================================\n");
    return;
  }

  console.log("symbol                route  qty   limit      estCost");
  console.log("--------------------  -----  ----  ---------  ----------");

  for (const row of preview.plan.rows) {
    const symbol = row.symbol.padEnd(20, " ");
    const route = row.route.padEnd(5, " ");
    const qty = String(row.quantity).padStart(4, " ");
    const limit = row.limitPrice.toFixed(2).padStart(9, " ");
    const estCost = formatCurrency(row.estimatedCost).padStart(10, " ");
    console.log(`${symbol}  ${route}  ${qty}  ${limit}  ${estCost}`);
  }

  console.log("--------------------  -----  ----  ---------  ----------");
  console.log(
    `TOTAL                            ${String(preview.plan.totalContracts).padStart(4, " ")}             ${formatCurrency(preview.plan.totalEstimatedCost).padStart(10, " ")}`,
  );
  console.log("============================================\n");
}

function logGroupReturns(groupReturns: RunGroupReturn[]): void {
  console.log("\n============== GROUP RETURNS ==============");

  if (groupReturns.length === 0) {
    console.log("No grouped position returns available.");
    console.log("===========================================\n");
    return;
  }

  console.log("underlying            bid%      ask%      current%   costBasis     unrlzdBid$   unrlzdAsk$");
  console.log("--------------------  --------  --------  ---------  -----------  -----------  -----------");

  for (const group of groupReturns) {
    const underlying = group.underlyingSymbol.padEnd(20, " ");
    const bidReturn = formatPercent(group.bidReturnPct).padStart(8, " ");
    const askReturn = formatPercent(group.askReturnPct).padStart(8, " ");
    const currentReturn = formatPercent(group.currentReturnPct).padStart(9, " ");
    const costBasis = formatCurrency(group.totalCostBasis).padStart(11, " ");
    const unrealizedBid = formatCurrency(group.totalUnrealizedReturnBid).padStart(11, " ");
    const unrealizedAsk = formatCurrency(group.totalUnrealizedReturnAsk).padStart(11, " ");
    console.log(`${underlying}  ${bidReturn}  ${askReturn}  ${currentReturn}  ${costBasis}  ${unrealizedBid}  ${unrealizedAsk}`);
  }

  console.log("===========================================\n");
}

function computeGroupReturns(
  completedEvaluations: PositionGroupEvaluation[],
): RunGroupReturn[] {
  return completedEvaluations.map((evaluation) => {
    const totalQuantityWeight = evaluation.positionSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.quantityWeight,
      0,
    );
    const totalCostBasis = evaluation.positionSnapshots.reduce(
      (sum, snapshot) =>
        sum + snapshot.weightedAverageFill * snapshot.quantityWeight,
      0,
    );
    const totalUnrealizedReturnBid = evaluation.positionSnapshots.reduce(
      (sum, snapshot) => {
        const value =
          snapshot.positionDirection === "short"
            ? snapshot.weightedAverageFill - snapshot.currentBidPrice
            : snapshot.currentBidPrice - snapshot.weightedAverageFill;
        return sum + value * snapshot.quantityWeight;
      },
      0,
    );
    const totalUnrealizedReturnAsk = evaluation.positionSnapshots.reduce(
      (sum, snapshot) => {
        const value =
          snapshot.positionDirection === "short"
            ? snapshot.weightedAverageFill - snapshot.currentAskPrice
            : snapshot.currentAskPrice - snapshot.weightedAverageFill;
        return sum + value * snapshot.quantityWeight;
      },
      0,
    );
    const bidReturnPct =
      totalCostBasis > 0 ? totalUnrealizedReturnBid / totalCostBasis : 0;
    const askReturnPct =
      totalCostBasis > 0 ? totalUnrealizedReturnAsk / totalCostBasis : 0;

    return {
      askReturnPct,
      bidReturnPct,
      currentReturnPct: evaluation.currentReturn,
      totalCostBasis,
      totalUnrealizedReturnAsk,
      totalUnrealizedReturnBid,
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  });
}

async function getDefaultAccountNumber(): Promise<string> {
  const accounts =
    await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  const accountNumber = accounts[0]?.account?.["account-number"];

  if (!accountNumber) {
    throw new Error("No account number available");
  }

  return accountNumber;
}

async function buildRunCycleContext(accountNumber?: string): Promise<RunCycleContext> {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());

  const accountBalances: AccountBalance =
    await fetchNormalizedAccountBalance(resolvedAccountNumber);

  const buyingPower = getAccountBalanceNumber(
    accountBalances,
    "derivative_buying_power",
    "derivative-buying-power",
  );

  const completedEvaluations = await getPositionEvaluations(resolvedAccountNumber);
  const groupReturns = computeGroupReturns(completedEvaluations);
  const currentTime = new Date();
  const baseExecutionTargets = getTimeOfDayExecutionTargets(currentTime);
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);

  const startingBudget = buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalances),
    completedEvaluations,
  );

  const currentExposurePct =
    startingBudget.totalCapital > 0
      ? startingBudget.portfolioExposure / startingBudget.totalCapital
      : 0;
  const runExecutionTargets = applyPositionSizeWeightCaps(
    baseExecutionTargets,
    currentExposurePct,
  );
  const targetExposureValue =
    startingBudget.totalCapital * runExecutionTargets.targetAccountExposure;

  const plannedManageEvaluations = completedEvaluations
    .map((evaluation) => ({
      ...evaluation,
      executionTargets: runExecutionTargets,
    }))
    .filter((evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION");
  if (getBotConfig().strategy.allocationPriority === "underweightThenBestReturn") {
    plannedManageEvaluations.sort((a, b) => {
      const exposureDelta =
        getGroupMarketValue(a.positionSnapshots) -
        getGroupMarketValue(b.positionSnapshots);
      if (exposureDelta !== 0) {
        return exposureDelta;
      }
      return b.currentReturn - a.currentReturn;
    });
  } else {
    plannedManageEvaluations.sort((a, b) => b.currentReturn - a.currentReturn);
  }

  const plannedRows: RunPlanRow[] = [];

  let planningBudget = startingBudget;
  for (const [index, evaluation] of plannedManageEvaluations.entries()) {
    const groupsRemainingForAllocation = plannedManageEvaluations.length - index;
    const planResult = await manageAllocationForGroup(
      resolvedAccountNumber,
      evaluation,
      planningBudget,
      groupsRemainingForAllocation,
      { dryRun: true },
    );

    for (const routeOrder of planResult.routeOrders) {
      if (routeOrder.quantity <= 0) {
        continue;
      }

      plannedRows.push({
        estimatedCost: routeOrder.estimatedOrderValue,
        limitPrice: routeOrder.limitPrice,
        quantity: routeOrder.quantity,
        route: routeOrder.route,
        symbol: planResult.candidateSymbol ?? evaluation.underlyingSymbol,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
    }

    planningBudget = getUpdatedBudgetAfterAllocation(planningBudget, evaluation, {
      ...planResult,
      placedOrder: (planResult.quantity ?? 0) > 0,
    });
  }

  return {
    accountBalances,
    completedEvaluations,
    preview: {
      accountNumber: resolvedAccountNumber,
      groups: groupReturns,
      plan: {
        rows: plannedRows,
        totalContracts: plannedRows.reduce((sum, row) => sum + row.quantity, 0),
        totalEstimatedCost: plannedRows.reduce((sum, row) => sum + row.estimatedCost, 0),
      },
      snapshot: {
        dynamicTakeProfitTarget,
        currentExposurePct,
        currentExposureValue: startingBudget.portfolioExposure,
        routeWeights: {
          ask: runExecutionTargets.askWeight,
          bid: runExecutionTargets.bidWeight,
          mid: runExecutionTargets.midWeight,
        },
        targetDTE: runExecutionTargets.targetDTE,
        targetExposurePct: runExecutionTargets.targetAccountExposure,
        targetExposureValue,
        totalCapital: startingBudget.totalCapital,
      },
    },
    runExecutionTargets,
  };
}

export async function getRunCyclePreview(accountNumber?: string): Promise<RunCyclePreview> {
  const context = await buildRunCycleContext(accountNumber);
  return context.preview;
}

async function runBotCycleUnlocked(accountNumber?: string): Promise<RunHistoryEntry> {
  const context = await buildRunCycleContext(accountNumber);

  console.log(safeJson({
    accountNumber: context.preview.accountNumber,
    run: "bot-cycle",
  }));

  const cancelledOrders = await cancelAllLiveOrders(context.preview.accountNumber);

  logRunSnapshot(context.preview);
  logGroupReturns(context.preview.groups);
  logRunPlan(context.preview);

  let executionResults: PositionEvaluationExecutionResult = {
    allocationOrders: [],
    cancelledOrders,
    closeOrders: [],
    evaluations: context.completedEvaluations,
  };
  let executionError: string | undefined;

  try {
    executionResults = await executePositionEvaluations(
      context.preview.accountNumber,
      context.accountBalances,
      context.completedEvaluations,
      context.runExecutionTargets,
      cancelledOrders,
    );
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    console.error("Execution failed:", executionError);
  }

  const executionSummary = {
    allocationEstimatedTotal: executionResults.allocationOrders.reduce(
      (sum, order) => sum + (order.estimatedOrderValue ?? 0),
      0,
    ),
    allocationFailedCount: executionResults.allocationOrders.filter((order) =>
      order.routeOrders.some((routeOrder) => routeOrder.safeOrderResult?.error != null),
    ).length,
    allocationPlacedCount: executionResults.allocationOrders.filter(
      (order) => order.placedOrder,
    ).length,
    allocationSkippedCount: executionResults.allocationOrders.filter(
      (order) => !order.placedOrder,
    ).length,
    cancelledOrderCount: executionResults.cancelledOrders.filter(
      (order) => order.cancelled,
    ).length,
    closePlacedCount: executionResults.closeOrders.filter(
      (order) => order.placedOrder,
    ).length,
    closeOrderCount: executionResults.closeOrders.length,
    closeSkippedCount: executionResults.closeOrders.filter(
      (order) => !order.placedOrder,
    ).length,
    skippedEvaluationCount: executionResults.evaluations.filter(
      (evaluation) => evaluation.strategy.action === "SKIP",
    ).length,
  };

  const runHistoryEntry = await appendRunHistory({
    accountNumber: context.preview.accountNumber,
    executionError,
    executionSummary,
    groups: context.preview.groups,
    plan: context.preview.plan,
    snapshot: context.preview.snapshot,
  });

  setLastBotRunState(
    context.preview.accountNumber,
    context.completedEvaluations,
    executionResults,
  );

  console.log(
    "Execution results:",
    safeJson(executionResults),
  );

  return runHistoryEntry;
}

export default async function runBotCycle(accountNumber?: string): Promise<RunHistoryEntry> {
  return withLiveTradingLock("runBotCycle", () => runBotCycleUnlocked(accountNumber));
}
