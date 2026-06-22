import tastytradeApi from "~/core/tastytrade-client";
import { CurrentPosition } from "~/core/types";
import { getAccountBalanceNumber } from "~/core/account-balance";
import { getUnderlyingSymbolForPosition } from "./evaluate-position";
import { getTopOptionCandidateForSymbol } from "./get-option-candidates-for-symbol";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "./evaluate-trading-strategy";
import type { PlacedOrderResponse } from "~/core/types";

const DEFAULT_CONTRACT_MULTIPLIER = 100;

export interface SeedSymbolResult {
  accountNumber: string;
  askPrice?: number;
  buyingPowerAvailable?: number;
  candidateSymbol?: string;
  dte?: number;
  dryRunResponse?: PlacedOrderResponse | unknown;
  estimatedOrderCost?: number;
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
  quoteSymbol?: string;
  orderResponse?: PlacedOrderResponse;
  placedOrder: boolean;
  side: "call" | "put";
  skippedReason?: string;
  strategy?: ProgrammaticAction | null;
  symbol: string;
  usedDteFallback?: boolean;
}

function extractDryRunSkipReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "seed order dry run failed";
  }

  const maybeResponse = error as Error & {
    response?: {
      data?: {
        error?: { message?: string };
        message?: string;
      };
    };
  };

  const brokerMessage =
    maybeResponse.response?.data?.error?.message ??
    maybeResponse.response?.data?.message;

  return brokerMessage || error.message || "seed order dry run failed";
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
  const currentPositions: CurrentPosition[] =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
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
    JSON.stringify(
      {
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
        candidateSymbol: candidate?.symbol ?? candidate?.call ?? candidate?.put ?? null,
      },
      null,
      2,
    ),
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
    side === "put"
      ? candidate?.put
      : candidate?.call ?? candidate?.symbol;
  const quoteSymbol =
    side === "put"
      ? candidate?.["put-streamer-symbol"] ?? candidateSymbol
      : candidate?.["call-streamer-symbol"] ??
        candidate?.streamerSymbol ??
        candidateSymbol;

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

  const bidAsk = await tastytradeApi.johnsService.getBidAskForSymbol(
    quoteSymbol,
    3000,
  );
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

  const accountBalance =
    await tastytradeApi.balancesAndPositionsService.getAccountBalanceValues(
      resolvedAccountNumber,
    );
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

  let dryRunResponse: PlacedOrderResponse;
  try {
    dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
      resolvedAccountNumber,
      order,
    );
  } catch (error) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      dryRunResponse:
        error instanceof Error
          ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
          : error,
      estimatedOrderCost,
      maxDTE,
      minDTE,
      placedOrder: false,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: extractDryRunSkipReason(error),
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const orderResponse = await tastytradeApi.orderService.createOrder(
    resolvedAccountNumber,
    order,
  );

  return {
    accountNumber: resolvedAccountNumber,
    askPrice,
    buyingPowerAvailable,
    candidateSymbol,
    dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
    dryRunResponse,
    estimatedOrderCost,
    maxDTE,
    minDTE,
    preferredDTE,
    quoteSymbol,
    orderResponse,
    placedOrder: true,
    side,
    strategy,
    symbol: normalizedSymbol,
    usedDteFallback,
  };
}

export default seedSymbol;