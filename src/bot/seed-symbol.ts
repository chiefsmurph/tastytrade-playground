import { getBidAskForSymbol } from "../core/market-data";
import tastytradeApi from "../core/tastytrade-client";
import { CurrentPosition } from "../core/types";
import {
  fetchNormalizedAccountBalance,
  getAccountBalanceNumber,
} from "../core/account-balance";
import { safeJson } from "../core/logging";
import { normalizePositions } from "../core/normalize";
import { withLiveTradingLock } from "../core/run-lock";
import { getUnderlyingSymbolForPosition } from "./evaluate-position";
import { getTopOptionCandidateForSymbol } from "./get-option-candidates-for-symbol";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "./evaluate-trading-strategy";
import { placeOrderSafely } from "./actions/place-order";

const DEFAULT_CONTRACT_MULTIPLIER = 100;

export interface SeedSymbolResult {
  accountNumber: string;
  askPrice?: number;
  buyingPowerAvailable?: number;
  candidateSymbol?: string;
  dte?: number;
  dryRunResponse?: unknown;
  estimatedOrderCost?: number;
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
  quoteSymbol?: string;
  orderResponse?: unknown;
  placedOrder: boolean;
  side: "call" | "put";
  skippedReason?: string;
  strategy?: ProgrammaticAction | null;
  symbol: string;
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

async function hasOpenUnderlyingPosition(
  accountNumber: string,
  symbol: string,
): Promise<boolean> {
  const rawPositions =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
    );
  const currentPositions: CurrentPosition[] = normalizePositions(
    Array.isArray(rawPositions) ? rawPositions : [],
  );

  return currentPositions.some((position) => {
    const quantity = Number(position.quantity) || 0;
    if (quantity === 0) {
      return false;
    }

    return getUnderlyingSymbolForPosition(position).toUpperCase() === symbol.toUpperCase();
  });
}

export async function seedSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<SeedSymbolResult> {
  return withLiveTradingLock("seedSymbol", () =>
    seedSymbolUnlocked(symbol, side, accountNumber),
  );
}

async function seedSymbolUnlocked(
  symbol: string,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<SeedSymbolResult> {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const normalizedSymbol = symbol.toUpperCase();

  if (await hasOpenUnderlyingPosition(resolvedAccountNumber, normalizedSymbol)) {
    return {
      accountNumber: resolvedAccountNumber,
      placedOrder: false,
      side,
      skippedReason: "underlying already has an open position",
      symbol: normalizedSymbol,
    };
  }

  const candidate = await getTopOptionCandidateForSymbol(symbol, side);
  const strategy = candidate?.strategy;

  console.log(
    safeJson({
      scope: "seed-symbol-candidate",
      symbol: normalizedSymbol,
      side,
      resolvedAccountNumber,
      strategy,
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
  if (
    !strategy ||
    strategy !== "MANAGE_ALLOCATION"
  ) {
    return {
      accountNumber: resolvedAccountNumber,
      maxDTE: candidate?.maxDTE,
      minDTE: candidate?.minDTE,
      placedOrder: false,
      preferredDTE: candidate?.preferredDTE,
      side,
      skippedReason: "time-of-day strategy is not allowing new accumulation",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback: candidate?.usedDteFallback,
    };
  }

  const minDTE = candidate?.minDTE;
  const maxDTE = candidate?.maxDTE;
  const preferredDTE = candidate?.preferredDTE;
  const usedDteFallback = candidate?.usedDteFallback;

  const candidateSymbol =
    candidate?.orderSymbol ??
    (side === "put" ? candidate?.put : candidate?.call ?? candidate?.symbol);
  const quoteSymbol =
    candidate?.quoteSymbol ??
    (side === "put"
      ? candidate?.["put-streamer-symbol"] ?? candidateSymbol
      : candidate?.["call-streamer-symbol"] ??
        candidate?.streamerSymbol ??
        candidateSymbol);

  if (!candidateSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      side,
      skippedReason: "no option candidate found",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  if (!quoteSymbol) {
    return {
      accountNumber: resolvedAccountNumber,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      side,
      skippedReason: "candidate quote symbol unavailable",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const bidAsk = await getBidAskForSymbol(quoteSymbol, 3000);
  const askPrice = bidAsk?.ask ?? bidAsk?.bid;

  if (!(askPrice && askPrice > 0)) {
    console.warn(
      `No valid ask or bid price for quote symbol ${quoteSymbol}, skipping seed order. BidAsk:`,
      bidAsk,
    );
    return {
      accountNumber: resolvedAccountNumber,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      maxDTE,
      minDTE,
      preferredDTE,
      quoteSymbol,
      placedOrder: false,
      side,
      skippedReason: "candidate ask quote unavailable",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const limitPrice = roundOrderPrice(askPrice);
  const numericLimitPrice = Number(limitPrice);

  const order: OrderPayload = {
    source: "tastytrade-playground",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: limitPrice,
    "price-effect": "Debit",
    legs: [
      {
        action: "Buy to Open",
        symbol: candidateSymbol,
        quantity: 1,
        "instrument-type": normalizeInstrumentType("Equity Option"),
      },
    ],
  };

  const accountBalance = await fetchNormalizedAccountBalance(resolvedAccountNumber);
  const buyingPowerAvailable = getAccountBalanceNumber(
    accountBalance,
    "derivative_buying_power",
    "derivative-buying-power",
  );
  const estimatedOrderCost = numericLimitPrice * DEFAULT_CONTRACT_MULTIPLIER;

  if (estimatedOrderCost > buyingPowerAvailable) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      estimatedOrderCost,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: "insufficient derivative buying power for seed order",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const safeOrderResult = await placeOrderSafely(resolvedAccountNumber, order);

  return {
    accountNumber: resolvedAccountNumber,
    askPrice,
    buyingPowerAvailable,
    candidateSymbol,
    dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
    dryRunResponse: safeOrderResult.dryRunResponse,
    estimatedOrderCost,
    maxDTE,
    minDTE,
    preferredDTE,
    quoteSymbol,
    orderResponse: safeOrderResult.orderResponse,
    placedOrder: safeOrderResult.submitted,
    side,
    skippedReason: safeOrderResult.skippedReason,
    strategy,
    symbol: normalizedSymbol,
    usedDteFallback,
  };
}

export default seedSymbol;
