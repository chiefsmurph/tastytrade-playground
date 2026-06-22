import tastytradeApi from "../core/tastytrade-client";
import { getAccountBalanceNumber, getEffectiveTotalCapital } from "../core/account-balance";
import { AccountBalance } from "../core/types";
import executePositionEvaluations, { cancelAllLiveOrders } from "./execute-position-evaluations";
import { getPositionEvaluations } from "./get-position-evaluations";
import { getTimeOfDayExecutionTargets } from "./evaluate-trading-strategy";
import { setLastBotRunState } from "./last-run-state";
import {
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function logRunPlan(
  accountNumber: string,
  rows: Array<{
    symbol: string;
    underlyingSymbol: string;
    route: string;
    quantity: number;
    limitPrice: number;
    estimatedCost: number;
  }>,
): void {
  console.log("\n================= RUN PLAN =================");
  console.log(`Account: ${accountNumber}`);

  if (rows.length === 0) {
    console.log("No allocation orders planned for this cycle.");
    console.log("============================================\n");
    return;
  }

  console.log("symbol                route  qty   limit      estCost");
  console.log("--------------------  -----  ----  ---------  ----------");

  for (const row of rows) {
    const symbol = row.symbol.padEnd(20, " ");
    const route = row.route.padEnd(5, " ");
    const qty = String(row.quantity).padStart(4, " ");
    const limit = row.limitPrice.toFixed(2).padStart(9, " ");
    const estCost = formatCurrency(row.estimatedCost).padStart(10, " ");
    console.log(`${symbol}  ${route}  ${qty}  ${limit}  ${estCost}`);
  }

  const totalContracts = rows.reduce((sum, row) => sum + row.quantity, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.estimatedCost, 0);
  console.log("--------------------  -----  ----  ---------  ----------");
  console.log(
    `TOTAL                            ${String(totalContracts).padStart(4, " ")}             ${formatCurrency(totalCost).padStart(10, " ")}`,
  );
  console.log("============================================\n");
}

export default async function everyFourMinutes() {
  const accounts =
    await tastytradeApi.accountsAndCustomersService.getCustomerAccounts();
  const extractedAccountNumbers: string[] = accounts.map(
    (item: any) => item.account["account-number"],
  );
  const accountNumber = extractedAccountNumbers[0];
  console.log({ accounts, extractedAccountNumbers, accountNumber });

  await cancelAllLiveOrders(accountNumber);

  const accountBalances: AccountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    );
  console.log(
    "Current account balances:",
    JSON.stringify(accountBalances, null, 2),
  );

  const buyingPower = getAccountBalanceNumber(
    accountBalances,
    "derivative_buying_power",
    "derivative-buying-power",
  );
  console.log("Current buying power:", buyingPower);

  const completedEvaluations = await getPositionEvaluations(accountNumber);
  const runExecutionTargets = getTimeOfDayExecutionTargets(new Date());

  const startingBudget = buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalances),
    completedEvaluations,
  );
  const currentExposurePct =
    startingBudget.totalCapital > 0
      ? startingBudget.portfolioExposure / startingBudget.totalCapital
      : 0;
  const targetExposureValue =
    startingBudget.totalCapital * runExecutionTargets.targetAccountExposure;

  console.log("\n================ RUN SNAPSHOT ================");
  console.log(`Current Exposure: ${formatPercent(currentExposurePct)} (${formatCurrency(startingBudget.portfolioExposure)} of ${formatCurrency(startingBudget.totalCapital)})`);
  console.log(`Target Exposure:  ${formatPercent(runExecutionTargets.targetAccountExposure)} (${formatCurrency(targetExposureValue)} of ${formatCurrency(startingBudget.totalCapital)})`);
  console.log(`Target DTE:       ${runExecutionTargets.targetDTE}`);
  console.log(
    `Route Weights:    bid=${runExecutionTargets.bidWeight.toFixed(2)} mid=${runExecutionTargets.midWeight.toFixed(2)} ask=${runExecutionTargets.askWeight.toFixed(2)}`,
  );
  console.log("===============================================\n");

  const plannedManageEvaluations = completedEvaluations
    .map((evaluation) => ({
      ...evaluation,
      executionTargets: runExecutionTargets,
    }))
    .filter((evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION")
    .sort((a, b) => a.currentReturn - b.currentReturn);

  const plannedRows: Array<{
    symbol: string;
    underlyingSymbol: string;
    route: string;
    quantity: number;
    limitPrice: number;
    estimatedCost: number;
  }> = [];

  let planningBudget = startingBudget;
  for (const [index, evaluation] of plannedManageEvaluations.entries()) {
    const groupsRemainingForAllocation = plannedManageEvaluations.length - index;
    const planResult = await manageAllocationForGroup(
      accountNumber,
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

  logRunPlan(accountNumber, plannedRows);

  const executionResults = await executePositionEvaluations(
    accountNumber,
    accountBalances,
    completedEvaluations,
    runExecutionTargets,
  );

  setLastBotRunState(
    accountNumber,
    completedEvaluations,
    executionResults,
  );

  console.log(
    "Grouped position evaluations:",
    JSON.stringify(
      completedEvaluations.map((evaluation) => ({
        underlyingSymbol: evaluation.underlyingSymbol,
        positionSymbols: evaluation.positions.map((position) => position.symbol),
        currentBidPrice: evaluation.metrics.currentBidPrice,
        currentAskPrice: evaluation.metrics.currentAskPrice,
        weightedAverageFill: evaluation.metrics.weightedAverageFill,
        currentReturn: evaluation.currentReturn,
        strategy: evaluation.strategy,
      })),
      null,
      2,
    ),
  );

  console.log(
    "Execution results:",
    JSON.stringify(executionResults, null, 2),
  );

  return executionResults;
}
