import tastytradeApi from "~/core/tastytrade-client";
import { getDefaultAccountNumber } from "~/core/default-account";
import {
  getConservativeSpendableFunds,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
  getSpendableFundsForAccountType,
} from "~/core/account-balance";
import { getAccountMarginOrCash } from "~/core/default-account";
import { TastytradeAccountBalance } from "~/core/types";
import executePositionEvaluations, {
  cancelAllLiveOrders,
} from "./execute-position-evaluations";
import { getPositionEvaluations } from "./get-position-evaluations";
import {
  applyPositionSizeWeightCaps,
  averageExecutionTargets,
  getDynamicTakeProfitTarget,
  getTimeOfDayExecutionTargets,
} from "./evaluate-trading-strategy";
import { setLastBotRunState } from "./last-run-state";
import {
  appendRunHistory,
  RunCloseOrder,
  RunGroupReturn,
  RunHistoryEntry,
  RunPlanSelectedGroup,
  RunPlanRow,
  RunStrategyDecision,
} from "./run-history";
import {
  buildInitialBudget,
  getUpdatedBudgetAfterAllocation,
  manageAllocationForGroup,
} from "./actions/manage-allocation";
import {
  getDoNotTouchGroupKeys,
  isEvaluationDoNotTouch,
} from "./do-not-touch-groups";
import { PositionGroupEvaluation } from "./evaluate-position";
import {
  selectManageEvaluationsByBuyingPower,
} from "./group-allocation-priority";
import {
  getCachedSecretSourcePositions,
  getSecretPositionSignalsForSymbol,
  getSecretSocketStatus,
  startSecretSocketConnection,
} from "./secret";
import { buildGroupExecutionTargets } from "./group-execution-targets";

