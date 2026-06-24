import tastytradeApi from "~/core/tastytrade-client";
import { getDefaultAccountNumber, getMarginAccountNumber } from "~/core/default-account";
import { CurrentPosition } from "~/core/types";
import { getUnderlyingSymbolForPosition } from "./evaluate-position";
import { getTopOptionCandidateForSymbol } from "./get-option-candidates-for-symbol";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";
import { ProgrammaticAction } from "./evaluate-trading-strategy";
import type { TastytradePlacedOrderResponse } from "~/core/types";
import { getEffectiveBuyingPowerSummary } from "./effective-buying-power";
import {
  BOT_ORDER_SOURCE,
  SECRET_AUTO_SEED_ORDER_SOURCE,
} from "./order-sources";

const DEFAULT_CONTRACT_MULTIPLIER = 100;
const DEFAULT_MAX_SEED_ORDER_COST = 500;

export interface SeedSymbolOptions {
  priceMode?: "ask" | "mid";
  orderSource?: string;
}

export interface SeedSymbolResult {
  accountNumber: string;
  askPrice?: number;
  bidPrice?: number;
  buyingPowerAvailable?: number;
  candidateSymbol?: string;
  dte?: number;
  dryRunResponse?: TastytradePlacedOrderResponse | unknown;
  estimatedOrderCost?: number;
  limitPrice?: number;
  maxDTE?: number;
  midPrice?: number;
  minDTE?: number;
  priceMode?: "ask" | "mid";
  preferredDTE?: number;
  quoteSymbol?: string;
  orderResponse?: TastytradePlacedOrderResponse;
  placedOrder: boolean;
  side: "call" | "put";
  skippedReason?: string;
  strategy?: ProgrammaticAction | null;
  symbol: string;
  usedDteFallback?: boolean;
}

function getMaxSeedOrderCost(): number {
  const raw = process.env.BOT_MAX_SEED_ORDER_COST;
  if (!raw) {
    return DEFAULT_MAX_SEED_ORDER_COST;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SEED_ORDER_COST;
  }

  return parsed;
}

function shouldSeedOnlyToMarginAccounts(): boolean {
  const raw = process.env.BOT_SEED_ONLY_TO_MARGIN_ACCOUNTS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
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
  options: SeedSymbolOptions = {},
): Promise<SeedSymbolResult> {
  const requestedAccountNumber = accountNumber?.trim();
  const resolvedAccountNumber = shouldSeedOnlyToMarginAccounts()
    ? await getMarginAccountNumber()
    : requestedAccountNumber ?? (await getDefaultAccountNumber());
  const normalizedSymbol = symbol.toUpperCase();
  const priceMode = options.priceMode === "mid" ? "mid" : "ask";
  const orderSource = options.orderSource?.trim() || BOT_ORDER_SOURCE;

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
        requestedAccountNumber: requestedAccountNumber ?? null,
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
  const bidPrice = bidAsk?.bid ?? 0;
  const askPrice = bidAsk?.ask ?? bidPrice;
  const midPrice =
    bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : askPrice || bidPrice;
  const selectedPrice = priceMode === "mid" ? midPrice : askPrice;

  if (!(selectedPrice && selectedPrice > 0)) {
    console.warn(
      `No valid ${priceMode} or fallback quote for ${quoteSymbol}, skipping seed order. BidAsk:`,
      bidAsk,
    );
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      midPrice,
      maxDTE,
      minDTE,
      preferredDTE,
      priceMode,
      quoteSymbol,
      placedOrder: false,
      side,
      skippedReason: `candidate ${priceMode} quote unavailable`,
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  const limitPrice = roundOrderPrice(selectedPrice);
  const numericLimitPrice = Number(limitPrice);

  const order: OrderPayload = {
    source: orderSource,
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

  const buyingPowerSummary = await getEffectiveBuyingPowerSummary(
    resolvedAccountNumber,
  );
  const buyingPowerAvailable = buyingPowerSummary.effectiveBuyingPower;
  const estimatedOrderCost = numericLimitPrice * DEFAULT_CONTRACT_MULTIPLIER;
  const maxSeedOrderCost = getMaxSeedOrderCost();

  if (estimatedOrderCost > maxSeedOrderCost) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason: `seed order cost ${estimatedOrderCost.toFixed(2)} exceeds BOT_MAX_SEED_ORDER_COST ${maxSeedOrderCost.toFixed(2)}`,
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  if (estimatedOrderCost > buyingPowerAvailable) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
      preferredDTE,
      quoteSymbol,
      side,
      skippedReason:
        "insufficient effective buying power for seed order at current time-of-day exposure target",
      strategy,
      symbol: normalizedSymbol,
      usedDteFallback,
    };
  }

  let dryRunResponse: TastytradePlacedOrderResponse;
  try {
    dryRunResponse = await tastytradeApi.orderService.postOrderDryRun(
      resolvedAccountNumber,
      order,
    );
  } catch (error) {
    return {
      accountNumber: resolvedAccountNumber,
      askPrice,
      bidPrice,
      buyingPowerAvailable,
      candidateSymbol,
      dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
      dryRunResponse:
        error instanceof Error
          ? ((error as Error & { response?: { data?: unknown } }).response?.data ?? error.message)
          : error,
      estimatedOrderCost,
      limitPrice: numericLimitPrice,
      maxDTE,
      midPrice,
      minDTE,
      placedOrder: false,
      priceMode,
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
    bidPrice,
    buyingPowerAvailable,
    candidateSymbol,
    dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
    dryRunResponse,
    estimatedOrderCost,
    limitPrice: numericLimitPrice,
    maxDTE,
    midPrice,
    minDTE,
    priceMode,
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