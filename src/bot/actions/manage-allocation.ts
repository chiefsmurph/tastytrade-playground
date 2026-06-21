import {
  getAccountBalanceNumber,
  getEffectiveTotalCapital,
} from "../../core/account-balance";
import tastytradeApi from "../../core/tastytrade-client";
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

const DEFAULT_CONTRACT_MULTIPLIER = 100;

type AllocationRoute = "bid" | "mid" | "ask";

export interface AllocationRouteResult {
  estimatedOrderValue: number;
  limitPrice: number;
  orderResponse?: unknown;
  placedOrder: boolean;
  quantity: number;
  route: AllocationRoute;
  skippedReason?: string;
  weight: number;
}

export interface AllocationExecutionResult {
  accountNumber: string;
  action: "MANAGE_ALLOCATION";
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

function getCandidateSide(evaluation: PositionGroupEvaluation): "call" | "put" {
  const inferredSides = evaluation.positions
    .map((position) => inferOptionSide(position.symbol))
    .filter((side): side is "call" | "put" => side != null);

  return inferredSides[0] ?? "call";
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
  evaluation: PositionGroupEvaluation,
): AllocationRouteResult[] {
  const midpoint = getMidpointPrice(bid, ask);

  return [
    {
      estimatedOrderValue: 0,
      limitPrice: bid > 0 ? bid : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "bid" as const,
      weight: evaluation.strategy.bidWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: midpoint,
      placedOrder: false,
      quantity: 0,
      route: "mid" as const,
      weight: evaluation.strategy.midWeight,
    },
    {
      estimatedOrderValue: 0,
      limitPrice: ask > 0 ? ask : midpoint,
      placedOrder: false,
      quantity: 0,
      route: "ask" as const,
      weight: evaluation.strategy.askWeight,
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
  candidateSymbol: string,
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
          symbol: candidateSymbol,
          quantity: routeOrder.quantity,
          "instrument-type": normalizeInstrumentType("Equity Option"),
        },
      ],
    };

    const orderResponse = await tastytradeApi.orderService.createOrder(
      accountNumber,
      order,
    );

    placedOrders.push({
      ...routeOrder,
      orderResponse,
      placedOrder: true,
    });
  }

  return placedOrders;
}

export async function manageAllocationForGroup(
  accountNumber: string,
  evaluation: PositionGroupEvaluation,
  budget: AllocationBudget,
): Promise<AllocationExecutionResult> {
  const targetExposure = budget.totalCapital * evaluation.strategy.targetAccountExposure;
  const exposureHeadroom = targetExposure - budget.portfolioExposure;

  if (evaluation.strategy.targetAccountExposure <= 0) {
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
    evaluation.strategy.targetDTE,
  );

  console.log(
    JSON.stringify({
      scope: "manage-allocation-candidate",
      underlyingSymbol: evaluation.underlyingSymbol,
      requestedSide: optionSide,
      targetDTE: evaluation.strategy.targetDTE,
      candidateDTE: candidate?.dte,
      minDTE: candidate?.minDTE,
      maxDTE: candidate?.maxDTE,
      preferredDTE: candidate?.preferredDTE,
      usedDteFallback: candidate?.usedDteFallback ?? false,
      symbol: candidate?.symbol ?? null,
    }),
  );

  if (!candidate?.symbol) {
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

  const bidAsk = await getBidAskForSymbol(candidate.symbol, 3000);
  const bid = bidAsk?.bid ?? 0;
  const ask = bidAsk?.ask ?? bid;
  const availableCapital = Math.min(
    exposureHeadroom,
    budget.buyingPowerRemaining,
  );
  const routeOrders = allocateContractsByWeight(
    buildRouteOrders(bid, ask, evaluation),
    availableCapital,
  );

  if (routeOrders.length === 0) {
    return {
      accountNumber,
      action: "MANAGE_ALLOCATION",
      candidateDTE: candidate.dte,
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

  const placedRouteOrders = await placeRouteOrders(
    accountNumber,
    candidate.symbol,
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
    tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    ),
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