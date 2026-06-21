import { getBidAskForSymbol } from "../core/market-data";
import tastytradeApi from "../core/tastytrade-client";
import { getTopOptionCandidateForSymbol } from "./get-option-candidates-for-symbol";
import { normalizeInstrumentType, OrderPayload, roundOrderPrice } from "./actions/order-utils";

export interface SeedSymbolResult {
  accountNumber: string;
  askPrice?: number;
  candidateSymbol?: string;
  dte?: number;
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
  quoteSymbol?: string;
  orderResponse?: unknown;
  placedOrder: boolean;
  side: "call" | "put";
  skippedReason?: string;
  strategy?: ReturnType<typeof getTopOptionCandidateForSymbol extends (...args: any[]) => Promise<infer T> ? NonNullable<T> extends { strategy?: infer S } ? () => S : never : never>;
  symbol: string;
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

export async function seedSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  accountNumber?: string,
): Promise<SeedSymbolResult> {
  const resolvedAccountNumber = accountNumber ?? (await getDefaultAccountNumber());
  const candidate = await getTopOptionCandidateForSymbol(symbol, side);
  const strategy = candidate?.strategy;

  console.log(JSON.stringify({ symbol, side, resolvedAccountNumber, strategy }, null, 2));
  if (
    !strategy ||
    strategy.action !== "MANAGE_ALLOCATION" ||
    strategy.targetAccountExposure <= 0
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
      symbol,
    };
  }

  const minDTE = candidate?.minDTE;
  const maxDTE = candidate?.maxDTE;
  const preferredDTE = candidate?.preferredDTE;

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
      symbol,
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
      symbol,
    };
  }

  const bidAsk = await getBidAskForSymbol(quoteSymbol, 3000);
  const askPrice = bidAsk?.ask ?? bidAsk?.bid;

  if (!(askPrice && askPrice > 0)) {
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
      symbol,
    };
  }

  const order: OrderPayload = {
    source: "tastytrade-bot",
    "time-in-force": "Day",
    "order-type": "Limit",
    price: roundOrderPrice(askPrice),
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

  const orderResponse = await tastytradeApi.orderService.createOrder(
    resolvedAccountNumber,
    order,
  );

  return {
    accountNumber: resolvedAccountNumber,
    askPrice,
    candidateSymbol,
    dte: candidate?.dte != null ? Number(candidate.dte) : undefined,
    maxDTE,
    minDTE,
    preferredDTE,
    quoteSymbol,
    orderResponse,
    placedOrder: true,
    side,
    strategy,
    symbol,
  };
}

export default seedSymbol;