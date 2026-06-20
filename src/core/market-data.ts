import tastytradeApi from "./tastytrade-client.js";

export async function getBidAskForSymbol(
  symbol: string,
  timeoutMs = 3000,
): Promise<{ bid?: number; ask?: number } | null> {
  try {
    await tastytradeApi.quoteStreamer.connect();

    const candidates = [symbol, `.${symbol}`, symbol.replace("/", ".")].filter(
      Boolean,
    );

    return await new Promise((resolve) => {
      const timer = setTimeout(() => cleanupAndResolve(null), timeoutMs);

      function cleanupAndResolve(result: any) {
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
          for (const ev of arr) {
            console.log("Received quote event:", ev);
            const evSym = ev.eventSymbol || ev.symbol || ev.ticker || ev[1];
            if (!evSym) continue;
            const norm = evSym.startsWith(".") ? evSym : `.${evSym}`;
            if (
              !candidates.includes(evSym) &&
              !candidates.includes(norm) &&
              !candidates.includes(evSym.replace(/^\./, ""))
            )
              continue;

            const toNum = (v: any) => (v == null ? NaN : Number(v));
            const bid = toNum(ev.bidPrice ?? ev.b ?? ev.bid);
            const ask = toNum(ev.askPrice ?? ev.a ?? ev.ask);

            if (!Number.isNaN(bid) || !Number.isNaN(ask)) {
              cleanupAndResolve({
                bid: Number.isFinite(bid) ? bid : undefined,
                ask: Number.isFinite(ask) ? ask : undefined,
              });
              return;
            }
          }
        },
      );

      try {
        tastytradeApi.quoteStreamer.subscribe(candidates);
      } catch (e) {
        cleanupAndResolve(null);
      }
    });
  } catch (err) {
    return null;
  }
}

export default { getBidAskForSymbol };
