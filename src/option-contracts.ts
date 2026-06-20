const MIN_DTE = 28; // 4 weeks
const MAX_DTE = 42; // 6 weeks
const STRIKES_AROUND_ATM = 2;

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function chooseOptionCandidates(optionChain: any, underlyingPrice: number) {
  const expirations = optionChain.expirations
    .filter((exp: any) => {
      const dte = num(exp["days-to-expiration"]);
      return dte >= MIN_DTE && dte <= MAX_DTE;
    })
    .sort((a: any, b: any) => {
      // Prefer regular monthly expirations, then closer to 35 DTE
      const aRegular = a["expiration-type"] === "Regular" ? 0 : 1;
      const bRegular = b["expiration-type"] === "Regular" ? 0 : 1;

      if (aRegular !== bRegular) return aRegular - bRegular;

      return (
        Math.abs(num(a["days-to-expiration"]) - 35) -
        Math.abs(num(b["days-to-expiration"]) - 35)
      );
    });

  const candidates = [];

  for (const exp of expirations) {
    const strikes = exp.strikes
      .map((strike: any) => ({
        expirationDate: exp["expiration-date"],
        expirationType: exp["expiration-type"],
        dte: num(exp["days-to-expiration"]),
        strike: num(strike["strike-price"]),
        symbol: strike.call,
        streamerSymbol: strike["call-streamer-symbol"],
      }))
      .sort((a: any, b: any) => a.strike - b.strike);

    // For a call, ITM means strike < underlying price.
    const itm = strikes.filter((s: any) => s.strike < underlyingPrice);

    if (!itm.length) continue;

    // Closest ITM to ATM = highest strike below current underlying price.
    const closestItmIndex = itm.length - 1;

    // Add closest ITM plus 1-2 deeper ITM strikes.
    for (let i = closestItmIndex; i >= Math.max(0, closestItmIndex - STRIKES_AROUND_ATM); i--) {
      candidates.push(itm[i]);
    }
  }

  return candidates;
}