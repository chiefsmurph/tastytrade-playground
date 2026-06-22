import {
  fetchNormalizedAccountBalance,
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "../../core/account-balance";
import { getBotConfig } from "../../core/bot-config";
import { getBidAskForSymbol } from "../../core/market-data";
import { getPositionEvaluations } from "../get-position-evaluations";
import { PositionGroupEvaluation } from "../evaluate-position";
import { getTopOptionCandidateForSymbol } from "../get-option-candidates-for-symbol";
import {
  getGroupMarketValue,
  inferOptionSide,
  normalizeInstrumentType,
  OrderPayload,
  roundOrderPrice,
} from "./order-utils";
import { ExecutionTargets } from "../evaluate-trading-strategy";
import { placeOrderSafely, SafeOrderResult } from "./place-order";

const DEFAULT_CONTRACT_MULTIPLIER = 100;

type AllocationRoute = "bid" | "mid" | "ask";

export interface AllocationRouteResult {
  estimatedOrderValue: number;
  limitPrice: number;
  orderResponse?: unknown;
  placedOrder: boolean;
  quantity: number;
  route: AllocationRoute;
  safeOrderResult?: SafeOrderResult;
  skippedReason?: string;
  weight: number;
}

export interface AllocationExecutionResult {
  accountNumber: string;
  action: "MANAGE_ALLOCATION";
  candidateQuoteSymbol?: string;
  candidateSymbol?: string;
  candidateDTE?: number;
  estimatedOrderValue?: number;
  maxDTE?: number;
  minDTE?: number;
  orderResponses?: unknown[];
  placedOrder: boolean;
  preferredDTE?: number;
  quantity?: number;
  routeOrders: AllocationRouteResult[];
  skippedReason?: string;
  underlyingSymbol: string;
  usedDteFallback?: boolean;
}

export interface AllocationBudget {
  buyingPowerRemaining: number;
  portfolioExposure: number;
  totalCapital: number;
}

interface ManageAllocationOptions {
  dryRun?: boolean;
}

function getCandidateSide(evaluation: PositionGroupEvaluation): "call" | "put" {
  const inferredSides = evaluation.positions
    .map((position) => inferOptionSide(position.orderSymbol ?? position.symbol))
    .filter((side): side is "call" | "put" => side != null);

  const enabledSides = getBotConfig().strategy.enabledSides;
  const inferred = inferredSides.find((side) => enabledSides.includes(side));
  return inferred ?? enabledSides[0] ?? "call";
}

function getMidpointPrice(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return ask || bid;
}

function buildRouteOrders(
  bid: number,
  ask: number,
  targets: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight">,
): AllocationRouteResult[] {
  const midpoint = getMidpointPrice(bid, ask);

  return [
    {
      estimatedOrderValue: 0,
      limitPrice: bid > 0 ? bid : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "bid" as const,
      weight: targets.bidWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: midpoint,
      placedOrder: false,
      quantity: 0,
      route: "mid" as const,
      weight: targets.midWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: ask > 0 ? ask : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "ask" as const,
      weight: targets.askWeight,
    },
  ].filter((routeOrder) => routeOrder.weight > 0 && routeOrder.limitPrice > 0);
}

function allocateContractsByWeight(
  routeOrders: AllocationRouteResult[],
  availableCapital: number,
): AllocationRouteResult[] {
  const totalWeight = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.weight,
    0,
  );

  if (totalWeight <= 0 || availableCapital <= 0) {
    return routeOrders;
  }

  const targets = routeOrders.map((routeOrder) => ({
    contractCost: routeOrder.limitPrice * DEFAULT_CONTRACT_MULTIPLIER,
    routeOrder,
    targetSpend: availableCapital * (routeOrder.weight / totalWeight),
  }));

  for (const target of targets) {
    if (target.contractCost <= 0) {
      continue;
    }

    target.routeOrder.quantity = Math.floor(
      target.targetSpend / target.contractCost,
    );
    target.routeOrder.estimatedOrderValue =
      target.routeOrder.quantity * target.contractCost;
  }

  let remainingCapital =
    availableCapital -
    targets.reduce(
      (sum, target) => sum + target.routeOrder.estimatedOrderValue,
      0,
    );

  let iterationCount = 0;
  while (remainingCapital > 0 && iterationCount < 100) {
    iterationCount += 1;

    const affordableTargets = targets.filter(
      (target) => target.contractCost > 0 && target.contractCost <= remainingCapital,
    );
    if (affordableTargets.length === 0) {
      break;
    }

    affordableTargets.sort((left, right) => {
      const leftShortfall = left.targetSpend - left.routeOrder.estimatedOrderValue;
      const rightShortfall =
        right.targetSpend - right.routeOrder.estimatedOrderValue;

      if (rightShortfall !== leftShortfall) {
        return rightShortfall - leftShortfall;
      }

      return left.contractCost - right.contractCost;
    });

    const nextTarget = affordableTargets[0];
    nextTarget.routeOrder.quantity += 1;
    nextTarget.routeOrder.estimatedOrderValue += nextTarget.contractCost;
    remainingCapital -= nextTarget.contractCost;
  }

  return routeOrders;
}