export interface RunCyclePreview {
  accountNumber: string;
  groups: RunGroupReturn[];
  plan: {
    diagnostics: {
      currentReturnPct: number;
      groupKey?: string;
      skippedReason: string;
      strategyAction: "MANAGE_ALLOCATION" | "CLOSE_POSITION";
      underlyingSymbol: string;
    }[];
    ignoredGroups: RunPlanSelectedGroup[];
    rows: RunPlanRow[];
    selectedGroups: RunPlanSelectedGroup[];
    unselectedGroups: RunPlanSelectedGroup[];
    totalContracts: number;
    totalEstimatedCost: number;
  };
  snapshot: {
    dynamicTakeProfitTarget: number;
    currentExposurePct: number;
    currentExposureValue: number;
    secondsSinceLastPositionsUpdate: number | null;
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
  strategySummary: {
    closePositionCount: number;
    manageAllocationCount: number;
  };
}

type RunCycleContext = {
  accountBalances: TastytradeAccountBalance;
  baseExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  };
  completedEvaluations: PositionGroupEvaluation[];
  evaluationsWithGroupTargets: PositionGroupEvaluation[];
  preview: RunCyclePreview;
  runExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  };
  strategyDecisions: RunStrategyDecision[];
};

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function logRunSnapshot(preview: RunCyclePreview): void {
  const secretStatus = getSecretSocketStatus();
  const secondsSinceLastPositionsUpdate =
    secretStatus.secondsSinceLastPositionsUpdate === null
      ? "n/a"
      : `${secretStatus.secondsSinceLastPositionsUpdate.toFixed(1)}s`;

  console.log("\n================ RUN SNAPSHOT ================");
  console.log(
    `Current Exposure: ${formatPercent(preview.snapshot.currentExposurePct)} (${formatCurrency(preview.snapshot.currentExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(
    `Target Exposure:  ${formatPercent(preview.snapshot.targetExposurePct)} (${formatCurrency(preview.snapshot.targetExposureValue)} of ${formatCurrency(preview.snapshot.totalCapital)})`,
  );
  console.log(`Target DTE:       ${preview.snapshot.targetDTE}`);
  console.log(
    `Take Profit:      ${formatPercent(preview.snapshot.dynamicTakeProfitTarget)}`,
  );
  console.log(
    `Route Weights:    bid=${preview.snapshot.routeWeights.bid.toFixed(2)} mid=${preview.snapshot.routeWeights.mid.toFixed(2)} ask=${preview.snapshot.routeWeights.ask.toFixed(2)}`,
  );
  console.log(
    `Secret Socket:    connected=${secretStatus.connected} positions=${secretStatus.cachedPositionsCount} secondsSinceLastPositionsUpdate=${secondsSinceLastPositionsUpdate}`,
  );
  console.log("===============================================\n");
}

function logRunPlan(preview: RunCyclePreview): void {
  console.log("\n================= RUN PLAN =================");
  console.log(`Account: ${preview.accountNumber}`);
  console.log(
    `Strategy groups: manage=${preview.strategySummary.manageAllocationCount} close=${preview.strategySummary.closePositionCount}`,
  );

  if (preview.plan.ignoredGroups.length > 0) {
    console.log("Ignored do-not-touch groups:");
    for (const group of preview.plan.ignoredGroups) {
      console.log(
        `- ${group.groupKey} (${group.strategyAction ?? "UNKNOWN"}, currentReturn=${formatPercent(group.currentReturnPct)})`,
      );
    }
  }

  if (preview.plan.rows.length === 0) {
    console.log("No allocation orders planned for this cycle.");

    if (preview.plan.diagnostics.length > 0) {
      console.log("Planning diagnostics:");
      for (const item of preview.plan.diagnostics) {
        console.log(
          `- ${item.underlyingSymbol}: ${item.skippedReason} (currentReturn=${formatPercent(item.currentReturnPct)})`,
        );
      }
    }

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

  console.log(
    "underlying            side   bid%      ask%      current%   costBasis     unrlzdBid$   unrlzdAsk$",
  );
  console.log(
    "--------------------  -----  --------  --------  ---------  -----------  -----------  -----------",
  );

  for (const group of groupReturns) {
    const underlying = group.underlyingSymbol.padEnd(20, " ");
    const side = group.side.padEnd(5, " ");
    const bidReturn = formatPercent(group.bidReturnPct).padStart(8, " ");
    const askReturn = formatPercent(group.askReturnPct).padStart(8, " ");
    const currentReturn = formatPercent(group.currentReturnPct).padStart(
      9,
      " ",
    );
    const costBasis = formatCurrency(group.totalCostBasis).padStart(11, " ");
    const unrealizedBid = formatCurrency(
      group.totalUnrealizedReturnBid,
    ).padStart(11, " ");
    const unrealizedAsk = formatCurrency(
      group.totalUnrealizedReturnAsk,
    ).padStart(11, " ");
    console.log(
      `${underlying}  ${side}  ${bidReturn}  ${askReturn}  ${currentReturn}  ${costBasis}  ${unrealizedBid}  ${unrealizedAsk}`,
    );
  }

  console.log("===========================================\n");
}

function logStrategyDecisions(strategyDecisions: RunStrategyDecision[]): void {
  console.log("\n========== STRATEGY DECISIONS ===========");

  if (strategyDecisions.length === 0) {
    console.log("No strategy decisions available.");
    console.log("========================================\n");
    return;
  }

  for (const decision of strategyDecisions) {
    console.log(`\n${decision.underlyingSymbol}`);
    console.log(`  Action: ${decision.strategyAction}`);
    console.log(`  Return: ${formatPercent(decision.currentReturnPct)}`);
    console.log(`  Reason: ${decision.reason}`);
  }

  console.log("\n========================================\n");
}

function logExecutionTargetsByGroup(
  evaluations: PositionGroupEvaluation[],
  baseExecutionTargets: {
    askWeight: number;
    bidWeight: number;
    midWeight: number;
    targetAccountExposure: number;
    targetDTE: number;
  },
  currentTime: Date,
): void {
  console.log("\n=== EXECUTION TARGETS BY GROUP ===");
  console.log(
    `Time-of-Day Base (shared): exp=${formatPercent(baseExecutionTargets.targetAccountExposure)}, dte=${baseExecutionTargets.targetDTE}, bid=${baseExecutionTargets.bidWeight.toFixed(2)}/mid=${baseExecutionTargets.midWeight.toFixed(2)}/ask=${baseExecutionTargets.askWeight.toFixed(2)}`,
  );
  console.log("Secret Socket: per-group by ticker (configured positions source key)");

  const manageAllocations = evaluations.filter(
    (e) => e.strategy.action === "MANAGE_ALLOCATION",
  );

  if (manageAllocations.length === 0) {
    console.log("No MANAGE_ALLOCATION groups to show.");
    console.log("===================================\n");
    return;
  }

  const { secondsSinceLastPositionsUpdate } = getSecretSocketStatus();
  const secretPositionsAge =
    secondsSinceLastPositionsUpdate === null
      ? "n/a"
      : `${secondsSinceLastPositionsUpdate.toFixed(1)}s`;

  for (const evaluation of manageAllocations) {
    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const askReturnPerc =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    const timeSinceLastActionMs =
      currentTime.getTime() - evaluation.metrics.lastActionTime.getTime();
    const timeSinceLastActionMinutes = timeSinceLastActionMs / (1000 * 60);

    const groupTargetComponents = buildGroupExecutionTargets({
      askReturnPerc,
      baseExecutionTargets,
      currentExposurePct: 0,
      currentTime,
      symbol: evaluation.underlyingSymbol,
      timeSinceLastActionMs,
    });
    const groupTargets = groupTargetComponents.positionGroupTargets;
    const secretBuyWeight = groupTargetComponents.secretBuyWeight;
    const secretSignals = groupTargetComponents.secretSignals;
    const secretGroupTargets = groupTargetComponents.secretExecutionTargets;
    const blendedTargets = groupTargetComponents.blendedTargets;

    console.log(`\n${evaluation.underlyingSymbol}`);
    console.log(
      `  Position Health: ask_return=${formatPercent(askReturnPerc)}, stale=${timeSinceLastActionMinutes.toFixed(1)}min`,
    );
    if (groupTargetComponents.noBuyGateActive) {
      console.log("  Group Targets (position-based): no-buy gate active");
    } else if (groupTargets) {
      console.log(
        `  Group Targets (position-based): exp=${formatPercent(groupTargets.targetAccountExposure)}, bid=${groupTargets.bidWeight.toFixed(2)}/mid=${groupTargets.midWeight.toFixed(2)}/ask=${groupTargets.askWeight.toFixed(2)}`,
      );
    } else {
      console.log("  Group Targets (position-based): unavailable because no position is open");
    }
    if (secretGroupTargets) {
      console.log(
        `  Secret Targets (ticker match): buyWeight=${secretBuyWeight ?? "n/a"}, daytradeScore=${secretSignals?.daytradeScore ?? "n/a"}, returnPerc=${secretSignals?.returnPerc ?? "n/a"}, superRecScore=${secretSignals?.superRecScore ?? "n/a"}, positionsAge=${secretPositionsAge}, exp=${formatPercent(secretGroupTargets.targetAccountExposure)}, bid=${secretGroupTargets.bidWeight.toFixed(2)}/mid=${secretGroupTargets.midWeight.toFixed(2)}/ask=${secretGroupTargets.askWeight.toFixed(2)}`,
      );
    } else {
      console.log("  Secret Targets (ticker match): unavailable for this symbol");
    }
    console.log(
      `  Blended (averaged): exp=${formatPercent(blendedTargets.targetAccountExposure)}, bid=${blendedTargets.bidWeight.toFixed(2)}/mid=${blendedTargets.midWeight.toFixed(2)}/ask=${blendedTargets.askWeight.toFixed(2)}`,
    );
    if (evaluation.executionTargets) {
      console.log(
        `  Final (post-caps):  exp=${formatPercent(evaluation.executionTargets.targetAccountExposure)}, bid=${evaluation.executionTargets.bidWeight.toFixed(2)}/mid=${evaluation.executionTargets.midWeight.toFixed(2)}/ask=${evaluation.executionTargets.askWeight.toFixed(2)}`,
      );
    }
  }

  console.log("\n===================================\n");
}

function computeGroupReturns(
  completedEvaluations: PositionGroupEvaluation[],
): RunGroupReturn[] {
  return completedEvaluations.map((evaluation) => {
    const secretSignals = getSecretPositionSignalsForSymbol(evaluation.underlyingSymbol);
    const firstSymbol = String(evaluation.positions[0]?.symbol ?? "").trim();
    const sideMatch = firstSymbol.match(/([CP])(\d+)$/i);
    const side: "call" | "put" | "none" = sideMatch
      ? sideMatch[1].toUpperCase() === "P"
        ? "put"
        : "call"
      : "none";

    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const totalQuantityWeight = evaluation.positionSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.quantityWeight,
      0,
    );
    const totalCostBasis = weightedAverageFill * totalQuantityWeight;
    const bidReturnPct =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentBidPrice - weightedAverageFill) /
          weightedAverageFill
        : 0;
    const askReturnPct =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) /
          weightedAverageFill
        : 0;
    const totalUnrealizedReturnBid =
      (evaluation.metrics.currentBidPrice - weightedAverageFill) *
      totalQuantityWeight;
    const totalUnrealizedReturnAsk =
      (evaluation.metrics.currentAskPrice - weightedAverageFill) *
      totalQuantityWeight;

    return {
      askReturnPct,
      bidReturnPct,
      currentReturnPct: evaluation.currentReturn,
      buyWeight: evaluation.secretBuyWeight ?? null,
      daytradeScore: secretSignals?.daytradeScore ?? null,
      returnPerc: secretSignals?.returnPerc ?? null,
      superRecScore: secretSignals?.superRecScore ?? null,
      side,
      totalCostBasis,
      totalUnrealizedReturnAsk,
      totalUnrealizedReturnBid,
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  });
}

function computeStrategyDecisions(
  completedEvaluations: PositionGroupEvaluation[],
): RunStrategyDecision[] {
  return completedEvaluations
    .map((evaluation) => ({
      currentReturnPct: evaluation.currentReturn,
      reason: evaluation.strategy.reason,
      strategyAction: evaluation.strategy.action,
      underlyingSymbol: evaluation.underlyingSymbol,
    }))
    .sort((left, right) => {
      if (left.underlyingSymbol !== right.underlyingSymbol) {
        return left.underlyingSymbol.localeCompare(right.underlyingSymbol);
      }

      return left.strategyAction.localeCompare(right.strategyAction);
    });
}

function normalizeGroupExecutionTargetExposures(
  evaluations: PositionGroupEvaluation[],
  totalTargetExposure: number,
): PositionGroupEvaluation[] {
  const roundToTwoDecimals = (value: number): number =>
    Math.round(value * 100) / 100;

  const totalRawExposure = evaluations.reduce(
    (sum, evaluation) => sum + (evaluation.executionTargets?.targetAccountExposure ?? 0),
    0,
  );

  if (!(totalRawExposure > 0) || !(totalTargetExposure > 0)) {
    return evaluations;
  }

  let allocatedExposure = 0;

  return evaluations.map((evaluation, index) => {
    const executionTargets = evaluation.executionTargets;
    if (!executionTargets) {
      return evaluation;
    }

    const normalizedExposure =
      index === evaluations.length - 1
        ? roundToTwoDecimals(totalTargetExposure - allocatedExposure)
        : roundToTwoDecimals(
            totalTargetExposure *
              (executionTargets.targetAccountExposure / totalRawExposure),
          );

    allocatedExposure += normalizedExposure;

    return {
      ...evaluation,
      executionTargets: {
        ...executionTargets,
        targetAccountExposure: normalizedExposure,
      },
    };
  });
}

function parseOptionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRunPlanSelectedGroup(
  evaluation: PositionGroupEvaluation,
  rank: number,
  fallbackTargetDTE: number,
): RunPlanSelectedGroup {
  return {
    askWeight: evaluation.executionTargets?.askWeight ?? 0,
    bidWeight: evaluation.executionTargets?.bidWeight ?? 0,
    currentReturnPct: evaluation.currentReturn,
    groupKey: evaluation.groupKey,
    midWeight: evaluation.executionTargets?.midWeight ?? 0,
    rank,
    secretBuyWeight: evaluation.secretBuyWeight ?? null,
    strategyAction: evaluation.strategy.action,
    targetAccountExposure:
      evaluation.executionTargets?.targetAccountExposure ?? 0,
    targetDTE: evaluation.executionTargets?.targetDTE ?? fallbackTargetDTE,
    underlyingSymbol: evaluation.underlyingSymbol,
  };
}

function mapCloseOrdersForRunHistory(
  closeOrders: Awaited<ReturnType<typeof executePositionEvaluations>>["closeOrders"],
): RunCloseOrder[] {
  return closeOrders.map((result) => {
    const order = result.orderResponse?.order;
    const legs = Array.isArray(order?.legs) ? order.legs : [];
    const fills = legs.flatMap((leg) =>
      (Array.isArray(leg.fills) ? leg.fills : []).map((fill) => ({
        fillId: String(fill["fill-id"] ?? "").trim() || null,
        fillPrice: parseOptionalNumber(fill["fill-price"]),
        filledAt: String(fill["filled-at"] ?? "").trim() || null,
        quantity: parseOptionalNumber(fill.quantity),
      })),
    );

    return {
      fills,
      orderId: String(order?.id ?? "").trim() || null,
      placedOrder: result.placedOrder,
      price: parseOptionalNumber(order?.price),
      skippedReason: result.skippedReason ?? null,
      status: String(order?.status ?? "").trim() || null,
      symbol: result.symbol,
      underlyingSymbol: result.underlyingSymbol,
    };
  });
}

async function buildRunCycleContext(
  accountNumber?: string,
): Promise<RunCycleContext> {
  const resolvedAccountNumber =
    accountNumber ?? (await getDefaultAccountNumber());

  const accountBalances: TastytradeAccountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      resolvedAccountNumber,
    );
  const accountMarginOrCash = await getAccountMarginOrCash(
    resolvedAccountNumber,
  );

  console.log(
    JSON.stringify(
      {
        scope: "account-balances",
        accountNumber: resolvedAccountNumber,
        accountBalances,
      },
      null,
      2,
    ),
  );

  const buyingPower = getSpendableFundsForAccountType(
    accountBalances,
    accountMarginOrCash,
  );
  const doNotTouchGroupKeys = getDoNotTouchGroupKeys();

  const completedEvaluations = await getPositionEvaluations(
    resolvedAccountNumber,
  );
  const ignoredEvaluations = completedEvaluations.filter((evaluation) =>
    isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys),
  );
  const actionableCompletedEvaluations = completedEvaluations.filter(
    (evaluation) => !isEvaluationDoNotTouch(evaluation, doNotTouchGroupKeys),
  );
  const groupReturns = computeGroupReturns(completedEvaluations);
  const strategyDecisions = computeStrategyDecisions(completedEvaluations).map(
    (decision) => {
      const matchedEvaluation = completedEvaluations.find(
        (evaluation) => evaluation.underlyingSymbol === decision.underlyingSymbol,
      );

      if (
        matchedEvaluation &&
        isEvaluationDoNotTouch(matchedEvaluation, doNotTouchGroupKeys)
      ) {
        return {
          ...decision,
          reason: `DO_NOT_TOUCH group configured - ${decision.reason}`,
        };
      }

      return decision;
    },
  );
  const currentTime = new Date();

  startSecretSocketConnection();
  const timeOfDayExecutionTargets = getTimeOfDayExecutionTargets(currentTime);
  const cachedSecretPositions = getCachedSecretSourcePositions();
  console.log(
    `[secret] cached source positions: ${cachedSecretPositions.length}`,
  );
  const secretSocketStatus = getSecretSocketStatus();
  const baseExecutionTargets = timeOfDayExecutionTargets;
  const dynamicTakeProfitTarget = getDynamicTakeProfitTarget(currentTime);

  const startingBudget = buildInitialBudget(
    buyingPower,
    getEffectiveTotalCapital(accountBalances),
    actionableCompletedEvaluations,
  );

  const currentExposurePct =
    startingBudget.totalCapital > 0
      ? startingBudget.portfolioExposure / startingBudget.totalCapital
      : 0;
  const runExecutionTargets = applyPositionSizeWeightCaps(
    baseExecutionTargets,
    currentExposurePct,
  );

  // Calculate per-group execution targets based on position stats
  const evaluationsWithGroupTargets = actionableCompletedEvaluations.map((evaluation) => {
    const weightedAverageFill = evaluation.metrics.weightedAverageFill;
    const askReturnPerc =
      weightedAverageFill > 0
        ? (evaluation.metrics.currentAskPrice - weightedAverageFill) / weightedAverageFill
        : 0;
    const timeSinceLastActionMs =
      currentTime.getTime() - evaluation.metrics.lastActionTime.getTime();

    // Get position group-based targets
    const groupTargetComponents = buildGroupExecutionTargets({
      askReturnPerc,
      baseExecutionTargets,
      currentExposurePct,
      currentTime,
      symbol: evaluation.underlyingSymbol,
      timeSinceLastActionMs,
    });
    const finalTargets = groupTargetComponents.finalPostCapsTargets;

    return {
      ...evaluation,
      executionTargets: finalTargets,
    };
  });

  const plannedManageEvaluations = selectManageEvaluationsByBuyingPower(
    evaluationsWithGroupTargets.filter(
      (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
    ),
    buyingPower,
  ).sort((a, b) => a.currentReturn - b.currentReturn);

  const selectedUnderlyingSymbols = new Set(
    plannedManageEvaluations.map((evaluation) => evaluation.underlyingSymbol),
  );

  const unselectedManageEvaluations = evaluationsWithGroupTargets
    .filter((evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION")
    .filter(
      (evaluation) => !selectedUnderlyingSymbols.has(evaluation.underlyingSymbol),
    )
    .sort((a, b) => {
      const aExposure = a.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;
      const bExposure = b.executionTargets?.targetAccountExposure ?? Number.NEGATIVE_INFINITY;

      if (bExposure !== aExposure) {
        return bExposure - aExposure;
      }

      if (a.currentReturn !== b.currentReturn) {
        return a.currentReturn - b.currentReturn;
      }

      const aBuyWeight = a.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
      const bBuyWeight = b.secretBuyWeight ?? Number.NEGATIVE_INFINITY;
      return bBuyWeight - aBuyWeight;
    });

  const normalizedPlannedManageEvaluations = normalizeGroupExecutionTargetExposures(
    plannedManageEvaluations,
    runExecutionTargets.targetAccountExposure,
  );

  // For snapshot, use average of all planned group targets
  const plannedGroupTargets = normalizedPlannedManageEvaluations
    .map((e) => e.executionTargets)
    .filter((t): t is typeof runExecutionTargets => Boolean(t));
  
  const snapshotExecutionTargets =
    plannedGroupTargets.length > 0
      ? {
          ...averageExecutionTargets(plannedGroupTargets),
          targetAccountExposure: runExecutionTargets.targetAccountExposure,
        }
      : runExecutionTargets;

  const targetExposureValue =
    startingBudget.totalCapital * snapshotExecutionTargets.targetAccountExposure;

  const plannedRows: RunPlanRow[] = [];
  const planDiagnostics: RunCyclePreview["plan"]["diagnostics"] = [];
  const ignoredGroups: RunPlanSelectedGroup[] = ignoredEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );
  const selectedGroups: RunPlanSelectedGroup[] = normalizedPlannedManageEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );
  const unselectedGroups: RunPlanSelectedGroup[] = unselectedManageEvaluations.map(
    (evaluation, index) =>
      toRunPlanSelectedGroup(evaluation, index + 1, runExecutionTargets.targetDTE),
  );

  let planningBudget = startingBudget;
  for (const [index, evaluation] of normalizedPlannedManageEvaluations.entries()) {
    const groupsRemainingForAllocation =
      normalizedPlannedManageEvaluations.length - index;
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

    const plannedQuantity = planResult.routeOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.quantity,
      0,
    );

    if (plannedQuantity < 1) {
      planDiagnostics.push({
        currentReturnPct: evaluation.currentReturn,
        groupKey: evaluation.groupKey,
        skippedReason:
          planResult.skippedReason ??
          "allocated quantity rounded to zero for all routes",
        strategyAction: evaluation.strategy.action,
        underlyingSymbol: evaluation.underlyingSymbol,
      });
    }

    planningBudget = getUpdatedBudgetAfterAllocation(
      planningBudget,
      evaluation,
      {
        ...planResult,
        placedOrder: (planResult.quantity ?? 0) > 0,
      },
    );
  }

  return {
    accountBalances,
    baseExecutionTargets,
    completedEvaluations,
    evaluationsWithGroupTargets,
    preview: {
      accountNumber: resolvedAccountNumber,
      groups: groupReturns,
      plan: {
        diagnostics: planDiagnostics,
        ignoredGroups,
        rows: plannedRows,
        selectedGroups,
        unselectedGroups,
        totalContracts: plannedRows.reduce((sum, row) => sum + row.quantity, 0),
        totalEstimatedCost: plannedRows.reduce(
          (sum, row) => sum + row.estimatedCost,
          0,
        ),
      },
      snapshot: {
        dynamicTakeProfitTarget,
        currentExposurePct,
        currentExposureValue: startingBudget.portfolioExposure,
        secondsSinceLastPositionsUpdate:
          secretSocketStatus.secondsSinceLastPositionsUpdate,
        routeWeights: {
          ask: snapshotExecutionTargets.askWeight,
          bid: snapshotExecutionTargets.bidWeight,
          mid: snapshotExecutionTargets.midWeight,
        },
        targetDTE: snapshotExecutionTargets.targetDTE,
        targetExposurePct: snapshotExecutionTargets.targetAccountExposure,
        targetExposureValue,
        totalCapital: startingBudget.totalCapital,
      },
      strategySummary: {
        closePositionCount: actionableCompletedEvaluations.filter(
          (evaluation) => evaluation.strategy.action === "CLOSE_POSITION",
        ).length,
        manageAllocationCount: actionableCompletedEvaluations.filter(
          (evaluation) => evaluation.strategy.action === "MANAGE_ALLOCATION",
        ).length,
      },
    },
    runExecutionTargets: snapshotExecutionTargets,
    strategyDecisions,
  };
}

export async function getRunCyclePreview(
  accountNumber?: string,
): Promise<RunCyclePreview> {
  const context = await buildRunCycleContext(accountNumber);
  return context.preview;
}

export async function runBotCycleLogOnly(
  accountNumber?: string,
): Promise<RunCyclePreview> {
  const context = await buildRunCycleContext(accountNumber);

  console.log({
    accountNumber: context.preview.accountNumber,
    run: "bot-cycle-log-only",
  });

  logRunSnapshot(context.preview);
  logGroupReturns(context.preview.groups);
  logExecutionTargetsByGroup(
    context.evaluationsWithGroupTargets,
    context.baseExecutionTargets,
    new Date(),
  );
  logRunPlan(context.preview);
  logStrategyDecisions(context.strategyDecisions);

  return context.preview;
}

export default async function runBotCycle(
  accountNumber?: string,
): Promise<RunHistoryEntry> {
  await cancelAllLiveOrders(accountNumber);

  const context = await buildRunCycleContext(accountNumber);

  console.log({
    accountNumber: context.preview.accountNumber,
    run: "bot-cycle",
  });

  logRunSnapshot(context.preview);
  logGroupReturns(context.preview.groups);
  logExecutionTargetsByGroup(
    context.evaluationsWithGroupTargets,
    context.baseExecutionTargets,
    new Date(),
  );
  logRunPlan(context.preview);
  logStrategyDecisions(context.strategyDecisions);

  const executionResults = await executePositionEvaluations(
    context.preview.accountNumber,
    context.accountBalances,
    context.completedEvaluations,
    context.runExecutionTargets,
  );

  const executionSummary = {
    allocationEstimatedTotal: executionResults.allocationOrders.reduce(
      (sum, order) => sum + (order.estimatedOrderValue ?? 0),
      0,
    ),
    allocationPlacedCount: executionResults.allocationOrders.filter(
      (order) => order.placedOrder,
    ).length,
    allocationSkippedCount: executionResults.allocationOrders.filter(
      (order) => !order.placedOrder,
    ).length,
    cancelledOrderCount: executionResults.cancelledOrders.filter(
      (order) => order.cancelled,
    ).length,
    closeOrderCount: executionResults.closeOrders.length,
  };

  const runHistoryEntry = await appendRunHistory({
    accountNumber: context.preview.accountNumber,
    closeOrders: mapCloseOrdersForRunHistory(executionResults.closeOrders),
    executionSummary,
    groups: context.preview.groups,
    plan: context.preview.plan,
    strategyDecisions: context.strategyDecisions,
    snapshot: context.preview.snapshot,
  });

  setLastBotRunState(
    context.preview.accountNumber,
    context.completedEvaluations,
    executionResults,
  );

  console.log("Execution results:", JSON.stringify(executionResults, null, 2));

  return runHistoryEntry;
}
