import { getAccountBalanceNumber } from "~/core/account-balance";
import { getBidAskForSymbol } from "~/core/market-data";
import tastytradeApi from "~/core/tastytrade-client";
import { getTopOptionCandidateForSymbol } from "./get-option-candidates-for-symbol";
import {
  allocateContractsByWeight,
  AllocationRouteResult,
  buildRouteOrders,
  placeRouteOrders,
} from "./actions/manage-allocation";
import { ExecutionTargets } from "./evaluate-trading-strategy";

const EQUAL_ROUTE_TARGETS: Pick<ExecutionTargets, "bidWeight" | "midWeight" | "askWeight"> = {
  askWeight: 0.33,
  bidWeight: 0.33,
  midWeight: 0.33,
};

export type PurchaseSymbolRouteOrder = AllocationRouteResult;

export interface PurchaseSymbolResult {
  accountNumber: string;
  candidateDTE?: number;
  candidateSymbol?: string;
  effectiveBudget: number;
  maxDTE?: number;
  minDTE?: number;
  placedOrder: boolean;
  preferredDTE?: number;
  quoteSymbol?: string;
  requestedBudget: number;
  routeOrders: AllocationRouteResult[];
  side: "call" | "put";
  skippedReason?: string;
  symbol: string;
  totalEstimatedOrderValue: number;
  totalQuantity: number;
  usedDteFallback?: boolean;
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

async function getDerivativeBuyingPower(accountNumber: string): Promise<number> {
  const accountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      accountNumber,
    );

  return getAccountBalanceNumber(
    accountBalance,
    "derivative_buying_power",
    "derivative-buying-power",
  );
}

export async function purchaseSymbol(
  symbol: string,
  requestedBudget: number,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<PurchaseSymbolResult> {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const normalizedSymbol = symbol.toUpperCase();

  if (!(requestedBudget > 0)) {
    throw new Error("requestedBudget must be greater than 0");
  }

  const candidate = await getTopOptionCandidateForSymbol(normalizedSymbol, side);
  const candidateSymbol =
    side === "put"
      ? candidate?.put ?? candidate?.symbol
      : candidate?.call ?? candidate?.symbol;
  const quoteSymbol =
    side === "put"
      ? candidate?.["put-streamer-symbol"] ?? candidateSymbol
      : candidate?.["call-streamer-symbol"] ?? candidate?.streamerSymbol ?? candidateSymbol;

  if (!candidateSymbol || !quoteSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget: 0,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: "no option candidate found",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const bidAsk = await getBidAskForSymbol(quoteSymbol, 3000);
  const bid = bidAsk?.bid ?? 0;
  const ask = bidAsk?.ask ?? bid;

  if (!(bid > 0 || ask > 0)) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget: 0,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: "candidate quote unavailable",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const buyingPowerAvailable = await getDerivativeBuyingPower(resolvedAccountNumber);
  const effectiveBudget = Math.min(requestedBudget, Math.max(0, buyingPowerAvailable));

  if (effectiveBudget <= 0) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: [],
      side,
      skippedReason: "insufficient derivative buying power",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const plannedRouteOrders = allocateContractsByWeight(
    buildRouteOrders(bid, ask, EQUAL_ROUTE_TARGETS),
    effectiveBudget,
  );
  const totalPlannedQuantity = plannedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  if (totalPlannedQuantity < 1) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateDTE: candidate?.dte,
      candidateSymbol,
      effectiveBudget,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      quoteSymbol,
      requestedBudget,
      routeOrders: plannedRouteOrders,
      side,
      skippedReason: "insufficient budget for one contract",
      symbol: normalizedSymbol,
      totalEstimatedOrderValue: 0,
      totalQuantity: 0,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const placedRouteOrders = await placeRouteOrders(
    resolvedAccountNumber,
    candidateSymbol,
    plannedRouteOrders,
  );
  const totalEstimatedOrderValue = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.estimatedOrderValue,
    0,
  );
  const totalQuantity = placedRouteOrders.reduce(
    (sum, routeOrder) => sum + routeOrder.quantity,
    0,
  );

  return {
    accountNumber: resolvedAccountNumber,
    candidateDTE: candidate?.dte,
    candidateSymbol,
    effectiveBudget,
    maxDTE: candidate?.maxDTE,
    minDTE: candidate?.minDTE,
    placedOrder: placedRouteOrders.some((routeOrder) => routeOrder.placedOrder),
    preferredDTE: candidate?.preferredDTE,
    quoteSymbol,
    requestedBudget,
    routeOrders: placedRouteOrders,
    side,
    symbol: normalizedSymbol,
    totalEstimatedOrderValue,
    totalQuantity,
    usedDteFallback: candidate?.usedDteFallback,
  };
}

export default purchaseSymbol;
