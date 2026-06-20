import { getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainsWithVolume } from "../core/option-service";
import { OptionChain, OptionChainWithVolumes } from "../core/types";

const MIN_DTE = 28; // 4 weeks
const MAX_DTE = 42; // 6 weeks
const STRIKES_AROUND_ATM = 2;
const MIN_VOLUME = 120;

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export async function getOptionCandidates(
  symbol: string,
  side: "call" | "put" = "call",
): Promise<ReturnType<typeof chooseOptionCandidates>> {
  const optionChains = await fetchOptionChainsWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = optionChains
    .map((chain) =>
      chooseOptionCandidates(chain, underlyingPrice?.underlyingPrice || 0),
    )
    .flat()
    .map(candidate => ({
      ...candidate,
      meetsVolumeRequirement: (candidate[`${side}Volume`] || 0) >= MIN_VOLUME,
    }));
  return optionCandidates;
}

export function chooseOptionCandidates(
  optionChain: OptionChainWithVolumes,
  underlyingPrice: number,
) {
  const expirations = optionChain.expirations
    .filter((exp) => {
      const dte = num(exp["days-to-expiration"]);
      return dte >= MIN_DTE && dte <= MAX_DTE;
    })
    .sort((a, b) => {
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
      .map((strike) => ({
        expirationDate: exp["expiration-date"],
        expirationType: exp["expiration-type"],
        dte: num(exp["days-to-expiration"]),
        strike: num(strike["strike-price"]),
        symbol: strike.call,
        streamerSymbol: strike["call-streamer-symbol"],
        ...strike,
      }))
      .sort((a, b) => num(a["strike-price"]) - num(b["strike-price"]));

    // For a call, ITM means strike < underlying price.
    const itm = strikes.filter((s) => s.strike < underlyingPrice);

    if (!itm.length) continue;

    // Closest ITM to ATM = highest strike below current underlying price.
    const closestItmIndex = itm.length - 1;

    // Add closest ITM plus 1-2 deeper ITM strikes.
    for (
      let i = closestItmIndex;
      i >= Math.max(0, closestItmIndex - STRIKES_AROUND_ATM);
      i--
    ) {
      candidates.push(itm[i]);
    }
  }

  return candidates;
}