async function placeRouteOrders(
  accountNumber: string,
  candidateOrderSymbol: string,
  routeOrders: AllocationRouteResult[],
): Promise<AllocationRouteResult[]> {
  const placedOrders: AllocationRouteResult[] = [];

  for (const routeOrder of routeOrders) {
    if (routeOrder.quantity <= 0) {
      placedOrders.push({
        ...routeOrder,
        skippedReason: "allocated quantity rounded to zero",
      });
      continue;
    }

    const order: OrderPayload = {
      source: "tastytrade-playground",
      "time-in-force": "Day",
      "order-type": "Limit",
      price: roundOrderPrice(routeOrder.limitPrice),
      "price-effect": "Debit",
      legs: [
        {
          action: "Buy to Open",
          symbol: candidateOrderSymbol,
          quantity: routeOrder.quantity,
          "instrument-type": normalizeInstrumentType("Equity Option"),
        },
      ],
    };

    const safeOrderResult = await placeOrderSafely(accountNumber, order);

    placedOrders.push({
      ...routeOrder,
      orderResponse: safeOrderResult.orderResponse,
      placedOrder: safeOrderResult.submitted,
      safeOrderResult,
      skippedReason: safeOrderResult.skippedReason,
    });
  }

  return placedOrders;
}

export async function manageAllocationForGroup(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  budget: AllocationBudget,
  groupsRemainingForAllocation = 1,
  options: ManageAllocationOptions = {},
): Promise<AllocationExecutionResult> {
  const targets = evaluation.executionTargets;
  const botConfig = getBotConfig();

  if (!targets) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "execution targets missing",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  if (
    !botConfig.strategy.allowAddingToLosingPositions &&
    evaluation.currentReturn <= botConfig.strategy.maxLossForNewAllocationPct
  ) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: `not adding to losing position at ${(evaluation.currentReturn * 100).toFixed(2)}%`,
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const targetExposure = budget.totalCapital * targets.targetAccountExposure;
  const exposureHeadroom = targetExposure - budget.portfolioExposure;
  const normalizedGroupsRemaining = Math.max(1, groupsRemainingForAllocation);
  const perGroupExposureHeadroom = exposureHeadroom / normalizedGroupsRemaining;

  if (targets.targetAccountExposure <= 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "target exposure is zero",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  if (exposureHeadroom <= 0 || budget.buyingPowerRemaining <= 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      placedOrder: false,
      routeOrders: [],
      skippedReason: "no remaining exposure or buying power",
      underlyingSymbol: evaluation.underlyingSymbol,
    };
  }

  const optionSide = getCandidateSide(evaluation);
  const candidate = await getTopOptionCandidateForSymbol(
    evaluation.underlyingSymbol,
    optionSide,
    targets.targetDTE,
  );

  console.log(
    JSON.stringify({
      scope: "manage-allocation-candidate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: targets.targetDTE,
      candidateDTE: candidate?.dte,
      minDTE: candidate?.minDTE,
      maxDTE: candidate?.maxDTE,
      preferredDTE: candidate?.preferredDTE,
      usedDteFallback: candidate?.usedDteFallback ?? false,
      orderSymbol: candidate?.orderSymbol ?? candidate?.symbol ?? null,
      quoteSymbol: candidate?.quoteSymbol ?? null,
      dayVolume: candidate?.dayVolume ?? null,
      openInterest: candidate?.openInterest ?? null,
    }),
  );

  if (!candidate?.orderSymbol && !candidate?.symbol) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate?.dte,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      routeOrders: [],
      skippedReason: "no option candidate found",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  if (candidate.meetsLiquidityRequirement === false) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate.dte,
      candidateQuoteSymbol: candidate.quoteSymbol,
      candidateSymbol: candidate.orderSymbol ?? candidate.symbol,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders: [],
      skippedReason: "candidate failed liquidity gate",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const candidateOrderSymbol = candidate.orderSymbol ?? candidate.symbol;
  const candidateQuoteSymbol =
    candidate.quoteSymbol ?? candidate.streamerSymbol ?? candidateOrderSymbol;

  if (!candidateOrderSymbol || !candidateQuoteSymbol) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate.dte,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders: [],
      skippedReason: "candidate order or quote symbol unavailable",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const bidAsk = await getBidAskForSymbol(candidateQuoteSymbol, 3000);
  const bid = bidAsk?.bid ?? 0;
  const ask = bidAsk?.ask ?? bid;
  const availableCapital = Math.min(
    Math.max(0, perGroupExposureHeadroom),
    budget.buyingPowerRemaining,
  );
  const routeOrders = allocateContractsByWeight(
    buildRouteOrders(bid, ask, targets),
    availableCapital,
  );

  if (routeOrders.length === 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate.dte,
      candidateQuoteSymbol,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders: [],
      skippedReason: "candidate quote unavailable",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const totalQuantity = routeOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  if (totalQuantity < 1) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateQuoteSymbol,
      candidateSymbol: candidateOrderSymbol,
      candidateDTE: candidate.dte,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      routeOrders,
      skippedReason: "insufficient budget for one contract",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  if (options.dryRun) {
    const estimatedOrderValue = routeOrders.reduce(
      (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
      0,
    );

    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateQuoteSymbol,
      candidateSymbol: candidateOrderSymbol,
      candidateDTE: candidate.dte,
      estimatedOrderValue,
      maxDTE: candidate.maxDTE,
      minDTE: candidate.minDTE,
      placedOrder: false,
      preferredDTE: candidate.preferredDTE,
      quantity: totalQuantity,
      routeOrders,
      skippedReason: "dry-run plan",
      underlyingSymbol: evaluation.underlyingSymbol,
      usedDteFallback: candidate.usedDteFallback,
    };
  }

  const placedRouteOrders = await placeRouteOrders(
    accountNumber,
    candidateOrderSymbol,
    routeOrders,
  );
  const estimatedOrderValue = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
    0,
  );
  const quantity = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  return {
    accountNumber,
    action: "MANAGE_ALLOCATION",
    candidateQuoteSymbol,
    candidateSymbol: candidateOrderSymbol,
    candidateDTE: candidate.dte,
    estimatedOrderValue,
    maxDTE: candidate.maxDTE,
    minDTE: candidate.minDTE,
    orderResponses: placedRouteOrders
      .filter((routeOrder) => routeOrder.orderResponse != null)
      .map((routeOrder) => routeOrder.orderResponse),
    placedOrder: placedRouteOrders.some((routeOrder) => routeOrder.placedOrder),
    preferredDTE: candidate.preferredDTE,
    quantity,
    routeOrders: placedRouteOrders,
    underlyingSymbol: evaluation.underlyingSymbol,
    usedDteFallback: candidate.usedDteFallback,
  };
}

