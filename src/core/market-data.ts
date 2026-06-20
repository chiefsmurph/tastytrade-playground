import tastytradeApi from "./tastytrade-client";

type QuoteEvent = Record<string, any>;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCandidates(symbol: string): string[] {
  return [symbol, `.${symbol}`, symbol.replace("/", ".")].filter(Boolean);
}

function isMatchingQuoteEvent(event: QuoteEvent, candidates: string[]): boolean {
  const eventSymbol = event.eventSymbol || event.symbol || event.ticker || event[1];
  if (!eventSymbol) return false;

  const normalized = eventSymbol.startsWith(".") ? eventSymbol : `.${eventSymbol}`;
  return (
    candidates.includes(eventSymbol) ||
    candidates.includes(normalized) ||
    candidates.includes(eventSymbol.replace(/^\./, ""))
  );
}

function extractBidAsk(event: QuoteEvent) {
  const bid = toNumber(event.bidPrice ?? event.b ?? event.bid);
  const ask = toNumber(event.askPrice ?? event.a ?? event.ask);
  return {
    bid: bid ?? undefined,
    ask: ask ?? undefined,
  };
}

function extractUnderlyingPrice(event: QuoteEvent): { underlyingPrice?: number; source?: string } | null {
  const sources: Array<[string, unknown]> = [
    ["underlyingPrice", event.underlyingPrice],
    ["underlying-price", event["underlying-price"]],
    ["price", event.price],
    ["lastPrice", event.lastPrice],
    ["last", event.last],
    ["markPrice", event.markPrice],
    ["mark", event.mark],
    ["tradePrice", event.tradePrice],
    ["close", event.close],
  ];

  for (const [source, value] of sources) {
    const parsed = toNumber(value);
    if (parsed != null) {
      return { underlyingPrice: parsed, source };
    }
  }

  const { bid, ask } = extractBidAsk(event);
  if (bid != null && ask != null) {
    return {
      underlyingPrice: (bid + ask) / 2,
      source: "midpoint",
    };
  }

  if (bid != null) {
    return { underlyingPrice: bid, source: "bid" };
  }

  if (ask != null) {
    return { underlyingPrice: ask, source: "ask" };
  }

  return null;
}

async function withQuoteSubscription<T>(
  symbol: string,
  timeoutMs: number,
  onEvent: (event: QuoteEvent, resolve: (value: T | null) => void) => void,
): Promise<T | null> {
  await tastytradeApi.quoteStreamer.connect();

  const candidates = normalizeCandidates(symbol);

  return await new Promise((resolve) => {
    const timer = setTimeout(() => cleanupAndResolve(null), timeoutMs);

    function cleanupAndResolve(result: T | null) {
      try {
        tastytradeApi.quoteStreamer.unsubscribe(candidates);
      } catch {}
      try {
        removeListener();
      } catch {}
      clearTimeout(timer);
      resolve(result);
    }

    const removeListener = tastytradeApi.quoteStreamer.addEventListener(
      (events: any[]) => {
        const arr = Array.isArray(events) ? events : [events];
        for (const event of arr) {
          console.log("Received quote event:", event);
          if (!isMatchingQuoteEvent(event, candidates)) {
            continue;
          }

          onEvent(event, cleanupAndResolve);
        }
      },
    );

    try {
      tastytradeApi.quoteStreamer.subscribe(candidates);
    } catch {
      cleanupAndResolve(null);
    }
  });
}

export async function getBidAskForSymbol(
  symbol: string,
  timeoutMs = 3000,
): Promise<{ bid?: number; ask?: number } | null> {
  try {
    return await withQuoteSubscription(symbol, timeoutMs, (event, resolve) => {
      const { bid, ask } = extractBidAsk(event);
      if (bid != null || ask != null) {
        resolve({ bid, ask });
      }
    });
  } catch (err) {
    return null;
  }
}

export async function getUnderlyingPrice(
  symbol: string,
  timeoutMs = 3000,
): Promise<{ underlyingPrice?: number; source?: string } | null> {
  try {
    return await withQuoteSubscription(symbol, timeoutMs, (event, resolve) => {
      const extracted = extractUnderlyingPrice(event);
      if (extracted) {
        resolve(extracted);
      }
    });
  } catch {
    return null;
  }
}

export default { getBidAskForSymbol, getUnderlyingPrice };
