import { getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainWithVolume } from "../core/option-service";
import { OptionChain, OptionChainWithVolumes } from "../core/types";

const MIN_DTE = 28; // 4 weeks
const MAX_DTE = 42; // 6 weeks
const STRIKES_AROUND_ATM = 2;
const MIN_VOLUME = 120;

export interface OptionCandidateSelectionOptions {
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export async function getOptionCandidates(
  symbol: string,
  side: "call" | "put" = "call",
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<ReturnType<typeof chooseOptionCandidates>> {
  const optionChain = await fetchOptionChainWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
    selectionOptions,
  ).map((candidate) => ({
    ...candidate,
    meetsVolumeRequirement: (candidate[`${side}Volume`] || 0) >= MIN_VOLUME,
  }));
  if (optionCandidates.length === 0) {
    console.log("No option candidates found for", symbol);
    const fallbackOptionChainsByVolume = sortOptionChainByVolume(
      optionChain,
      side,
    );
    console.log(
      "Option chains sorted by volume:",
      JSON.stringify(fallbackOptionChainsByVolume, null, 2),
    );
  }
  return optionCandidates;
}

export function sortOptionChainByVolume(
  optionChain: OptionChainWithVolumes,
  side: "call" | "put" = "call",
) {
  const sorted = optionChain.expirations
    .map(({ strikes, ...expiration }) =>
      strikes.map((strike) => ({
        ...expiration,
        ...strike,
        meetsVolumeRequirement: (strike[`${side}Volume`] || 0) >= MIN_VOLUME,
      })),
    )
    .flat()
    .sort((a, b) => (b[`${side}Volume`] || 0) - (a[`${side}Volume`] || 0));
  return sorted;
}

export function chooseOptionCandidates(
  optionChain: OptionChainWithVolumes,
  underlyingPrice: number,
  selectionOptions: OptionCandidateSelectionOptions = {},
) {
  const minDTE = selectionOptions.minDTE ?? MIN_DTE;
  const maxDTE = selectionOptions.maxDTE ?? MAX_DTE;
  const preferredDTE = selectionOptions.preferredDTE ?? 35;
  const expirations = optionChain.expirations
    .filter((exp) => {
      const dte = num(exp["days-to-expiration"]);
      return dte >= minDTE && dte <= maxDTE;
    })
    .sort((a, b) => {
      // Prefer regular monthly expirations, then closer to the preferred DTE.
      const aRegular = a["expiration-type"] === "Regular" ? 0 : 1;
      const bRegular = b["expiration-type"] === "Regular" ? 0 : 1;

      if (aRegular !== bRegular) return aRegular - bRegular;

      return (
        Math.abs(num(a["days-to-expiration"]) - preferredDTE) -
        Math.abs(num(b["days-to-expiration"]) - preferredDTE)
      );
    });

  if (!expirations.length) {
    console.warn(
      "No expirations found within DTE range for",
      optionChain["underlying-symbol"],
    );
    return [];
  }

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