export function getUpdatedBudgetAfterAllocation(
  budget: AllocationBudget,
  evaluation: PositionGroupEvaluation,
  executionResult: AllocationExecutionResult,
): AllocationBudget {
  if (!executionResult.placedOrder || !executionResult.estimatedOrderValue) {
    return budget;
  }

  return {
    buyingPowerRemaining: Math.max(
      0,
      budget.buyingPowerRemaining - executionResult.estimatedOrderValue,
    ),
    portfolioExposure:
      budget.portfolioExposure + executionResult.estimatedOrderValue,
    totalCapital: budget.totalCapital,
  };
}

export function buildInitialBudget(
  buyingPower: number,
  totalCapital: number,
  evaluations: PositionGroupEvaluation[],
): AllocationBudget {
  return {
    buyingPowerRemaining: buyingPower,
    portfolioExposure: evaluations.reduce(
      (sum, evaluation) => sum + getGroupMarketValue(evaluation.positionSnapshots),
      0,
    ),
    totalCapital,
  };
}

export async function getCurrentAllocationBudget(
  accountNumber: string,
): Promise<AllocationBudget> {
  const [accountBalance, evaluations] = await Promise.all([
    fetchNormalizedAccountBalance(accountNumber),
    getPositionEvaluations(accountNumber),
  ]);

  return buildInitialBudget(
    getAccountBalanceNumber(
      accountBalance,
      "derivative_buying_power",
      "derivative-buying-power",
    ),
    getEffectiveTotalCapital(accountBalance),
    evaluations,
  );
}
